// Translation store: per-message display state plus the request queue.
//
// Two invariants carry most of the weight here.
//
// 1. Every state-resetting action bumps a generation counter and stamps it on
//    the message's entry. A reply may only win if its generation still
//    matches. Late replies are therefore structurally unable to overwrite
//    newer state, rather than relying on an abort landing in time.
//
// 2. The queue is the only thing that decides what runs. Callers enqueue and
//    receive a promise; they never start a request themselves. Concurrency,
//    ordering and the automatic-translation sub-gate are all changeable in
//    one place.

import { DECISION, NOOP_DECISION_LOG } from './decisionLog'

export const IDLE_ENTRY = Object.freeze({ status: 'idle', reqSeq: 0 })

/**
 * Work already under way for a message.
 *
 *   queued  — accepted, waiting for a concurrency slot. Nothing has been sent
 *             and nothing may ever be: an automatic job whose message leaves
 *             the viewport is dropped at pick time.
 *   loading — the request is on the wire.
 *
 * Both count as "in progress" for deduplication and for deciding whether a
 * freshly mounted message still needs anything done.
 */
export const IN_PROGRESS = new Set(['queued', 'loading'])

const DEFAULT_CONFIG = {
  maxConcurrent: 4,
  // Strictly below maxConcurrent, so a message the user explicitly asked for
  // never queues behind background work. This is the single most important
  // number here.
  maxConcurrentAuto: 2,
  // Automatic jobs are re-checked at pick time, not at enqueue time: a
  // message can leave the viewport while it waits, and translating it then is
  // pure waste. Manual jobs bypass this — the user asked.
  isAutoEligible: () => true,
  // Lets the caller rank the waiting automatic jobs (by distance from the
  // centre of the viewport). Read at pick time so scrolling never has to
  // reorder a queue.
  orderAutoQueue: (ids) => ids,
  // Under request/reply a lost reply produces no rejection: the promise
  // simply never settles. Without this the slot is held forever, and two of
  // them exhaust maxConcurrentAuto and end automatic translation for the
  // session — with no error anywhere to show for it. 0 disables.
  timeoutMs: 15_000,
  // A bound on background work only, so a fast scroll through a long room
  // cannot grow the queue without limit. Off by default: refusing a job is
  // only safe when something re-offers it later, and that is the caller's
  // responsibility, not the queue's. See AUTO_TRANSLATE_CONFIG.
  maxQueueLength: 0,
}

function isAbort(err) {
  return err?.name === 'AbortError'
}

function timeoutError(ms) {
  const err = new Error(`translate timed out after ${ms}ms`)
  err.name = 'TimeoutError'
  // Counts against the automatic circuit breaker: a backend that stops
  // replying is exactly the outage the breaker exists for.
  err.code = 'timeout'
  return err
}

export function createTranslationStore({
  nats,
  translate,
  cache,
  config = {},
  log = NOOP_DECISION_LOG,
  now = () => Date.now(),
}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  const entries = new Map()
  const listeners = new Set()
  const inflight = new Map()
  /** One record per job currently HOLDING a slot — see runJob. */
  const running = new Set()
  const queue = []
  let activeCount = 0
  let activeAutoCount = 0
  let generation = 0

  function getEntry(messageId) {
    return entries.get(messageId) ?? IDLE_ENTRY
  }

  function emit() {
    for (const listener of listeners) listener()
  }

  function setEntry(messageId, next) {
    // `since` stamps when the *status* last changed, not when the entry was
    // last touched. A row that has read "queued" for forty seconds is the
    // thing worth seeing, and that is unanswerable without this.
    const previous = entries.get(messageId)
    const since = previous && previous.status === next.status ? previous.since : now()
    entries.set(messageId, { ...next, since })
    emit()
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** Cancel any in-flight request for this message and invalidate its
   *  generation, so a reply already on the wire can no longer be applied.
   *
   *  Also purges the message's QUEUED job, which has no controller to abort:
   *  left in place it would eventually send a request whose reply is
   *  unusable — for a reverted message, one the user explicitly declined —
   *  and its 'superseded' settle would read as a success to the policy's
   *  failure accounting. (Found by the chaos harness: reverting a queued
   *  message left a ghost job that still reached the wire.) */
  function invalidate(messageId) {
    const current = inflight.get(messageId)
    if (current) {
      inflight.delete(messageId)
      current.controller.abort()
    }
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].messageId !== messageId) continue
      const [item] = queue.splice(i, 1)
      log.emit(DECISION.Drop, messageId, {
        reason: 'superseded',
        origin: item.origin,
        queued: queue.length,
      })
      item.markSent(false)
      item.settle({ ok: false, superseded: true })
    }
    generation += 1
    return generation
  }

  /** Take the next job that is allowed to run right now, dropping automatic
   *  jobs whose message has since left the viewport. Returns null when
   *  nothing is currently runnable — a full sub-gate is not the same as an
   *  empty queue. */
  function takeNext() {
    const manualIndex = queue.findIndex((item) => item.origin !== 'auto')
    if (manualIndex !== -1) return queue.splice(manualIndex, 1)[0]

    if (activeAutoCount >= cfg.maxConcurrentAuto) return null

    const autoItems = queue.filter((item) => item.origin === 'auto')
    if (autoItems.length === 0) return null

    const byId = new Map(autoItems.map((item) => [item.messageId, item]))
    const ordered = cfg.orderAutoQueue([...byId.keys()])

    for (const id of ordered) {
      const item = byId.get(id)
      if (!item) continue
      queue.splice(queue.indexOf(item), 1)
      if (cfg.isAutoEligible(id)) return item
      // Dropped, not run: release the entry so a later view can retry it.
      if (getEntry(id).reqSeq === item.reqSeq) {
        setEntry(id, { status: 'idle', reqSeq: item.reqSeq })
      }
      log.emit(DECISION.Drop, id, {
        reason: 'left-viewport',
        waitedMs: now() - item.enqueuedAt,
        queued: queue.length,
      })
      item.markSent(false)
      item.settle()
    }
    return null
  }

  /** An explicit request is never refused. The ceiling exists to stop
   *  background work growing without bound while the user scrolls; a click is
   *  not background work, and a queue length must never be the reason a
   *  button does nothing. */
  function hasQueueRoom(origin) {
    if (origin !== 'auto') return true
    if (!cfg.maxQueueLength) return true
    return queue.length < cfg.maxQueueLength
  }

  function refuse(messageId) {
    log.emit(DECISION.Drop, messageId, {
      reason: 'queue-full',
      queued: queue.length,
      max: cfg.maxQueueLength,
    })
    return { ok: false, dropped: true }
  }

  function pump() {
    while (activeCount < cfg.maxConcurrent && queue.length > 0) {
      const item = takeNext()
      if (!item) return
      runJob(item)
    }
  }

  async function runJob(item) {
    const isAuto = item.origin === 'auto'
    activeCount += 1
    if (isAuto) activeAutoCount += 1
    const controller = new AbortController()
    const sentAt = now()
    // The slot ledger, per JOB. The inflight map cannot serve this purpose:
    // it is keyed by messageId, and during a supersede two requests for the
    // same message are genuinely outstanding at once — the aborted-but-alive
    // old one (the transport cannot cancel mid-flight) and the new one. A
    // per-message map undercounts that, which made the slot-leak invariant
    // fire on every supersede window. This record lives exactly as long as
    // the slot: added here, removed in release().
    const slotRecord = { messageId: item.messageId, origin: item.origin, sentAt }
    running.add(slotRecord)
    inflight.set(item.messageId, {
      controller,
      reqSeq: item.reqSeq,
      sentAt,
      origin: item.origin,
      release: () => release(),
    })

    // The slot models an outstanding *request*, so it is given back the
    // moment the wire is free — not after the result has been persisted.
    // Holding it across the IndexedDB write would idle the queue for a
    // database round trip on every single translation.
    let released = false
    const release = () => {
      if (released) return
      released = true
      activeCount -= 1
      if (isAuto) activeAutoCount -= 1
      running.delete(slotRecord)
      pump()
    }

    // Default covers the early returns taken when a newer generation has
    // already superseded this job: not a failure, just no longer ours.
    let outcome = { ok: false, superseded: true }

    // The slot is ours and the request is about to go out: this is the point
    // where 'loading' becomes true.
    if (getEntry(item.messageId).reqSeq === item.reqSeq) {
      setEntry(item.messageId, { ...getEntry(item.messageId), status: 'loading' })
    }

    // The one point at which a queued candidate becomes a real request. Rate
    // accounting hangs off this rather than off the enqueue: most automatic
    // candidates never get here.
    item.markSent(true)
    log.emit(DECISION.Send, item.messageId, {
      origin: item.origin,
      targetLang: item.targetLang,
      // How long the job sat in the queue. The gap between this and the
      // round-trip time is what tells a saturated gate apart from a slow
      // backend.
      waitedMs: sentAt - item.enqueuedAt,
      active: `${activeCount}/${cfg.maxConcurrent}`,
      auto: `${activeAutoCount}/${cfg.maxConcurrentAuto}`,
    })

    // A request that never replies would otherwise hold its slot forever.
    // The timer is the only thing that can end such a job: there is no
    // rejection to catch and nothing else to wait on.
    let timeoutTimer = null
    let timedOut = false
    const withTimeout = (promise) => {
      if (!cfg.timeoutMs) return promise
      return new Promise((resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          timedOut = true
          // Reject BEFORE aborting. Aborting can make the transport reject
          // synchronously, and an AbortError winning this race would be
          // classified as somebody else's cancellation — exempt from failure
          // accounting — rather than as the outage it actually is.
          reject(timeoutError(cfg.timeoutMs))
          controller.abort()
        }, cfg.timeoutMs)
        promise.then(resolve, reject)
      })
    }

    try {
      const result = await withTimeout(
        translate(
          nats,
          { text: item.text, targetLang: item.targetLang },
          // One attempt on the automatic path: its circuit breaker already
          // owns backoff, and a transport-level ladder underneath would spend
          // three requests per job against a backend that is already failing,
          // holding one of two auto slots for the length of the ladder. A
          // manual request has nothing watching it, so it keeps the default.
          { signal: controller.signal, ...(isAuto ? { maxAttempts: 1 } : {}) },
        ),
      )
      release()

      if (getEntry(item.messageId).reqSeq !== item.reqSeq) return

      const identical = result.translatedText === item.text

      // Settled before the write, not after. The translation succeeded the
      // moment the backend replied; persisting it is a local convenience. A
      // full quota, a private-mode database, a corrupt store — each would
      // otherwise throw here and be caught below as a failed translation:
      // the text is discarded, the message shows an error, and the automatic
      // circuit breaker counts a backend that never misbehaved. Five of those
      // and automatic translation switches itself off. Same rule the policy
      // layer applies to its own internal errors — a local fault says nothing
      // about the backend.
      outcome = { ok: true }
      try {
        await cache.content.set({
          messageId: item.messageId,
          roomId: item.roomId,
          targetLang: item.targetLang,
          srcVersion: item.srcVersion,
          translatedText: result.translatedText,
          originalText: item.text,
        })
      } catch (err) {
        // Kept in memory and rendered; it simply has to be fetched again next
        // time this message comes into view.
        log.emit(DECISION.Violation, item.messageId, {
          reason: 'cache-write-failed',
          error: err,
        })
      }
      if (getEntry(item.messageId).reqSeq !== item.reqSeq) return
      setEntry(item.messageId, {
        status: 'translated',
        targetLang: item.targetLang,
        translatedText: identical ? item.text : result.translatedText,
        identical,
        srcVersion: item.srcVersion,
        reqSeq: item.reqSeq,
      })
    } catch (err) {
      release()
      // An abort is somebody else's decision that already reset this entry.
      // Reporting it as a failure would show an error for a state the user
      // deliberately moved away from — and would count against the automatic
      // circuit breaker for something that was not an outage.
      if (isAbort(err) && !timedOut) {
        outcome = { ok: false, aborted: true, error: err }
        return
      }
      outcome = { ok: false, error: err }
      if (getEntry(item.messageId).reqSeq !== item.reqSeq) return
      setEntry(item.messageId, {
        ...getEntry(item.messageId),
        status: 'failed',
        error: err,
      })
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      release()
      if (inflight.get(item.messageId)?.reqSeq === item.reqSeq) {
        inflight.delete(item.messageId)
      }
      log.emit(DECISION.Settle, item.messageId, {
        origin: item.origin,
        ok: outcome.ok,
        aborted: outcome.aborted,
        superseded: outcome.superseded,
        error: outcome.error,
        tookMs: now() - sentAt,
      })
      // Resolved, never rejected: a failed translation is a UI state, not an
      // exception for the caller to catch. The descriptor is how a policy
      // layer learns the outcome without the store having to throw.
      item.settle(outcome)
    }
  }

  /**
   * Queue a translation. `origin` is an explicit parameter rather than
   * something derived from stored intent: the queue classifies jobs
   * synchronously, while intent lives behind an async read whose write races
   * the very click that caused it.
   */
  function translateMessage(
    messageId,
    { roomId, text, targetLang, srcVersion, origin = 'manual', onSent },
  ) {
    const current = getEntry(messageId)
    const alreadyRunning =
      IN_PROGRESS.has(current.status) &&
      current.targetLang === targetLang &&
      current.srcVersion === srcVersion
    if (alreadyRunning) {
      log.emit(DECISION.Deduped, messageId, { origin, status: current.status })
      // Symmetrical with the refusal below, and for a harder reason:
      // ensureForView reports 'queued' for every call that reaches this
      // function, so the `sent` promise it hands back has to settle on every
      // path out of it. A caller that awaits `sent` — the policy layer does,
      // to decide whether to charge its rate budget — would otherwise wait
      // forever, holding the probe token with it.
      onSent?.(false)
      return Promise.resolve({ ok: true, deduped: true })
    }

    // Refused before the entry is touched, so the message stays idle rather
    // than showing an error for a request that was never attempted — a later
    // view can simply try again.
    if (!hasQueueRoom(origin)) {
      onSent?.(false)
      return Promise.resolve(refuse(messageId))
    }

    const reqSeq = invalidate(messageId)

    // 'queued', not 'loading'. The job may sit here behind the concurrency
    // gate, and may never be sent at all if its message scrolls away first.
    // Calling that "loading" makes a saturated queue look exactly like a slow
    // backend — the one distinction worth being able to see.
    setEntry(messageId, {
      status: 'queued',
      targetLang,
      srcVersion,
      reqSeq,
    })

    // Automatic translation never records intent. "No intent + switch on" IS
    // the auto state, which is what makes switching auto off fall straight
    // back to the source text with no restore pass.
    //
    // The write runs alongside the request, not before it: the two are
    // independent, and gating the queue on a database round-trip would add
    // that latency to every single translation the user asks for.
    const intentWrite =
      origin === 'manual'
        ? cache.intent.set(messageId, roomId, 'manual')
        : Promise.resolve()

    let settle
    const jobDone = new Promise((resolve) => {
      settle = resolve
    })

    queue.push({
      // Called with true the moment the request goes on the wire, false if
      // the job is dropped first. Separate from `settle` because the two
      // answer different questions: "did this reach the backend" governs rate
      // accounting, "how did it end" governs the circuit breaker.
      markSent: onSent ?? (() => {}),
      messageId,
      roomId,
      text,
      targetLang,
      srcVersion,
      origin,
      reqSeq,
      enqueuedAt: now(),
      settle,
    })
    log.emit(DECISION.Enqueue, messageId, {
      origin,
      targetLang,
      queued: queue.length,
      active: `${activeCount}/${cfg.maxConcurrent}`,
      auto: `${activeAutoCount}/${cfg.maxConcurrentAuto}`,
    })
    pump()

    return Promise.all([jobDone, intentWrite]).then(([result]) => result)
  }

  /**
   * Decide what a freshly mounted message shows, in the one order that keeps
   * intent authoritative:
   *   intent 'off'    -> source text, no request
   *   intent 'manual' -> translate regardless of the global switch
   *   no intent       -> translate only while the switch is on
   */
  async function ensureForView(
    messageId,
    { roomId, text, targetLang, srcVersion, autoTranslate },
  ) {
    const current = getEntry(messageId)
    const settledForThisView =
      current.targetLang === targetLang &&
      current.srcVersion === srcVersion &&
      (IN_PROGRESS.has(current.status) || current.status === 'translated')
    if (settledForThisView) return { outcome: 'settled' }

    // This function is not atomic: between here and the enqueue sit two
    // cache reads, and a revert or an edit can land inside that window. The
    // sequence captured now is re-checked before the enqueue — losing that
    // race must mean standing down, or the enqueue takes a fresh generation
    // and translates a message whose user just said "see original".
    const seqAtStart = current.reqSeq

    const intent = await cache.intent.get(messageId)
    if (intent === 'off') {
      log.emit(DECISION.Suppressed, messageId, { reason: 'see-original' })
      return { outcome: 'suppressed' }
    }

    const wanted = intent === 'manual' || autoTranslate
    if (!wanted) {
      log.emit(DECISION.Suppressed, messageId, { reason: 'auto-off-no-intent' })
      return { outcome: 'suppressed' }
    }

    const cached = await cache.content.get(messageId, { targetLang, srcVersion })

    // The atomicity re-check, placed BEFORE the cached branch: a cache hit
    // writes 'translated' into the entry, which would overwrite a revert
    // just as surely as a fresh request would. A moved sequence means
    // somebody — a revert, an edit, another request — changed this message's
    // state while the reads above were in flight; their decision is newer.
    if (getEntry(messageId).reqSeq !== seqAtStart) {
      return { outcome: 'superseded', sent: Promise.resolve(false) }
    }

    if (cached) {
      setEntry(messageId, {
        status: 'translated',
        targetLang,
        translatedText: cached.identical ? text : cached.translatedText,
        identical: cached.identical,
        srcVersion,
        reqSeq: getEntry(messageId).reqSeq,
      })
      log.emit(DECISION.Cached, messageId, { targetLang, identical: cached.identical })
      return { outcome: 'cached' }
    }

    const origin = intent === 'manual' ? 'manual' : 'auto'

    // Reported as its own outcome rather than as a queued job that fails: the
    // policy layer charges its rate budget and its circuit breaker on
    // 'queued' alone, and neither should move for a request never made.
    if (!hasQueueRoom(origin)) {
      refuse(messageId)
      return { outcome: 'dropped', sent: Promise.resolve(false) }
    }

    let markSent
    const sent = new Promise((resolve) => {
      markSent = resolve
    })

    // Enqueue and return the job promise without awaiting it. A view hook
    // must not stay suspended for the whole round trip — the entry it renders
    // from is already 'loading'. Both promises are handed back so a policy
    // layer can charge its rate budget on `sent` and its circuit breaker on
    // `done`.
    const done = translateMessage(messageId, {
      roomId,
      text,
      targetLang,
      srcVersion,
      origin,
      onSent: markSent,
    })
    return { outcome: 'queued', done, sent }
  }

  /** "See original". Writes 'off' whatever the current mode — one rule, no
   *  mode dependence — so the choice survives an LRU eviction of the text. */
  async function revert(messageId, roomId) {
    const reqSeq = invalidate(messageId)
    setEntry(messageId, { status: 'idle', reqSeq })
    await cache.intent.set(messageId, roomId, 'off')
  }

  /** A new revision invalidates the text, never the intent. Writing 'off'
   *  here is what would make an edited message opt out of automatic
   *  translation permanently. */
  async function onMessageEdited(messageId) {
    const reqSeq = invalidate(messageId)
    setEntry(messageId, { status: 'idle', reqSeq })
    await cache.content.clear(messageId)
  }

  async function onMessagesDeleted(messageIds) {
    for (const id of messageIds) {
      invalidate(id)
      entries.delete(id)
    }
    emit()
    await cache.clearMessages(messageIds)
  }

  async function onRoomLeft(roomId) {
    await cache.clearRoom(roomId)
  }

  async function onLogout() {
    for (const id of [...inflight.keys()]) invalidate(id)
    // Same defect class as the invalidate purge: truncating the queue
    // without settling its jobs leaves their promises pending forever, and a
    // policy awaiting `sent` on one of them never learns the answer.
    for (const item of queue.splice(0)) {
      item.markSent(false)
      item.settle({ ok: false, superseded: true })
    }
    entries.clear()
    emit()
    await cache.clearAll()
  }

  /**
   * Give back the concurrency slot for a request that is still on the wire.
   *
   * Used when a message scrolls away or the user changes room: the reply is
   * already paid for server-side, and under request/reply an abort has
   * nowhere to deliver it. Cancelling would waste the work AND lose the
   * result; holding the slot would idle the queue behind a message nobody is
   * looking at. So: release the budget, keep the request.
   */
  function detach(messageId) {
    inflight.get(messageId)?.release()
  }

  return {
    config: cfg,
    getEntry,
    subscribe,
    translate: translateMessage,
    ensureForView,
    revert,
    detach,
    onMessageEdited,
    onMessagesDeleted,
    onRoomLeft,
    onLogout,
    stats: () => ({ activeCount, activeAutoCount, queued: queue.length }),
    /**
     * A copy of everything the invariant checks need. Deliberately separate
     * from stats(): stats() is three numbers for a display, this is the
     * internal state the queue is asserted against, and neither should have
     * to grow into the other.
     */
    inspect: () => ({
      config: cfg,
      activeCount,
      activeAutoCount,
      queue: queue.map(({ messageId, origin, enqueuedAt }) => ({
        messageId,
        origin,
        enqueuedAt,
      })),
      // From the slot ledger, not the inflight map: this is what the
      // slot-leak invariant compares activeCount against, and the two are
      // mutated together synchronously.
      inflight: [...running].map((job) => ({
        messageId: job.messageId,
        origin: job.origin,
        sentAt: job.sentAt,
      })),
      entries: [...entries.entries()].map(([messageId, entry]) => ({
        messageId,
        status: entry.status,
        since: entry.since,
      })),
    }),
  }
}
