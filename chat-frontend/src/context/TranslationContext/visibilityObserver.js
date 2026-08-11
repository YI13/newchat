// Which messages is the user actually reading?
//
// Three pieces of state, deliberately not merged:
//
//   elements    — the registry. observe()/unobserve() own it. Membership
//                 means "this message is mounted", nothing about visibility.
//   visibleIds  — the visible set. ONLY the IntersectionObserver callback
//                 writes to it. Registering an element must never put it
//                 here, or the dwell filter is bypassed for every rendered
//                 message and the module merely looks like it works.
//   dwellTimers — pending candidates. A timer that fires means the user
//                 stayed with the message rather than scrolling past it.
//
// Element identity comes from the observe() call and lives in a WeakMap.
// Reading it back off a data-* attribute makes the module silently skip any
// element the renderer forgot to annotate — a failure that presents as
// "translation just doesn't happen".

import { DECISION, NOOP_DECISION_LOG } from './decisionLog'

const DEFAULTS = {
  dwellMs: 400,
  prefetchMarginPx: 0,
}

export function createVisibilityObserver({
  onCandidate,
  root = null,
  log = NOOP_DECISION_LOG,
  ...options
} = {}) {
  const config = { ...DEFAULTS, ...options }

  const elements = new Map()
  const elementIds = new WeakMap()
  const visibleIds = new Set()
  const dwellTimers = new Map()
  const centres = new Map()

  let currentRoot = root
  let observer = null
  let viewportCentre = null
  // Suspended is a state of the *watching*, never of the registry. `elements`
  // is written by the mounted message components through their own refs, and
  // nothing here may clear it on their behalf — a resume has to re-observe
  // exactly what is mounted, and a setting change re-renders none of them.
  let enabled = config.enabled !== false

  function rootMargin() {
    // Positive only. A negative margin shrinks the intersection box, and on a
    // typical viewport that drives the effective height below zero, so
    // nothing ever intersects.
    const margin = Math.max(0, config.prefetchMarginPx)
    return `${margin}px 0px ${margin}px 0px`
  }

  function handleEntries(entries) {
    for (const entry of entries) {
      const id = elementIds.get(entry.target)
      if (id === undefined) continue

      if (entry.isIntersecting) {
        const rect = entry.boundingClientRect
        if (rect) centres.set(id, rect.top + rect.height / 2)
        markVisible(id)
      } else {
        markHidden(id)
      }
    }
  }

  function ensureObserver() {
    if (observer) return observer
    observer = new IntersectionObserver(handleEntries, {
      root: currentRoot,
      rootMargin: rootMargin(),
      threshold: 0,
    })
    return observer
  }

  function markVisible(id) {
    if (visibleIds.has(id)) return
    visibleIds.add(id)
    log.emit(DECISION.Visible, id, { visible: visibleIds.size })

    if (config.dwellMs <= 0) {
      log.emit(DECISION.Dwell, id, { dwellMs: 0 })
      onCandidate?.(id)
      return
    }
    const timer = setTimeout(() => {
      dwellTimers.delete(id)
      log.emit(DECISION.Dwell, id, { dwellMs: config.dwellMs })
      onCandidate?.(id)
    }, config.dwellMs)
    dwellTimers.set(id, timer)
  }

  function cancelDwell(id) {
    const timer = dwellTimers.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    dwellTimers.delete(id)
  }

  function markHidden(id) {
    const wasVisible = visibleIds.delete(id)
    centres.delete(id)
    // Whether a dwell was pending is the interesting half: it separates "the
    // user scrolled past too fast" from "the message was already a candidate".
    const hadPendingDwell = dwellTimers.has(id)
    cancelDwell(id)
    if (wasVisible) {
      log.emit(DECISION.Hidden, id, { cancelledDwell: hadPendingDwell, visible: visibleIds.size })
    }
  }

  /** Registering is unconditional; watching is not. While suspended the
   *  element is recorded and left alone, so a later resume sees the true set
   *  of mounted rows rather than only those mounted after it. */
  function watch(element) {
    if (enabled) ensureObserver().observe(element)
  }

  function observe(id, element) {
    if (!element) return
    // Idempotent: a re-render that re-registers the same element must not
    // restart a dwell the user has already partly served.
    if (elements.get(id) === element) {
      watch(element)
      return
    }
    if (elements.has(id)) unobserve(id)

    elements.set(id, element)
    elementIds.set(element, id)
    watch(element)
  }

  function unobserve(id) {
    const element = elements.get(id)
    if (!element) return
    // Detach from the observer BEFORE dropping the registry entry, or the
    // observer keeps a strong reference to a node that is already gone.
    observer?.unobserve(element)
    elementIds.delete(element)
    elements.delete(id)
    markHidden(id)
  }

  /** Tear the observer down and rebuild it over the same registry. Used when
   *  the scroll container changes, and when a backgrounded tab returns and
   *  the whole viewport has to be re-evaluated. */
  function rebuild() {
    for (const id of [...dwellTimers.keys()]) cancelDwell(id)
    visibleIds.clear()
    centres.clear()

    observer?.disconnect()
    observer = null

    if (!enabled || elements.size === 0) return
    const next = ensureObserver()
    for (const element of elements.values()) next.observe(element)
  }

  /** Suspend or resume watching. Suspending drops every observation, pending
   *  dwell and visible mark; resuming rebuilds over the registry, which is
   *  what makes it safe to call from a settings toggle that re-renders
   *  nothing. Deliberately NOT destroy(): destroy clears the registry, and a
   *  resume after one would come back watching an empty set. */
  function setEnabled(next) {
    if (enabled === next) return
    enabled = next
    rebuild()
    log.emit(DECISION.Tracker, null, { state: enabled ? 'resumed' : 'suspended', registered: elements.size })
  }

  function setRoot(nextRoot) {
    if (currentRoot === nextRoot) return
    currentRoot = nextRoot
    rebuild()
  }

  function setViewportCentre(value) {
    viewportCentre = value
  }

  function centreOfViewport() {
    if (viewportCentre !== null) return viewportCentre
    const rect = currentRoot?.getBoundingClientRect?.()
    if (rect) return rect.top + rect.height / 2
    return (globalThis.innerHeight ?? 0) / 2
  }

  /**
   * Where a row is right now.
   *
   * Measured live rather than read from `centres`, because the cache is only
   * written when an element CROSSES the threshold: a row that entered at the
   * bottom edge and has since scrolled to the middle delivers no further
   * entries, so its cached position is wherever it came in. Ranking on that
   * means ranking on arrival order, not on what the user is looking at.
   *
   * Called at pick time — once per queue drain, not per scroll event — so
   * this costs one forced layout when a slot frees, not one per frame.
   */
  function centreOf(id) {
    const rect = elements.get(id)?.getBoundingClientRect?.()
    // An all-zero box means no layout: a detached element, or jsdom. The
    // crossing position is then the best answer available.
    if (rect && (rect.height > 0 || rect.top !== 0)) return rect.top + rect.height / 2
    return centres.get(id)
  }

  /** Rank ids by how close they are to the middle of what the user is looking
   *  at. Unsigned: a message just above the centre is as relevant as one just
   *  below it. */
  function byDistanceFromCentre(ids) {
    const centre = centreOfViewport()
    // Measured once per call rather than inside the comparator: a sort makes
    // O(n log n) comparisons, and reading layout in each of them would turn
    // one flush into hundreds.
    const distances = new Map(
      [...ids].map((id) => [id, Math.abs((centreOf(id) ?? Infinity) - centre)]),
    )
    return [...ids].sort((a, b) => distances.get(a) - distances.get(b))
  }

  function destroy() {
    for (const id of [...dwellTimers.keys()]) cancelDwell(id)
    observer?.disconnect()
    observer = null
    elements.clear()
    visibleIds.clear()
    centres.clear()
  }

  return {
    config,
    visibleIds,
    /** Mounted message ids. Paired with visibleIds, this is what makes
     *  "visible but no longer mounted" checkable from outside. */
    registeredIds: () => [...elements.keys()],
    observe,
    unobserve,
    reset: rebuild,
    setEnabled,
    isEnabled: () => enabled,
    setRoot,
    setViewportCentre,
    byDistanceFromCentre,
    destroy,
  }
}
