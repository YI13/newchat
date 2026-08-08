// The automatic-translation policy layer.
//
// It decides *whether* a message the user dwelled on should be translated.
// It does not translate anything itself: it hands the message to the same
// store action the Translate button uses, with `origin: 'auto'`. One request
// path, one queue, one cache — the policy only adds gates in front.
//
// Gate order is deliberate and cheapest-first, because a language-detection
// step is expected to land between dwell and the queue. Anything decidable
// from the message object alone runs before anything that costs a lookup.

import { DECISION, NOOP_DECISION_LOG } from './decisionLog'

// No scrollIdleMs here, deliberately: the "hold dwell until scrolling stops"
// refinement was cut from this iteration, and measurement showed dwell only
// filters ~3% at realistic scroll speeds — doing it for real means rethinking
// dwell itself, not adding a delay constant nothing reads. Its earlier
// presence as a declared-but-unwired knob is exactly the defect class the
// "every declared knob is wired" test now guards against.
export const AUTO_TRANSLATE_CONFIG = {
  dwellMs: 400,
  prefetchMarginPx: 0,
  maxConcurrent: 4,
  // Strictly below maxConcurrent so an explicit request always has somewhere
  // to run.
  maxConcurrentAuto: 2,
  // Safe only because recheckVisible re-offers what is still on screen. On
  // its own a ceiling strands whatever was visible when it bit: the observer
  // raises a candidate once per visibility transition, so a refused message
  // that does not move never gets a second chance. Measured on a scroll-then-
  // read, with the ceiling but without the sweep: 2 of the 12 messages on
  // screen were ever translated.
  maxQueueLength: 50,
  // How often idle-but-visible messages are re-offered. This is a repair
  // path, so a second of latency costs nothing; sweeping much faster would
  // just re-ask the same questions between settles.
  recheckIntervalMs: 1000,
  // A runaway guard, not a capacity control. Sustained reading sits around
  // 1-2 requests a minute; 60 is far above anything a human generates and far
  // below anything that would hurt the backend.
  maxRequestsPerMinute: 60,
  failureCircuitThreshold: 5,
  failureCircuitCooldownMs: 30_000,
  timeoutMs: 15_000,
  skipNonTextual: true,
}

export const SKIP = {
  AutoDisabled: 'auto-disabled',
  Inactive: 'inactive',
  UnknownMessage: 'unknown-message',
  OwnMessage: 'own-message',
  SystemMessage: 'system-message',
  NonTextual: 'non-textual',
  RateLimited: 'rate-limited',
  CircuitOpen: 'circuit-open',
  InternalError: 'internal-error',
}

const HAS_LETTER = /\p{L}/u
const RATE_WINDOW_MS = 60_000

function bodyOf(message) {
  return message?.content ?? message?.msg ?? ''
}

/**
 * The per-message gates, as an ordered list rather than an if-chain so a new
 * rule is an insertion rather than an edit. Local language detection belongs
 * at the end of this list: after dwell, before the queue. Placing it earlier
 * would run it for every message the user scrolls past, which is exactly the
 * cost dwell exists to avoid.
 */
export function createSkipRules(config) {
  return [
    (message) => (message ? null : SKIP.UnknownMessage),
    (message, ctx) =>
      message.sender?.account === ctx.currentUserAccount ? SKIP.OwnMessage : null,
    (message) => (message.sysMsgData != null ? SKIP.SystemMessage : null),
    (message) =>
      config.skipNonTextual && !HAS_LETTER.test(bodyOf(message)) ? SKIP.NonTextual : null,
  ]
}

export function createAutoPolicy({
  store,
  getMessage,
  getContext,
  getVisibleIds,
  config = {},
  log = NOOP_DECISION_LOG,
  now = () => Date.now(),
}) {
  const cfg = { ...AUTO_TRANSLATE_CONFIG, ...config }
  const rules = createSkipRules(cfg)

  let recentRequests = []
  let consecutiveFailures = 0
  let circuitOpenUntil = 0
  let circuitCooldownMs = cfg.failureCircuitCooldownMs
  let probing = false

  function circuitBlocks() {
    if (consecutiveFailures < cfg.failureCircuitThreshold) return false
    if (now() < circuitOpenUntil) return true
    // Cooldown elapsed: let exactly one request through to test the water.
    if (probing) return true
    probing = true
    return false
  }

  function rateLimited() {
    const cutoff = now() - RATE_WINDOW_MS
    recentRequests = recentRequests.filter((t) => t > cutoff)
    return recentRequests.length >= cfg.maxRequestsPerMinute
  }

  function recordSuccess() {
    consecutiveFailures = 0
    circuitOpenUntil = 0
    circuitCooldownMs = cfg.failureCircuitCooldownMs
    probing = false
  }

  function recordFailure(err) {
    probing = false
    // A rejected input is our bug, not an outage. Counting it would let one
    // malformed message switch the feature off for the whole session.
    if (err?.code === 'bad_request') return

    const wasOpen = consecutiveFailures >= cfg.failureCircuitThreshold
    consecutiveFailures += 1
    if (consecutiveFailures < cfg.failureCircuitThreshold) return

    if (wasOpen) {
      // A probe just failed — widen the window rather than retry at the same
      // cadence against a backend that is still down.
      circuitCooldownMs *= 2
    }
    circuitOpenUntil = now() + circuitCooldownMs
  }

  /**
   * Called once per message the user has dwelled on. Returns `{ skipped }`
   * with a reason, or the store's outcome. Automatic failures are silent by
   * design: the message simply stays in its source language.
   *
   * Never rejects. Both callers — the dwell timer and the sweep interval —
   * fire without a catch, so a rejection here (a broken IndexedDB rejecting
   * the first cache read, say) would surface as one unhandled rejection per
   * second, forever. An internal error becomes a logged skip and nothing
   * more: it says nothing about the backend, so it must not feed the
   * circuit breaker either.
   */
  async function onCandidate(messageId) {
    try {
      return await offerCandidate(messageId)
    } catch (err) {
      log.emit(DECISION.Skip, messageId, { reason: SKIP.InternalError, error: err })
      return { skipped: SKIP.InternalError }
    }
  }

  async function offerCandidate(messageId) {
    const skip = (reason, fields) => {
      log.emit(DECISION.Skip, messageId, { reason, ...fields })
      return { skipped: reason }
    }

    const ctx = getContext()
    if (!ctx.autoTranslate) return skip(SKIP.AutoDisabled)
    if (!ctx.active) return skip(SKIP.Inactive)

    const message = getMessage(messageId)
    for (const rule of rules) {
      const reason = rule(message, ctx)
      if (reason) return skip(reason)
    }

    if (circuitBlocks()) {
      return skip(SKIP.CircuitOpen, {
        failures: consecutiveFailures,
        reopensInMs: Math.max(0, circuitOpenUntil - now()),
      })
    }
    if (rateLimited()) return skip(SKIP.RateLimited, { inWindow: recentRequests.length })

    const result = await store.ensureForView(messageId, {
      roomId: ctx.roomId,
      text: bodyOf(message),
      targetLang: ctx.targetLang,
      srcVersion: message.editedAt ?? 0,
      autoTranslate: true,
    })

    // A cache hit or a suppressed message costs nothing, and charging for
    // them would throttle the cheapest paths hardest.
    if (result?.outcome !== 'queued') {
      probing = false
      return result ?? {}
    }

    try {
      // Charged when the request actually goes out, not when the candidate is
      // accepted. Most automatic candidates never reach the backend: they sit
      // in the queue until their message scrolls away and are dropped at pick
      // time. Charging at enqueue lets one brisk scroll spend the whole
      // minute's budget on requests that were never made, after which every
      // further candidate is silently rate-limited and automatic translation
      // stops for the rest of the window. Measured over a 100-message scroll
      // before this change: 60 accepted, 14 sent, 36 then rate-limited.
      if (!(await result.sent)) {
        // It never ran, so it is neither a probe result nor a data point for
        // the breaker.
        probing = false
        return result
      }
      recentRequests.push(now())

      // The store settles rather than throws: a failed translation is a UI
      // state, not an exception. Reading only the rejection path is how a
      // circuit breaker ends up never tripping — every job looks successful.
      const settled = await result.done
      if (settled?.ok === false && !settled.aborted && !settled.superseded) {
        recordFailure(settled.error)
      } else {
        recordSuccess()
      }
    } catch (err) {
      recordFailure(err)
    }
    return result
  }

  /**
   * Re-offer messages that are on screen and have nothing happening to them.
   *
   * The visibility observer raises a candidate once per visibility
   * transition. Anything that ends a job without translating it — a full
   * queue, a slot lost to a scroll that came back — leaves the message idle,
   * still on screen, and with nothing left to re-trigger it: it is not moving,
   * so no further intersection entry is ever delivered. Measured before this
   * existed: after scrolling and stopping, 10 of the 12 messages on screen
   * stayed in their source language indefinitely.
   *
   * Swept rather than driven by a "capacity freed" event, deliberately. The
   * failure being repaired is precisely that no event arrives; a repair that
   * itself waits for one inherits the same blind spot.
   *
   * Only `idle` is re-offered. `failed` is left alone or a body the backend
   * will always reject becomes an unbounded retry loop — and a bad_request
   * never trips the circuit breaker, so nothing else would stop it.
   */
  async function recheckVisible() {
    const ids = getVisibleIds?.()
    if (!ids) return

    // Checked here, silently, before any per-message work. The sweep fires
    // every second for as long as the page lives; while the switch is off or
    // the page is hidden, logging a skip per visible message per tick would
    // churn the decision log's whole buffer in minutes — evicting exactly
    // the history a diagnosis needs.
    const ctx = getContext()
    if (!ctx.autoTranslate || !ctx.active) return

    for (const id of ids) {
      if (store.getEntry(id).status !== 'idle') continue
      // Fire-and-forget: onCandidate resolves when the translation SETTLES,
      // so awaiting it here would repair one message per tick instead of one
      // sweep. Deduplication is the store's status check above, not this
      // loop's ordering — and onCandidate never rejects.
      onCandidate(id)
    }
  }

  return {
    config: cfg,
    onCandidate,
    recheckVisible,
    // The circuit governs background work only. Manual requests never reach
    // this module; the flag keeps that a stated contract.
    gatesManualRequests: false,
    stats: () => ({
      consecutiveFailures,
      circuitOpen: consecutiveFailures >= cfg.failureCircuitThreshold,
      circuitOpenUntil,
      requestsInWindow: recentRequests.length,
    }),
  }
}
