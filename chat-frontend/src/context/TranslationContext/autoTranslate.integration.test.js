import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTranslationCache } from '@/lib/idbTranslationCache'
import { AUTO_TRANSLATE_CONFIG, createAutoPolicy } from './autoPolicy'
import { DECISION, createDecisionLog } from './decisionLog'
import { INVARIANT, checkInvariants } from './invariants'
import { createTranslationStore } from './store'
import { createVisibilityObserver } from './visibilityObserver'

// The three modules assembled exactly the way TranslationProvider assembles
// them. Their unit tests each mock the neighbours; this one does not, so a
// mistake in the seams — the order they are built in, which object owns which
// gate, what the policy hands the store — shows up here and nowhere else.
//
// Real timers on purpose. fake-indexeddb schedules its own work on the real
// task queue, so a frozen clock deadlocks the cache instead of speeding the
// test up. The dwell window is shrunk to 20ms instead.

const DWELL_MS = 20

let ios = []

class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback
    this.options = options ?? {}
    this.observed = new Set()
    ios.push(this)
  }
  observe(el) {
    this.observed.add(el)
  }
  unobserve(el) {
    this.observed.delete(el)
  }
  disconnect() {
    this.observed.clear()
  }
  emit(entries) {
    this.callback(
      entries.map(({ target, isIntersecting, top = 0, height = 20 }) => ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: { top, height, bottom: top + height },
      })),
      this,
    )
  }
}

const io = () => ios[ios.length - 1]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let caches = []

function build({ messages, translate, context = {}, config = {} } = {}) {
  const cache = createTranslationCache({
    dbName: `auto-int-${caches.length}-${Math.random().toString(36).slice(2)}`,
  })
  caches.push(cache)

  const registry = new Map(messages.map((m) => [m.id, m]))
  let policy = null

  // One log across all three, exactly as the provider wires it.
  const log = createDecisionLog()

  const observer = createVisibilityObserver({
    dwellMs: DWELL_MS,
    prefetchMarginPx: AUTO_TRANSLATE_CONFIG.prefetchMarginPx,
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
      isAutoEligible: (id) => observer.visibleIds.has(id),
      orderAutoQueue: (ids) => observer.byDistanceFromCentre(ids),
      ...config,
    },
  })

  policy = createAutoPolicy({
    store,
    log,
    getMessage: (id) => registry.get(id),
    getContext: () => ({
      roomId: 'r1',
      targetLang: 'ja',
      autoTranslate: true,
      currentUserAccount: 'alice',
      active: true,
      ...context,
    }),
  })

  const elements = new Map()
  for (const m of messages) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    elements.set(m.id, el)
    observer.observe(m.id, el)
  }

  return { cache, store, policy, observer, elements, log }
}

/** Everything the invariant checks need, assembled the way the provider
 *  assembles it. */
const inspect = ({ store, observer }) => ({
  ...store.inspect(),
  visibleIds: [...observer.visibleIds],
  registeredIds: observer.registeredIds(),
})

function msg(id, content, account = 'bob') {
  return { id, content, sender: { account }, editedAt: 0 }
}

function okTranslate(delayMs = 0) {
  return vi.fn(async (_nats, { text, targetLang }) => {
    if (delayMs) await sleep(delayMs)
    return { translatedText: `[${targetLang}] ${text}`, targetLang }
  })
}

const show = (elements, ids, base = 0) =>
  io().emit(
    ids.map((id, i) => ({
      target: elements.get(id),
      isIntersecting: true,
      top: base + i * 30,
    })),
  )

const hide = (elements, ids) =>
  io().emit(ids.map((id) => ({ target: elements.get(id), isIntersecting: false })))

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

describe('scrolling a message into view', () => {
  test('translates it after the dwell window, end to end', async () => {
    const translate = okTranslate()
    const { store, elements } = build({ messages: [msg('m1', '早安')], translate })

    show(elements, ['m1'])
    await sleep(DWELL_MS + 60)

    expect(translate).toHaveBeenCalledTimes(1)
    expect(store.getEntry('m1').translatedText).toBe('[ja] 早安')
  })

  test('scrolling past faster than the dwell window costs nothing', async () => {
    const translate = okTranslate()
    const { elements } = build({ messages: [msg('m1', '早安')], translate })

    show(elements, ['m1'])
    await sleep(DWELL_MS / 2)
    hide(elements, ['m1'])
    await sleep(DWELL_MS + 60)

    expect(translate).not.toHaveBeenCalled()
  })

  test('never records intent, so turning the switch off restores the source', async () => {
    const translate = okTranslate()
    const { cache, elements } = build({ messages: [msg('m1', '早安')], translate })

    show(elements, ['m1'])
    await sleep(DWELL_MS + 60)

    // The whole "switch off -> instantly back to source" property rests on
    // this: automatic translation writes content but never intent.
    expect(await cache.intent.get('m1')).toBeUndefined()
    expect(await cache.content.peek('m1')).toBeDefined()
  })

  test('a message the user marked "see original" stays untranslated', async () => {
    const translate = okTranslate()
    const { cache, elements } = build({ messages: [msg('m1', '早安')], translate })
    await cache.intent.set('m1', 'r1', 'off')

    show(elements, ['m1'])
    await sleep(DWELL_MS + 60)

    expect(translate).not.toHaveBeenCalled()
  })

  test('your own messages are never sent', async () => {
    const translate = okTranslate()
    const { elements } = build({ messages: [msg('m1', 'my own words', 'alice')], translate })

    show(elements, ['m1'])
    await sleep(DWELL_MS + 60)

    expect(translate).not.toHaveBeenCalled()
  })
})

describe('a screenful of messages', () => {
  const many = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, `line ${i}`))
  const ids = many.map((m) => m.id)

  test('respects the automatic sub-gate while they all dwell at once', async () => {
    let inFlight = 0
    let peak = 0
    const translate = vi.fn(async (_nats, { text, targetLang }) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await sleep(15)
      inFlight -= 1
      return { translatedText: `[${targetLang}] ${text}`, targetLang }
    })

    const { elements } = build({ messages: many, translate })

    show(elements, ids)
    await sleep(DWELL_MS + 400)

    expect(peak).toBeLessThanOrEqual(2)
    expect(translate.mock.calls.length).toBeGreaterThan(2)
  })

  test('a message that scrolls away before its turn is never requested', async () => {
    const translate = okTranslate(40)
    const { elements, observer } = build({ messages: many, translate })

    show(elements, ids)
    await sleep(DWELL_MS + 10)

    // Everything below the first two leaves the viewport while the first two
    // are still on the wire.
    hide(elements, ids.slice(2))
    await sleep(300)

    expect(observer.visibleIds.size).toBe(2)
    const requested = translate.mock.calls.map((c) => c[1].text)
    for (const m of many.slice(2)) {
      expect(requested).not.toContain(m.content)
    }
  })

  test('an explicit request is not stuck behind the automatic queue', async () => {
    const translate = okTranslate(60)
    const { store, elements } = build({ messages: many, translate })

    show(elements, ids)
    await sleep(DWELL_MS + 10)

    store.translate('urgent', {
      roomId: 'r1',
      text: 'clicked',
      targetLang: 'ja',
      srcVersion: 0,
      origin: 'manual',
    })
    await sleep(20)

    // Two automatic slots are busy; the manual request must have taken one of
    // the remaining ones rather than queued behind them.
    const requested = translate.mock.calls.map((c) => c[1].text)
    expect(requested).toContain('clicked')
  })
})

describe('the decision log', () => {
  test('records why a message was skipped, not just that nothing happened', async () => {
    const translate = okTranslate()
    const harness = build({ messages: [msg('m1', 'my own words', 'alice')], translate })

    show(harness.elements, ['m1'])
    await sleep(DWELL_MS + 60)

    // The symptom is "this message never gets translated". Without the log
    // there is nothing at all to read: no request, no error, no state change.
    const kinds = harness.log.timeline('m1').map((r) => r.kind)
    expect(kinds).toContain(DECISION.Visible)
    expect(kinds).toContain(DECISION.Dwell)
    expect(kinds).toContain(DECISION.Skip)
    expect(harness.log.timeline('m1').at(-1).reason).toBe('own-message')
  })

  test('separates waiting in the queue from waiting on the backend', async () => {
    const translate = okTranslate(40)
    const messages = Array.from({ length: 6 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const harness = build({ messages, translate })

    show(
      harness.elements,
      messages.map((m) => m.id),
    )
    await sleep(DWELL_MS + 400)

    const sends = harness.log.records().filter((r) => r.kind === DECISION.Send)
    const settles = harness.log.records().filter((r) => r.kind === DECISION.Settle)

    // Two automatic slots and six candidates: something must have waited for a
    // slot, and every send must report how long it waited. That number is the
    // one that tells a saturated gate apart from a slow backend.
    expect(sends.length).toBeGreaterThan(2)
    expect(sends.every((r) => typeof r.waitedMs === 'number')).toBe(true)
    expect(sends.some((r) => r.waitedMs > 0)).toBe(true)
    expect(settles.every((r) => typeof r.tookMs === 'number')).toBe(true)
  })

  test('records a dropped job with its reason, so a silent drop is still visible', async () => {
    const translate = okTranslate(40)
    const messages = Array.from({ length: 8 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const harness = build({ messages, translate })
    const ids = messages.map((m) => m.id)

    show(harness.elements, ids)
    await sleep(DWELL_MS + 10)
    hide(harness.elements, ids.slice(2))
    await sleep(300)

    const drops = harness.log.records().filter((r) => r.kind === DECISION.Drop)
    expect(drops.length).toBeGreaterThan(0)
    expect(drops[0].reason).toBe('left-viewport')
  })
})

describe('invariants on the real path', () => {
  test('hold while a screenful is being translated', async () => {
    const translate = okTranslate(20)
    const messages = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const harness = build({ messages, translate })

    show(
      harness.elements,
      messages.map((m) => m.id),
    )

    // Sampled repeatedly rather than once at the end: the states worth
    // checking — a full sub-gate, a job mid-flight, a queue draining — only
    // exist while the work is in progress.
    for (let i = 0; i < 12; i += 1) {
      expect(checkInvariants(inspect(harness))).toEqual([])
      await sleep(20)
    }
  })

  test('hold once everything has settled', async () => {
    const translate = okTranslate()
    const messages = Array.from({ length: 5 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const harness = build({ messages, translate })

    show(
      harness.elements,
      messages.map((m) => m.id),
    )
    await sleep(DWELL_MS + 400)

    const snapshot = inspect(harness)
    expect(checkInvariants(snapshot)).toEqual([])
    expect(snapshot.queue).toHaveLength(0)
    expect(snapshot.activeCount).toBe(0)
  })

  test('a request that never replies shows as a stalled job, then gives its slot back', async () => {
    // The failure mode the checks exist for: no error, no rejected promise,
    // the queue simply stops. Two of these fill the automatic sub-gate, and
    // without a timeout automatic translation is over for the session.
    const translate = vi.fn(() => new Promise(() => {}))
    const messages = [msg('m0', 'line 0'), msg('m1', 'line 1'), msg('m2', 'line 2')]
    const harness = build({ messages, translate, config: { timeoutMs: 120 } })

    show(
      harness.elements,
      messages.map((m) => m.id),
    )
    await sleep(DWELL_MS + 40)

    const stuck = inspect(harness)
    expect(stuck.activeAutoCount).toBe(2)
    // Nothing is wrong yet — it becomes wrong once it has lasted. A zero
    // threshold stands in for the wall-clock one a live session would use.
    const stalled = checkInvariants(stuck, { stallMs: 0 })
    expect(stalled.filter((v) => v.code === INVARIANT.StalledJob)).toHaveLength(2)

    await sleep(200)

    // The timeout ended both, and the third message got its turn rather than
    // waiting behind two requests that were never coming back. It is now
    // occupying a slot of its own — hence "fewer than two", not "none".
    const recovered = inspect(harness)
    expect(recovered.activeAutoCount).toBeLessThan(2)
    expect(checkInvariants(recovered)).toEqual([])
    expect(translate.mock.calls.length).toBeGreaterThan(2)
  })

  test('the queue stops growing at its ceiling instead of tracking the whole room', async () => {
    const translate = vi.fn(() => new Promise(() => {}))
    const messages = Array.from({ length: 20 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const harness = build({ messages, translate, config: { maxQueueLength: 5, timeoutMs: 0 } })

    show(
      harness.elements,
      messages.map((m) => m.id),
    )
    await sleep(DWELL_MS + 120)

    const snapshot = inspect(harness)
    expect(snapshot.queue.length).toBeLessThanOrEqual(5)
    expect(checkInvariants(snapshot)).toEqual([])
  })
})

describe('outage handling', () => {
  test('stops issuing requests once the circuit opens, silently', async () => {
    const translate = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { code: 'internal' })
    })
    const messages = Array.from({ length: 9 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const { elements } = build({ messages, translate })

    // One at a time, so the failures are consecutive rather than concurrent.
    for (const m of messages) {
      show(elements, [m.id])
      await sleep(DWELL_MS + 40)
    }

    // Five consecutive failures trip the breaker; the remaining messages must
    // not each cost another request.
    expect(translate.mock.calls.length).toBeLessThanOrEqual(
      AUTO_TRANSLATE_CONFIG.failureCircuitThreshold,
    )
  })
})
