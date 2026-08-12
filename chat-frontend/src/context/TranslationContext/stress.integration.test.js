import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTranslationCache } from '@/lib/idbTranslationCache'
import { createAutoPolicy } from './autoPolicy'
import { DECISION, createDecisionLog } from './decisionLog'
import { checkInvariants } from './invariants'
import { createTranslationStore } from './store'
import { createVisibilityObserver } from './visibilityObserver'

// Chaos harness: a seeded random event stream — visibility churn, edits,
// reverts, manual clicks, a backend flipping between healthy, failing and
// silent, and sweep ticks — driven through the real three-module assembly,
// with every queue invariant checked after every single step.
//
// The scenario tests each pin one interleaving somebody thought of. This one
// exists for the interleavings nobody thought of: with a fixed seed a failure
// replays deterministically, so a red run here is a reproducible bug report,
// not flake.
//
// Timers are real (fake-indexeddb deadlocks under a frozen clock); all delays
// are single-digit milliseconds to keep the whole file under a few seconds.

const TOTAL = 24
const STEPS = 220
const SEEDS = [11, 47, 83]

const DWELL_MS = 6
const TIMEOUT_MS = 60

/** mulberry32 — tiny, deterministic, good enough for event selection. */
function mulberry32(seed) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ios = []

class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback
    ios.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const io = () => ios[ios.length - 1]

let caches = []

function build(rand) {
  const cache = createTranslationCache({
    dbName: `stress-${Math.random().toString(36).slice(2)}`,
  })
  caches.push(cache)

  const messages = Array.from({ length: TOTAL }, (_, i) => ({
    id: `m${i}`,
    content: `line ${i}`,
    sender: { account: 'bob' },
    editedAt: 0,
  }))
  const registry = new Map(messages.map((m) => [m.id, m]))
  const log = createDecisionLog({ cap: 100_000 })
  let policy = null

  // 'ok' resolves after a short latency, 'fail' rejects, 'silent' never
  // settles — the store's timeout is what reclaims those slots.
  const backend = { mode: 'ok' }
  const translate = vi.fn(async (_n, { text, targetLang }) => {
    if (backend.mode === 'silent') return new Promise(() => {})
    await sleep(4 + Math.floor(rand() * 8))
    if (backend.mode === 'fail') {
      throw Object.assign(new Error('boom'), { code: 'internal' })
    }
    return { translatedText: `[${targetLang}] ${text}`, targetLang }
  })

  const observer = createVisibilityObserver({
    dwellMs: DWELL_MS,
    prefetchMarginPx: 0,
    log,
    onCandidate: (id) => policy.onCandidate(id),
  })

  const store = createTranslationStore({
    nats: { user: { account: 'alice', siteId: 'site-local' } },
    translate,
    cache,
    log,
    config: {
      maxConcurrent: 4,
      maxConcurrentAuto: 2,
      timeoutMs: TIMEOUT_MS,
      // Small on purpose: refusals must actually happen for the sweep's
      // repair path to be exercised.
      maxQueueLength: 3,
      isAutoEligible: (id) => observer.visibleIds.has(id),
      orderAutoQueue: (ids) => observer.byDistanceFromCentre(ids),
    },
  })

  policy = createAutoPolicy({
    store,
    log,
    getVisibleIds: () => observer.visibleIds,
    getMessage: (id) => registry.get(id),
    getContext: () => ({
      roomId: 'r1',
      targetLang: 'ja',
      autoTranslate: true,
      currentUserAccount: 'alice',
      active: true,
    }),
    config: {
      maxRequestsPerMinute: 10_000,
      failureCircuitThreshold: 4,
      failureCircuitCooldownMs: 40,
    },
  })

  const elements = new Map()
  for (const m of messages) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    elements.set(m.id, el)
    observer.observe(m.id, el)
  }

  const snapshot = () => ({
    ...store.inspect(),
    visibleIds: [...observer.visibleIds],
    registeredIds: observer.registeredIds(),
  })

  return { cache, store, policy, observer, elements, log, registry, backend, translate, snapshot }
}

beforeEach(() => {
  ios = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const cache of caches) await cache.destroy()
  caches = []
  document.body.innerHTML = ''
})

describe.each(SEEDS)('randomized interleavings, seed %i', (seed) => {
  test('every step preserves the queue invariants and the run converges', async () => {
    const rand = mulberry32(seed)
    const h = build(rand)
    const pick = (arr) => arr[Math.floor(rand() * arr.length)]
    const id = () => `m${Math.floor(rand() * TOTAL)}`

    const visible = new Set()
    const show = (mid) => {
      if (visible.has(mid)) return
      visible.add(mid)
      io().callback(
        [
          {
            target: h.elements.get(mid),
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: { top: rand() * 600, height: 30, bottom: 30 },
          },
        ],
        io(),
      )
    }
    const hide = (mid) => {
      if (!visible.delete(mid)) return
      io().callback(
        [
          {
            target: h.elements.get(mid),
            isIntersecting: false,
            intersectionRatio: 0,
            boundingClientRect: { top: 0, height: 30, bottom: 30 },
          },
        ],
        io(),
      )
    }

    // The user's explicit choices, tracked so the convergence assertion can
    // honour them: a reverted message must stay untranslated.
    const reverted = new Set()

    const allViolations = []
    const check = (step, op) => {
      const violations = checkInvariants(h.snapshot(), { stallMs: 10_000 })
      for (const v of violations) allViolations.push({ step, op, ...v })
    }

    for (let step = 0; step < STEPS; step += 1) {
      const op = pick([
        'show', 'show', 'show',
        'hide', 'hide',
        'sweep', 'sweep',
        'edit',
        'manual',
        'revert',
        'flip',
        'wait',
      ])

      switch (op) {
        case 'show':
          show(id())
          break
        case 'hide':
          hide(id())
          break
        case 'sweep':
          h.policy.recheckVisible()
          break
        case 'edit': {
          const mid = id()
          h.registry.get(mid).editedAt += 1
          await h.store.onMessageEdited(mid)
          break
        }
        case 'manual': {
          const mid = id()
          reverted.delete(mid)
          h.store.translate(mid, {
            roomId: 'r1',
            text: h.registry.get(mid).content,
            targetLang: 'ja',
            srcVersion: h.registry.get(mid).editedAt,
            origin: 'manual',
          })
          break
        }
        case 'revert': {
          const mid = id()
          reverted.add(mid)
          await h.store.revert(mid, 'r1')
          break
        }
        case 'flip':
          h.backend.mode = pick(['ok', 'ok', 'fail', 'silent'])
          break
        case 'wait':
          await sleep(1 + Math.floor(rand() * 8))
          break
      }

      check(step, op)
    }

    expect(allViolations).toEqual([])

    // ---- convergence: heal the backend and let the repair paths finish.
    //
    // The sweep re-offers only `idle` — a message that FAILED during the
    // outage retries when it leaves and re-enters the viewport, by design.
    // Model that the way a reader produces it: scroll away, scroll back.
    h.backend.mode = 'ok'
    const onScreen = [...visible]
    for (let i = 0; i < 150; i += 1) {
      // Periodic leave-and-return, because one is not always enough: a
      // re-entry candidate that lands while the failure circuit is still in
      // an accumulated-backoff cooldown is skipped, the message stays
      // 'failed', and the sweep will not touch it — only the NEXT re-entry
      // retries. A reader scrolling around produces exactly this.
      if (i % 20 === 0) {
        for (const mid of onScreen) hide(mid)
        await sleep(DWELL_MS + 5)
        for (const mid of onScreen) show(mid)
      }
      h.policy.recheckVisible()
      await sleep(10)
      const snap = h.snapshot()
      const settledDown = snap.activeCount === 0 && snap.queue.length === 0
      const done = [...visible].every((mid) => {
        const status = h.store.getEntry(mid).status
        if (reverted.has(mid)) return status !== 'translated'
        return status === 'translated'
      })
      if (settledDown && done) break
    }

    const finalSnap = h.snapshot()
    expect(checkInvariants(finalSnap, { stallMs: 10_000 })).toEqual([])
    expect(finalSnap.activeCount).toBe(0)
    expect(finalSnap.queue).toHaveLength(0)

    for (const mid of visible) {
      const status = h.store.getEntry(mid).status
      if (reverted.has(mid)) {
        // "See original" is the user's explicit word; no amount of sweeping
        // may override it.
        expect(status, `${mid} was reverted`).not.toBe('translated')
      } else {
        expect(status, `${mid} is visible and unreverted`).toBe('translated')
      }
    }

    // Ledger consistency: every request that went out came back, one way or
    // another, and the log agrees with itself.
    const records = h.log.records()
    const sends = records.filter((r) => r.kind === DECISION.Send).length
    const settles = records.filter((r) => r.kind === DECISION.Settle).length
    expect(settles).toBe(sends)
  }, 30_000)
})
