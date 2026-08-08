import { describe, expect, test } from 'vitest'
import { INVARIANT, checkInvariants } from './invariants'

const NOW = 1_000_000

function snap(overrides = {}) {
  return {
    config: { maxConcurrent: 4, maxConcurrentAuto: 2, maxQueueLength: 50 },
    activeCount: 0,
    activeAutoCount: 0,
    queue: [],
    inflight: [],
    entries: [],
    visibleIds: [],
    registeredIds: [],
    ...overrides,
  }
}

const codes = (violations) => violations.map((v) => v.code)

describe('a healthy snapshot', () => {
  test('reports nothing', () => {
    expect(checkInvariants(snap(), { now: NOW })).toEqual([])
  })

  test('a saturated automatic sub-gate is not a fault', () => {
    // Two automatic jobs running and more waiting is the design working.
    // Flagging it would bury the real faults in noise.
    const violations = checkInvariants(
      snap({
        activeCount: 2,
        activeAutoCount: 2,
        queue: [{ messageId: 'm3', origin: 'auto', enqueuedAt: NOW }],
        inflight: [
          { messageId: 'm1', sentAt: NOW },
          { messageId: 'm2', sentAt: NOW },
        ],
        entries: [
          { messageId: 'm1', status: 'loading', since: NOW },
          { messageId: 'm2', status: 'loading', since: NOW },
          { messageId: 'm3', status: 'queued', since: NOW },
        ],
      }),
      { now: NOW },
    )

    expect(violations).toEqual([])
  })
})

describe('slot accounting', () => {
  test('catches a counter driven below zero by a double release', () => {
    const violations = checkInvariants(snap({ activeCount: -1 }), { now: NOW })

    expect(codes(violations)).toContain(INVARIANT.NegativeActive)
  })

  test('catches more in flight than the concurrency ceiling allows', () => {
    const violations = checkInvariants(snap({ activeCount: 5, inflight: [] }), { now: NOW })

    expect(codes(violations)).toContain(INVARIANT.OverConcurrency)
  })

  test('catches the automatic sub-gate being exceeded', () => {
    const violations = checkInvariants(snap({ activeCount: 3, activeAutoCount: 3 }), {
      now: NOW,
    })

    expect(codes(violations)).toContain(INVARIANT.OverAutoConcurrency)
  })

  test('catches an automatic count larger than the total', () => {
    const violations = checkInvariants(snap({ activeCount: 1, activeAutoCount: 2 }), {
      now: NOW,
    })

    expect(codes(violations)).toContain(INVARIANT.AutoExceedsTotal)
  })

  test('catches a leaked slot: the counter says busy but nothing is on the wire', () => {
    // The signature failure of a release that did not run — the queue stops
    // for good and every symptom points somewhere else.
    const violations = checkInvariants(
      snap({ activeCount: 2, inflight: [{ messageId: 'm1', sentAt: NOW }] }),
      { now: NOW },
    )

    expect(codes(violations)).toContain(INVARIANT.SlotLeak)
  })
})

describe('queue and entry agreement', () => {
  test("catches an entry stuck at 'queued' with no job behind it", () => {
    // What a user sees as a row that says Queued forever.
    const violations = checkInvariants(
      snap({ entries: [{ messageId: 'm1', status: 'queued', since: NOW }] }),
      { now: NOW },
    )

    expect(codes(violations)).toContain(INVARIANT.OrphanQueued)
    expect(violations.find((v) => v.code === INVARIANT.OrphanQueued).messageId).toBe('m1')
  })

  test('catches a queued job whose entry has moved on', () => {
    const violations = checkInvariants(
      snap({
        queue: [{ messageId: 'm1', origin: 'auto', enqueuedAt: NOW }],
        entries: [{ messageId: 'm1', status: 'idle', since: NOW }],
      }),
      { now: NOW },
    )

    expect(codes(violations)).toContain(INVARIANT.GhostQueued)
  })

  test('catches the queue growing past its declared ceiling', () => {
    const queue = Array.from({ length: 51 }, (_, i) => ({
      messageId: `m${i}`,
      origin: 'auto',
      enqueuedAt: NOW,
    }))
    const entries = queue.map((q) => ({ messageId: q.messageId, status: 'queued', since: NOW }))

    const violations = checkInvariants(
      snap({ queue, entries, activeAutoCount: 2, activeCount: 2 }),
      { now: NOW },
    )

    expect(codes(violations)).toContain(INVARIANT.QueueOverLimit)
  })

  test('a ceiling of zero means no ceiling, not a ceiling of zero', () => {
    // The queue reads 0 as "unbounded". Reading it as a limit here would
    // report every single queued job as a broken invariant.
    const queue = Array.from({ length: 30 }, (_, i) => ({
      messageId: `m${i}`,
      origin: 'auto',
      enqueuedAt: NOW,
    }))
    const entries = queue.map((q) => ({ messageId: q.messageId, status: 'queued', since: NOW }))

    const violations = checkInvariants(
      snap({
        config: { maxConcurrent: 4, maxConcurrentAuto: 2, maxQueueLength: 0 },
        queue,
        entries,
        activeCount: 2,
        activeAutoCount: 2,
      }),
      { now: NOW },
    )

    expect(codes(violations)).not.toContain(INVARIANT.QueueOverLimit)
  })
})

describe('progress', () => {
  test('catches a job that has been on the wire past the stall threshold', () => {
    const violations = checkInvariants(
      snap({
        activeCount: 1,
        activeAutoCount: 1,
        inflight: [{ messageId: 'm1', sentAt: NOW - 31_000 }],
        entries: [{ messageId: 'm1', status: 'loading', since: NOW - 31_000 }],
      }),
      { now: NOW, stallMs: 30_000 },
    )

    const stalled = violations.find((v) => v.code === INVARIANT.StalledJob)
    expect(stalled).toBeDefined()
    expect(stalled.messageId).toBe('m1')
    expect(stalled.detail).toMatch(/31000|31s/)
  })

  test('a job inside the threshold is left alone', () => {
    const violations = checkInvariants(
      snap({
        activeCount: 1,
        activeAutoCount: 1,
        inflight: [{ messageId: 'm1', sentAt: NOW - 5_000 }],
        entries: [{ messageId: 'm1', status: 'loading', since: NOW - 5_000 }],
      }),
      { now: NOW, stallMs: 30_000 },
    )

    expect(codes(violations)).not.toContain(INVARIANT.StalledJob)
  })

  test('catches a queue that is not draining although slots are free', () => {
    // Free capacity plus a runnable job means pump() was never called, or
    // returned early. Nothing else in the UI shows this.
    const violations = checkInvariants(
      snap({
        activeCount: 0,
        activeAutoCount: 0,
        queue: [{ messageId: 'm1', origin: 'auto', enqueuedAt: NOW - 5_000 }],
        entries: [{ messageId: 'm1', status: 'queued', since: NOW - 5_000 }],
      }),
      { now: NOW },
    )

    expect(codes(violations)).toContain(INVARIANT.QueueNotDraining)
  })

  test('a manual job waiting behind a full total gate is not flagged', () => {
    const violations = checkInvariants(
      snap({
        activeCount: 4,
        activeAutoCount: 2,
        queue: [{ messageId: 'm9', origin: 'manual', enqueuedAt: NOW }],
        entries: [{ messageId: 'm9', status: 'queued', since: NOW }],
        inflight: Array.from({ length: 4 }, (_, i) => ({ messageId: `x${i}`, sentAt: NOW })),
      }),
      { now: NOW },
    )

    expect(codes(violations)).not.toContain(INVARIANT.QueueNotDraining)
  })

  test('a manual job waiting while slots are free IS flagged', () => {
    const violations = checkInvariants(
      snap({
        activeCount: 1,
        activeAutoCount: 1,
        queue: [{ messageId: 'm9', origin: 'manual', enqueuedAt: NOW }],
        entries: [{ messageId: 'm9', status: 'queued', since: NOW }],
        inflight: [{ messageId: 'm1', sentAt: NOW }],
      }),
      { now: NOW },
    )

    expect(codes(violations)).toContain(INVARIANT.QueueNotDraining)
  })
})

describe('observer consistency', () => {
  test('catches a message counted visible that is no longer registered', () => {
    // unobserve() that forgot to clear the visible set: the id then stays
    // eligible forever and the queue keeps picking a message nobody can see.
    const violations = checkInvariants(snap({ visibleIds: ['m1'], registeredIds: [] }), {
      now: NOW,
    })

    expect(codes(violations)).toContain(INVARIANT.VisibleNotRegistered)
  })

  test('a registered message that is not visible is perfectly normal', () => {
    const violations = checkInvariants(snap({ visibleIds: [], registeredIds: ['m1', 'm2'] }), {
      now: NOW,
    })

    expect(violations).toEqual([])
  })
})

describe('reporting shape', () => {
  test('every violation carries a code and a human-readable detail', () => {
    const violations = checkInvariants(snap({ activeCount: -1, activeAutoCount: -2 }), {
      now: NOW,
    })

    expect(violations.length).toBeGreaterThan(0)
    for (const violation of violations) {
      expect(typeof violation.code).toBe('string')
      expect(violation.detail.length).toBeGreaterThan(0)
    }
  })

  test('is a pure read: the snapshot is not modified', () => {
    const snapshot = snap({ activeCount: -1 })
    const before = JSON.stringify(snapshot)

    checkInvariants(snapshot, { now: NOW })

    expect(JSON.stringify(snapshot)).toBe(before)
  })
})
