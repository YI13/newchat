import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTranslationCache } from '@/lib/idbTranslationCache'
import { AUTO_TRANSLATE_CONFIG, createAutoPolicy } from './autoPolicy'
import { DECISION, createDecisionLog } from './decisionLog'
import { checkInvariants } from './invariants'
import { createTranslationStore } from './store'
import { createVisibilityObserver } from './visibilityObserver'

// Investigation harness, not a behavioural test. It drives the three modules
// through a realistic scroll and reports what the decision log says about it.
//
// Opt-in: it adds ~40s of simulated scrolling to a suite run and prints an
// analysis report, so it stays out of the default `npm test`. Run it with
//
//   TRANSLATION_SCROLL_ANALYSIS=1 npx vitest run src/context/TranslationContext/scrollAnalysis.test.js
//
// Kept in the tree because it is the instrument the queue-policy numbers came
// from — rerun it after any change to dwell, concurrency, ceiling or sweep,
// and to compare against other implementations of the same design.
//
// The important fidelity detail: a real IntersectionObserver only fires when
// an element CROSSES the threshold. A message that stays on screen across
// several scroll steps produces no further entries at all. The simulation
// emits entries only on state changes, for exactly that reason.

const DWELL_MS = AUTO_TRANSLATE_CONFIG.dwellMs // 400
const LATENCY_MS = 800
const SCROLL_STEP_MS = 250
const WINDOW = 12
const STEP = 3
const TOTAL = 100
const ROW_HEIGHT = 60

let ios = []
let caches = []

class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback
    ios.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  emit(entries) {
    this.callback(entries, this)
  }
}

const describeAnalysis = process.env.TRANSLATION_SCROLL_ANALYSIS === '1' ? describe : describe.skip

const io = () => ios[ios.length - 1]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function build(configOverrides = {}) {
  const cache = createTranslationCache({
    dbName: `scroll-analysis-${Math.random().toString(36).slice(2)}`,
  })
  caches.push(cache)

  const messages = Array.from({ length: TOTAL }, (_, i) => ({
    id: `m${i}`,
    content: `line ${i}`,
    sender: { account: 'bob' },
    editedAt: 0,
  }))
  const registry = new Map(messages.map((m) => [m.id, m]))
  const log = createDecisionLog()
  let policy = null

  const observer = createVisibilityObserver({
    dwellMs: DWELL_MS,
    prefetchMarginPx: AUTO_TRANSLATE_CONFIG.prefetchMarginPx,
    log,
    onCandidate: (id) => policy.onCandidate(id),
  })

  const store = createTranslationStore({
    nats: { user: { account: 'alice', siteId: 'site-local' } },
    translate: vi.fn(async (_n, { text, targetLang }) => {
      await sleep(LATENCY_MS)
      return { translatedText: `[${targetLang}] ${text}`, targetLang }
    }),
    cache,
    log,
    config: {
      maxConcurrent: AUTO_TRANSLATE_CONFIG.maxConcurrent,
      maxConcurrentAuto: AUTO_TRANSLATE_CONFIG.maxConcurrentAuto,
      timeoutMs: AUTO_TRANSLATE_CONFIG.timeoutMs,
      maxQueueLength: AUTO_TRANSLATE_CONFIG.maxQueueLength,
      isAutoEligible: (id) => observer.visibleIds.has(id),
      orderAutoQueue: (ids) => observer.byDistanceFromCentre(ids),
      ...configOverrides,
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
  })

  // jsdom performs no layout, so every element would report an all-zero box
  // and the observer would fall back to its cached crossing positions —
  // silently not exercising the live measurement at all. Each row therefore
  // carries a position the scroll keeps up to date, the way a browser would.
  const elements = new Map()
  const positions = new Map()
  for (const m of messages) {
    const el = document.createElement('div')
    el.getBoundingClientRect = () => {
      const top = positions.get(m.id)
      if (top === undefined) return { top: 0, height: 0, bottom: 0 }
      return { top, height: ROW_HEIGHT, bottom: top + ROW_HEIGHT }
    }
    document.body.appendChild(el)
    elements.set(m.id, el)
    observer.observe(m.id, el)
  }

  // The viewport is 12 rows tall and sits at a fixed screen position; the
  // content scrolls under it.
  observer.setViewportCentre((WINDOW * ROW_HEIGHT) / 2)

  return { cache, store, policy, observer, elements, positions, log, messages }
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

describeAnalysis('scrolling a long room', () => {
  test('analysis', async () => {
    const h = build()
    const onScreen = new Set()
    const samples = []
    const violations = []
    /** The screen position each row genuinely has right now. */
    const trueCentre = new Map()

    const scrollTo = (top) => {
      const next = new Set()
      for (let i = top; i < Math.min(top + WINDOW, TOTAL); i += 1) next.add(`m${i}`)

      const entries = []
      for (const id of next) {
        const index = Number(id.slice(1))
        const y = (index - top) * ROW_HEIGHT
        // Every visible row moves on every scroll step, whether or not it
        // crosses an edge. That is precisely what the observer cannot see.
        h.positions.set(id, y)
        trueCentre.set(id, y + ROW_HEIGHT / 2)
        // Only a CROSSING produces an entry. A row already on screen stays
        // silent no matter how far it has moved.
        if (!onScreen.has(id)) {
          entries.push({
            target: h.elements.get(id),
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: { top: y, height: ROW_HEIGHT, bottom: y + ROW_HEIGHT },
          })
        }
      }
      for (const id of onScreen) {
        if (!next.has(id)) {
          trueCentre.delete(id)
          h.positions.delete(id)
          entries.push({
            target: h.elements.get(id),
            isIntersecting: false,
            intersectionRatio: 0,
            boundingClientRect: { top: 0, height: ROW_HEIGHT, bottom: ROW_HEIGHT },
          })
        }
      }
      if (entries.length) io().emit(entries)
      onScreen.clear()
      for (const id of next) onScreen.add(id)
    }

    scrollTo(0)
    for (let top = 0; top + WINDOW <= TOTAL; top += STEP) {
      scrollTo(top)
      const snapshot = {
        ...h.store.inspect(),
        visibleIds: [...h.observer.visibleIds],
        registeredIds: h.observer.registeredIds(),
      }
      samples.push({
        top,
        queue: snapshot.queue.length,
        active: snapshot.activeCount,
        auto: snapshot.activeAutoCount,
        visible: snapshot.visibleIds.length,
      })
      violations.push(...checkInvariants(snapshot))
      await sleep(SCROLL_STEP_MS)
    }

    // Let everything in flight land.
    await sleep(LATENCY_MS * 3)

    const records = h.log.records()
    const by = (kind) => records.filter((r) => r.kind === kind)
    const count = (kind) => by(kind).length

    const skipReasons = {}
    for (const r of by(DECISION.Skip)) skipReasons[r.reason] = (skipReasons[r.reason] ?? 0) + 1
    const dropReasons = {}
    for (const r of by(DECISION.Drop)) dropReasons[r.reason] = (dropReasons[r.reason] ?? 0) + 1

    const sends = by(DECISION.Send)
    const settles = by(DECISION.Settle)
    const waits = sends.map((r) => r.waitedMs).sort((a, b) => a - b)
    const tooks = settles.map((r) => r.tookMs).sort((a, b) => a - b)

    // Work paid for that the reader never saw. Reconstructed properly: replay
    // the visible/hidden records for that message and ask what its state was
    // at the instant its reply landed. "Hidden at some point afterwards" is
    // not the same question — everything is hidden once the scroll ends.
    const sentIds = new Set(sends.map((r) => r.messageId))
    const visibleAt = (id, t) => {
      let visible = false
      for (const r of records) {
        if (r.messageId !== id || r.t > t) continue
        if (r.kind === DECISION.Visible) visible = true
        if (r.kind === DECISION.Hidden) visible = false
      }
      return visible
    }
    const wasted = settles.filter((r) => r.ok && !visibleAt(r.messageId, r.t))

    // The ordering question: byDistanceFromCentre ranks on the position the
    // observer recorded when the row CROSSED the edge. For a row that has
    // since travelled across the viewport, that number is stale. Measure how
    // far off it is for the rows on screen right now.
    const rankErrors = []
    for (const [id, actual] of trueCentre) {
      const believedOrder = h.observer.byDistanceFromCentre([...trueCentre.keys()])
      const believedRank = believedOrder.indexOf(id)
      const actualOrder = [...trueCentre.entries()]
        .sort((a, b) => Math.abs(a[1] - 360) - Math.abs(b[1] - 360))
        .map(([k]) => k)
      const actualRank = actualOrder.indexOf(id)
      rankErrors.push(Math.abs(believedRank - actualRank))
      void actual
    }
    const meanRankError = rankErrors.length
      ? (rankErrors.reduce((a, b) => a + b, 0) / rankErrors.length).toFixed(2)
      : 'n/a'

    /* eslint-disable no-console */
    console.log('\n===== SCROLL ANALYSIS =====')
    console.log(`messages=${TOTAL} window=${WINDOW} step=${STEP} scrollEvery=${SCROLL_STEP_MS}ms`)
    console.log(
      `dwell=${DWELL_MS}ms latency=${LATENCY_MS}ms autoGate=${AUTO_TRANSLATE_CONFIG.maxConcurrentAuto}`,
    )
    console.log('---- decision counts ----')
    console.log({
      visible: count(DECISION.Visible),
      hidden: count(DECISION.Hidden),
      dwell: count(DECISION.Dwell),
      skip: count(DECISION.Skip),
      suppressed: count(DECISION.Suppressed),
      enqueue: count(DECISION.Enqueue),
      send: count(DECISION.Send),
      drop: count(DECISION.Drop),
      settle: count(DECISION.Settle),
      cached: count(DECISION.Cached),
      deduped: count(DECISION.Deduped),
    })
    console.log('skip reasons', skipReasons)
    console.log('drop reasons', dropReasons)
    console.log('---- latency ----')
    console.log({
      queueWaitMedian: waits[Math.floor(waits.length / 2)],
      queueWaitMax: waits[waits.length - 1],
      backendMedian: tooks[Math.floor(tooks.length / 2)],
      cancelledDwells: by(DECISION.Hidden).filter((r) => r.cancelledDwell).length,
    })
    console.log('---- coverage ----')
    console.log({
      messagesSeen: new Set(by(DECISION.Visible).map((r) => r.messageId)).size,
      messagesDwelled: new Set(by(DECISION.Dwell).map((r) => r.messageId)).size,
      messagesSent: sentIds.size,
      repliesThatLandedOffScreen: `${wasted.length}/${settles.filter((r) => r.ok).length}`,
    })
    console.log('---- queue depth over the scroll (top:queue/auto/visible) ----')
    console.log(samples.map((s) => `${s.top}:q${s.queue}/a${s.auto}/v${s.visible}`).join(' '))
    console.log('---- invariants ----')
    console.log(violations.length === 0 ? 'no violations' : violations.slice(0, 10))
    console.log('---- centre ranking ----')
    console.log(`mean rank error vs true position: ${meanRankError} (0 = perfect)`)
    console.log('===========================\n')
    /* eslint-enable no-console */

    expect(records.length).toBeGreaterThan(0)
  }, 60_000)
})


describeAnalysis('scrolling, then stopping to read', () => {
  /** Scroll for a while, stop, and watch what the screen you settled on does.
   *  `sweep` mirrors the provider's recheck interval. */
  async function stopAndRead(label, configOverrides, { sweep = true } = {}) {
    const h = build(configOverrides)
    const sweepTimer = sweep
      ? setInterval(() => h.policy.recheckVisible(), AUTO_TRANSLATE_CONFIG.recheckIntervalMs)
      : null
    const onScreen = new Set()
    let currentTop = 0
    /** Settles landing on a row ABOVE the viewport. Swapping text there
     *  changes its height, shifting everything below it. */
    let settledAbove = 0
    h.log.subscribe((r) => {
      if (r.kind !== DECISION.Settle || !r.ok) return
      if (Number(r.messageId.slice(1)) < currentTop) settledAbove += 1
    })

    const scrollTo = (top) => {
      currentTop = top
      const next = new Set()
      const entries = []
      for (let i = top; i < Math.min(top + WINDOW, TOTAL); i += 1) {
        const id = `m${i}`
        next.add(id)
        h.positions.set(id, (i - top) * ROW_HEIGHT)
        if (!onScreen.has(id)) {
          entries.push({
            target: h.elements.get(id),
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: {
              top: (i - top) * ROW_HEIGHT,
              height: ROW_HEIGHT,
              bottom: (i - top + 1) * ROW_HEIGHT,
            },
          })
        }
      }
      for (const id of onScreen) {
        if (next.has(id)) continue
        h.positions.delete(id)
        entries.push({
          target: h.elements.get(id),
          isIntersecting: false,
          intersectionRatio: 0,
          boundingClientRect: { top: 0, height: ROW_HEIGHT, bottom: ROW_HEIGHT },
        })
      }
      if (entries.length) io().emit(entries)
      onScreen.clear()
      for (const id of next) onScreen.add(id)
    }

    // Far enough to build the backlog a real reader builds while hunting for
    // where they left off. The distance matters: a short scroll leaves an
    // empty queue and flatters the result.
    for (let top = 0; top <= 75; top += STEP) {
      scrollTo(top)
      await sleep(SCROLL_STEP_MS)
    }

    // Now stop. This is the moment the user starts reading.
    const stoppedAt = Date.now()
    const visible = [...onScreen]
    const translatedAt = new Map()
    let waited = 0
    while (translatedAt.size < visible.length && waited < 10_000) {
      for (const id of visible) {
        if (translatedAt.has(id)) continue
        if (h.store.getEntry(id).status === 'translated') {
          translatedAt.set(id, Date.now() - stoppedAt)
        }
      }
      await sleep(100)
      waited = Date.now() - stoppedAt
    }

    if (sweepTimer) clearInterval(sweepTimer)
    const times = [...translatedAt.values()].sort((a, b) => a - b)
    const stuck = visible.filter((id) => !translatedAt.has(id))

    /* eslint-disable no-console */
    console.log(`\n===== STOP AND READ — ${label} =====`)
    console.log({
      translatedOnScreen: `${translatedAt.size}/${visible.length}`,
      firstAfterMs: times[0] ?? null,
      lastAfterMs: times[times.length - 1] ?? null,
      settledAboveViewport: settledAbove,
    })
    for (const id of stuck.slice(0, 2)) {
      console.log(
        `  ${id} [${h.store.getEntry(id).status}] visible=${h.observer.visibleIds.has(id)}`,
        h.log
          .timeline(id)
          .map((r) => `${r.kind}${r.reason ? `(${r.reason})` : ''}+${r.sinceFirst}ms`)
          .join(' → '),
      )
    }
    console.log('==========================================\n')
    /* eslint-enable no-console */

    return { translated: translatedAt.size, total: visible.length, stuck }
  }

  test('the sweep is what makes a queue ceiling survivable', async () => {
    // Without it, the observer raises a candidate once per visibility
    // transition, so a message refused while it STAYS on screen gets no
    // second chance: it sits at 'idle' in the middle of the viewport showing
    // its source text for as long as the user looks at it.
    const unswept = await stopAndRead('ceiling 50, no sweep', { maxQueueLength: 50 }, {
      sweep: false,
    })
    const swept = await stopAndRead('ceiling 50, with sweep (shipping)', { maxQueueLength: 50 })

    expect(unswept.stuck.length).toBeGreaterThan(0)
    expect(swept.translated).toBeGreaterThan(unswept.translated)
    expect(swept.stuck).toEqual([])
  }, 90_000)
})
