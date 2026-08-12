import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createVisibilityObserver } from './visibilityObserver'

// jsdom has no IntersectionObserver. This fake records how it was constructed
// and lets a test drive intersection changes explicitly, which is the only way
// to assert that visibility comes from the observer rather than from the act
// of registering an element.
let instances = []

class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback
    this.options = options ?? {}
    this.observed = new Set()
    this.unobserved = []
    this.disconnected = false
    instances.push(this)
  }

  observe(el) {
    this.observed.add(el)
  }

  unobserve(el) {
    this.observed.delete(el)
    this.unobserved.push(el)
  }

  disconnect() {
    this.disconnected = true
    this.observed.clear()
  }

  /** Drive the callback the way the browser would. */
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

function latest() {
  return instances[instances.length - 1]
}

function makeEl(id) {
  const el = document.createElement('div')
  el.dataset.testid = id
  document.body.appendChild(el)
  return el
}

/** jsdom performs no layout, so every element reports an all-zero box. Give
 *  one a position the way the browser would. */
function placeAt(el, top, height = 20) {
  el.getBoundingClientRect = () => ({
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
  })
}

beforeEach(() => {
  instances = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function makeObserver(overrides = {}) {
  const onCandidate = vi.fn()
  const observer = createVisibilityObserver({
    onCandidate,
    dwellMs: 400,
    prefetchMarginPx: 0,
    ...overrides,
  })
  return { observer, onCandidate }
}

describe('observer construction', () => {
  test.each([250, -250])('never builds a negative rootMargin (prefetchMarginPx %i)', (px) => {
    // A negative rootMargin shrinks the intersection box. On most viewports
    // that makes the effective root height negative, so nothing ever
    // intersects and the feature silently does nothing. The failure mode is
    // "no candidates ever", which no behavioural test can tell apart from
    // "correctly filtered", so assert the value directly. The negative input
    // is the case that matters: a positive one passes with or without the
    // clamp (mutation testing caught exactly that gap).
    const { observer } = makeObserver({ prefetchMarginPx: px })
    observer.observe('m1', makeEl('m1'))

    const margin = latest().options.rootMargin ?? '0px'
    for (const part of margin.split(/\s+/)) {
      expect(parseFloat(part)).toBeGreaterThanOrEqual(0)
    }
  })

  test('expands the box by prefetchMarginPx', () => {
    const { observer } = makeObserver({ prefetchMarginPx: 250 })
    observer.observe('m1', makeEl('m1'))

    expect(latest().options.rootMargin).toContain('250')
  })

  test('is created lazily, only once an element is registered', () => {
    makeObserver()
    expect(instances).toHaveLength(0)
  })
})

describe('registration does not imply visibility', () => {
  test('observing an element emits no candidate on its own', async () => {
    const { observer, onCandidate } = makeObserver()

    observer.observe('m1', makeEl('m1'))
    await vi.advanceTimersByTimeAsync(1000)

    // Starting the dwell timer at registration time makes every rendered
    // message a candidate and defeats the whole point of dwell.
    expect(onCandidate).not.toHaveBeenCalled()
    expect(observer.visibleIds.has('m1')).toBe(false)
  })

  test('a non-intersecting entry keeps the element out of the visible set', async () => {
    const { observer, onCandidate } = makeObserver()
    const el = makeEl('m1')
    observer.observe('m1', el)

    latest().emit([{ target: el, isIntersecting: false }])
    await vi.advanceTimersByTimeAsync(1000)

    expect(observer.visibleIds.has('m1')).toBe(false)
    expect(onCandidate).not.toHaveBeenCalled()
  })
})

describe('dwell', () => {
  test('emits a candidate only after the dwell window elapses', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 400 })
    const el = makeEl('m1')
    observer.observe('m1', el)

    latest().emit([{ target: el, isIntersecting: true }])

    await vi.advanceTimersByTimeAsync(399)
    expect(onCandidate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('scrolling past before the window elapses cancels the candidate', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 400 })
    const el = makeEl('m1')
    observer.observe('m1', el)

    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(200)
    latest().emit([{ target: el, isIntersecting: false }])
    await vi.advanceTimersByTimeAsync(1000)

    expect(onCandidate).not.toHaveBeenCalled()
  })

  test('re-observing an already visible element does not restart its dwell', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 400 })
    const el = makeEl('m1')
    observer.observe('m1', el)
    latest().emit([{ target: el, isIntersecting: true }])

    await vi.advanceTimersByTimeAsync(300)
    observer.observe('m1', el)
    await vi.advanceTimersByTimeAsync(100)

    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('emits once per continuous visible period', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 400 })
    const el = makeEl('m1')
    observer.observe('m1', el)

    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(500)
    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(500)

    expect(onCandidate).toHaveBeenCalledTimes(1)
  })
})

describe('identity', () => {
  test('takes the id from observe(), not from a DOM attribute', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 0 })
    const el = document.createElement('div')
    document.body.appendChild(el)
    // Deliberately no data-* id: reading the id back off the element makes
    // the module silently skip anything the renderer forgot to annotate.
    observer.observe('m1', el)

    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(1)

    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('ignores an intersection for an element it never registered', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 0 })
    observer.observe('m1', makeEl('m1'))

    latest().emit([{ target: makeEl('stray'), isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(10)

    expect(onCandidate).not.toHaveBeenCalled()
  })
})

describe('unobserve', () => {
  test('detaches the element from the IntersectionObserver', () => {
    const { observer } = makeObserver()
    const el = makeEl('m1')
    observer.observe('m1', el)

    observer.unobserve('m1')

    // Dropping the registry entry before calling unobserve leaves the
    // observer holding a strong reference to a detached node forever.
    expect(latest().unobserved).toContain(el)
    expect(latest().observed.has(el)).toBe(false)
  })

  test('clears the element from the visible set and cancels its dwell', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 400 })
    const el = makeEl('m1')
    observer.observe('m1', el)
    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(100)

    observer.unobserve('m1')
    await vi.advanceTimersByTimeAsync(1000)

    expect(observer.visibleIds.has('m1')).toBe(false)
    expect(onCandidate).not.toHaveBeenCalled()
  })

  test('is safe for an id that was never registered', () => {
    const { observer } = makeObserver()
    expect(() => observer.unobserve('nope')).not.toThrow()
  })
})

describe('reset and root changes', () => {
  test('reset clears visibility and keeps observing the registered elements', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 0 })
    const el = makeEl('m1')
    observer.observe('m1', el)
    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(10)
    onCandidate.mockClear()

    observer.reset()

    // A tab returning to the foreground re-evaluates what is on screen; the
    // element must still be attached to an observer for that to happen.
    expect(observer.visibleIds.size).toBe(0)
    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(10)
    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('setRoot rebuilds the observer against the new scroll container', () => {
    const { observer } = makeObserver()
    const el = makeEl('m1')
    observer.observe('m1', el)
    const before = instances.length

    const root = makeEl('scroller')
    observer.setRoot(root)

    expect(instances.length).toBeGreaterThan(before)
    expect(latest().options.root).toBe(root)
    expect(latest().observed.has(el)).toBe(true)
  })
})

describe('ordering', () => {
  test('ranks visible ids by absolute distance from the viewport centre', () => {
    const { observer } = makeObserver()
    const near = makeEl('near')
    const above = makeEl('above')
    const far = makeEl('far')
    observer.observe('near', near)
    observer.observe('above', above)
    observer.observe('far', far)

    // Centre is 300. `above` sits 200px before it, `far` 250px after it — an
    // unsigned distance is what keeps "just off the top" from ranking ahead
    // of everything below.
    observer.setViewportCentre(300)
    latest().emit([
      { target: near, isIntersecting: true, top: 290, height: 20 },
      { target: above, isIntersecting: true, top: 90, height: 20 },
      { target: far, isIntersecting: true, top: 540, height: 20 },
    ])

    expect(observer.byDistanceFromCentre(['far', 'above', 'near'])).toEqual([
      'near',
      'above',
      'far',
    ])
  })

  test('ranks by where a row is now, not where it was when it entered', () => {
    // IntersectionObserver only fires when an element CROSSES the threshold.
    // A row that entered at the bottom edge and has since scrolled to the
    // middle produces no further entries at all, so a cached position ranks
    // it as though it were still at the bottom — and the queue then works on
    // whatever happened to enter first rather than on what is being read.
    const { observer } = makeObserver()
    const travelled = makeEl('travelled')
    const settled = makeEl('settled')
    observer.observe('travelled', travelled)
    observer.observe('settled', settled)

    observer.setViewportCentre(300)
    placeAt(travelled, 560)
    placeAt(settled, 340)
    latest().emit([
      { target: travelled, isIntersecting: true, top: 560, height: 20 },
      { target: settled, isIntersecting: true, top: 340, height: 20 },
    ])
    expect(observer.byDistanceFromCentre(['travelled', 'settled'])).toEqual([
      'settled',
      'travelled',
    ])

    // The user scrolls. Both rows move; neither crosses an edge, so no entry
    // is delivered.
    placeAt(travelled, 295)
    placeAt(settled, 80)

    expect(observer.byDistanceFromCentre(['travelled', 'settled'])).toEqual([
      'travelled',
      'settled',
    ])
  })

  test('falls back to the last crossing position when a row cannot be measured', () => {
    // A detached element, or any environment without layout, reports an
    // all-zero box. The position recorded when it crossed the edge is the
    // best answer available then.
    const { observer } = makeObserver()
    const near = makeEl('near')
    const far = makeEl('far')
    observer.observe('near', near)
    observer.observe('far', far)

    observer.setViewportCentre(300)
    latest().emit([
      { target: near, isIntersecting: true, top: 290, height: 20 },
      { target: far, isIntersecting: true, top: 540, height: 20 },
    ])

    expect(observer.byDistanceFromCentre(['far', 'near'])).toEqual(['near', 'far'])
  })
})

// Suspending is not destroying. The registry belongs to the mounted message
// components — they call observe()/unobserve() from their own refs — so a
// suspend that clears it leaves nothing to resume over, and the rows will not
// re-mount just because a setting changed.
describe('setEnabled', () => {
  /** Drive one element into view on whichever observer is currently live. */
  function show(el, top = 100) {
    placeAt(el, top)
    latest().emit([{ target: el, isIntersecting: true, top }])
  }

  test('stops watching without forgetting what is mounted', () => {
    const { observer } = makeObserver()
    observer.observe('m1', makeEl('m1'))
    observer.observe('m2', makeEl('m2'))
    const io = latest()

    observer.setEnabled(false)

    expect(io.disconnected).toBe(true)
    expect(observer.registeredIds()).toEqual(['m1', 'm2'])
  })

  test('builds no observer at all while suspended', () => {
    const { observer } = makeObserver()
    observer.setEnabled(false)

    observer.observe('m1', makeEl('m1'))

    // Registering while off must record the element and nothing else —
    // otherwise the IntersectionObserver comes back to life through the side
    // door and the whole point is lost.
    expect(instances).toHaveLength(0)
    expect(observer.registeredIds()).toEqual(['m1'])
  })

  test('drops a dwell that was already counting down', () => {
    const { observer, onCandidate } = makeObserver()
    const el = makeEl('m1')
    observer.observe('m1', el)
    show(el)
    vi.advanceTimersByTime(200)

    observer.setEnabled(false)
    vi.advanceTimersByTime(10_000)

    expect(onCandidate).not.toHaveBeenCalled()
    expect([...observer.visibleIds]).toEqual([])
  })

  test('resumes over the rows that are still mounted, with no re-mount', () => {
    // The whole point. Turning the switch back on re-renders nothing, so if
    // resume does not re-observe the existing registry the tracker comes back
    // watching an empty set and automatic translation stays dead — the same
    // failure shape as tearing the registry down on a room change.
    const { observer, onCandidate } = makeObserver()
    const el = makeEl('m1')
    observer.observe('m1', el)
    observer.setEnabled(false)

    observer.setEnabled(true)
    expect(latest().observed.has(el)).toBe(true)

    show(el)
    vi.advanceTimersByTime(500)
    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('a row mounted while suspended is picked up on resume', () => {
    const { observer, onCandidate } = makeObserver()
    observer.setEnabled(false)
    const el = makeEl('m1')
    observer.observe('m1', el)

    observer.setEnabled(true)
    show(el)
    vi.advanceTimersByTime(500)

    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('a row unmounted while suspended is not resurrected on resume', () => {
    const { observer } = makeObserver()
    observer.observe('m1', makeEl('m1'))
    observer.setEnabled(false)
    observer.unobserve('m1')

    observer.setEnabled(true)

    expect(observer.registeredIds()).toEqual([])
  })

  test('repeating the same state is a no-op', () => {
    const { observer } = makeObserver()
    observer.observe('m1', makeEl('m1'))
    const io = latest()

    observer.setEnabled(true)

    expect(latest()).toBe(io)
    expect(observer.registeredIds()).toEqual(['m1'])
  })

  test('changing the scroll root while suspended stays suspended', () => {
    const { observer } = makeObserver()
    observer.observe('m1', makeEl('m1'))
    observer.setEnabled(false)
    const count = instances.length

    observer.setRoot(document.createElement('div'))

    expect(instances).toHaveLength(count)
  })
})
