// Runtime invariants for the translation queue.
//
// Every fault this catches presents to the user in exactly one way: some
// messages stop being translated. Nothing throws, no request errors, the UI
// looks calm. That is what makes queue bugs expensive to find by hand — the
// symptom carries none of the cause.
//
// So the properties are checked directly. Each one is a statement the queue
// claims to guarantee; a violation names which claim broke, which is enough
// to go straight to the responsible code path.
//
// Pure and read-only: safe to run on an interval in a live session.

export const INVARIANT = {
  NegativeActive: 'negative-active',
  OverConcurrency: 'over-concurrency',
  OverAutoConcurrency: 'over-auto-concurrency',
  AutoExceedsTotal: 'auto-exceeds-total',
  SlotLeak: 'slot-leak',
  OrphanQueued: 'orphan-queued',
  GhostQueued: 'ghost-queued',
  QueueOverLimit: 'queue-over-limit',
  StalledJob: 'stalled-job',
  QueueNotDraining: 'queue-not-draining',
  VisibleNotRegistered: 'visible-not-registered',
}

const DEFAULT_STALL_MS = 30_000

export function checkInvariants(snapshot, { now = Date.now(), stallMs = DEFAULT_STALL_MS } = {}) {
  const {
    config = {},
    activeCount = 0,
    activeAutoCount = 0,
    queue = [],
    inflight = [],
    entries = [],
    visibleIds = [],
    registeredIds = [],
  } = snapshot

  const violations = []
  const add = (code, detail, messageId) => violations.push({ code, detail, messageId })

  // --- slot accounting ---------------------------------------------------

  if (activeCount < 0 || activeAutoCount < 0) {
    add(
      INVARIANT.NegativeActive,
      `active counters went negative (active=${activeCount}, auto=${activeAutoCount}) — a slot was released twice`,
    )
  }

  if (config.maxConcurrent != null && activeCount > config.maxConcurrent) {
    add(
      INVARIANT.OverConcurrency,
      `${activeCount} jobs in flight against a ceiling of ${config.maxConcurrent}`,
    )
  }

  if (config.maxConcurrentAuto != null && activeAutoCount > config.maxConcurrentAuto) {
    add(
      INVARIANT.OverAutoConcurrency,
      `${activeAutoCount} automatic jobs in flight against a sub-gate of ${config.maxConcurrentAuto}`,
    )
  }

  if (activeAutoCount > activeCount) {
    add(
      INVARIANT.AutoExceedsTotal,
      `automatic count ${activeAutoCount} exceeds the total ${activeCount}`,
    )
  }

  // Only one direction is a fault. detach() deliberately gives the slot back
  // while leaving the request on the wire, so fewer slots than inflight
  // entries is by design; more slots than requests is a release that never
  // ran.
  if (activeCount > inflight.length) {
    add(
      INVARIANT.SlotLeak,
      `${activeCount} slots held but only ${inflight.length} request(s) on the wire — a slot was never released`,
    )
  }

  // --- queue and entry agreement ----------------------------------------

  const queuedIds = new Set(queue.map((item) => item.messageId))
  const entryById = new Map(entries.map((entry) => [entry.messageId, entry]))

  for (const entry of entries) {
    if (entry.status === 'queued' && !queuedIds.has(entry.messageId)) {
      add(
        INVARIANT.OrphanQueued,
        'shows as queued with no job behind it — this row will say Queued forever',
        entry.messageId,
      )
    }
  }

  for (const item of queue) {
    const entry = entryById.get(item.messageId)
    if (entry?.status !== 'queued') {
      add(
        INVARIANT.GhostQueued,
        `sits in the queue while its entry reads "${entry?.status ?? 'idle'}" — the job will run for a state nobody is waiting on`,
        item.messageId,
      )
    }
  }

  // 0 means "no ceiling", matching the queue's own reading of it. And only
  // automatic jobs count: an explicit request is never refused, so a
  // saturated gate legitimately queues more manual jobs than the ceiling —
  // counting them made this checker cry wolf on promised behaviour.
  const autoQueued = queue.filter((item) => item.origin === 'auto').length
  if (config.maxQueueLength && autoQueued > config.maxQueueLength) {
    add(
      INVARIANT.QueueOverLimit,
      `${autoQueued} automatic jobs queued against a declared ceiling of ${config.maxQueueLength}`,
    )
  }

  // --- progress ----------------------------------------------------------

  for (const job of inflight) {
    const age = now - job.sentAt
    if (age > stallMs) {
      add(
        INVARIANT.StalledJob,
        `on the wire for ${age}ms with no reply — its slot is held for as long as this lasts`,
        job.messageId,
      )
    }
  }

  const hasManual = queue.some((item) => item.origin !== 'auto')
  const hasAuto = queue.some((item) => item.origin === 'auto')
  const totalFree = config.maxConcurrent == null || activeCount < config.maxConcurrent
  const autoFree = config.maxConcurrentAuto == null || activeAutoCount < config.maxConcurrentAuto
  // A job that is allowed to run right now and still is not running means the
  // pump was never driven. Both gates have to be checked: a full automatic
  // sub-gate is a legitimate reason for automatic work to wait, and flagging
  // it would drown the real case.
  if ((hasManual && totalFree) || (hasAuto && totalFree && autoFree)) {
    add(
      INVARIANT.QueueNotDraining,
      `${queue.length} job(s) waiting with a free slot (active=${activeCount}/${config.maxConcurrent}, auto=${activeAutoCount}/${config.maxConcurrentAuto}) — pump() did not run`,
    )
  }

  // --- observer consistency ---------------------------------------------

  const registered = new Set(registeredIds)
  for (const id of visibleIds) {
    if (!registered.has(id)) {
      add(
        INVARIANT.VisibleNotRegistered,
        'counted as visible but no longer registered — it stays eligible for translation forever',
        id,
      )
    }
  }

  return violations
}
