import { describe, expect, test, vi } from 'vitest'
import { AUTO_TRANSLATE_CONFIG, SKIP, createAutoPolicy } from './autoPolicy'

function message(overrides = {}) {
  return {
    id: 'm1',
    content: 'Morning everyone',
    sender: { account: 'bob' },
    editedAt: 0,
    ...overrides,
  }
}

function makePolicy(overrides = {}) {
  const messages = new Map((overrides.messages ?? [message()]).map((m) => [m.id, m]))
  const ensureForView = vi.fn(async () => ({
    outcome: 'queued',
    done: Promise.resolve(),
    // The default is a job that reaches the backend. Tests about dropped jobs
    // override this.
    sent: Promise.resolve(true),
  }))
  const entries = new Map()
  const visible = new Set()
  const store = {
    ensureForView,
    detach: vi.fn(),
    getEntry: (id) => entries.get(id) ?? { status: 'idle', reqSeq: 0 },
  }

  let clock = 1_000_000
  const now = () => clock

  const policy = createAutoPolicy({
    store,
    getVisibleIds: () => visible,
    getMessage: (id) => messages.get(id),
    getContext: () => ({
      roomId: 'r1',
      targetLang: 'ja',
      autoTranslate: true,
      currentUserAccount: 'alice',
      active: true,
      ...overrides.context,
    }),
    config: overrides.config,
    now,
  })

  return {
    policy,
    store,
    ensureForView,
    messages,
    entries,
    visible,
    advance: (ms) => {
      clock += ms
    },
  }
}

describe('config', () => {
  test('carries the documented defaults', () => {
    expect(AUTO_TRANSLATE_CONFIG).toMatchObject({
      dwellMs: 400,
      prefetchMarginPx: 0,
      maxConcurrent: 4,
      maxConcurrentAuto: 2,
      // Safe to bound again now that recheckVisible re-offers idle-but-
      // visible messages: a refusal is repaired by the next sweep instead of
      // stranding the row until it leaves and re-enters the viewport.
      maxQueueLength: 50,
      recheckIntervalMs: 1000,
      maxRequestsPerMinute: 60,
      failureCircuitThreshold: 5,
      failureCircuitCooldownMs: 30_000,
      timeoutMs: 15_000,
      skipNonTextual: true,
    })
  })

  test('keeps the automatic sub-gate strictly below the overall limit', () => {
    // Were these equal, background work could fill every slot and a click
    // would wait behind it.
    expect(AUTO_TRANSLATE_CONFIG.maxConcurrentAuto).toBeLessThan(
      AUTO_TRANSLATE_CONFIG.maxConcurrent,
    )
  })
})

describe('skip rules', () => {
  test('translates an ordinary message from someone else', async () => {
    const { policy, ensureForView } = makePolicy()
    const result = await policy.onCandidate('m1')

    expect(result.skipped).toBeUndefined()
    expect(ensureForView).toHaveBeenCalledTimes(1)
  })

  test('skips your own messages', async () => {
    const { policy, ensureForView } = makePolicy({
      messages: [message({ sender: { account: 'alice' } })],
    })

    expect((await policy.onCandidate('m1')).skipped).toBe(SKIP.OwnMessage)
    expect(ensureForView).not.toHaveBeenCalled()
  })

  test('skips system messages', async () => {
    const { policy } = makePolicy({
      messages: [message({ sysMsgData: { kind: 'room_created' } })],
    })

    expect((await policy.onCandidate('m1')).skipped).toBe(SKIP.SystemMessage)
  })

  test('skips a body with no letters at all', async () => {
    const { policy } = makePolicy({ messages: [message({ content: '👍 123 !!!' })] })

    expect((await policy.onCandidate('m1')).skipped).toBe(SKIP.NonTextual)
  })

  test('keeps a body whose letters are non-Latin', async () => {
    const { policy, ensureForView } = makePolicy({
      messages: [message({ content: '早安' })],
    })

    await policy.onCandidate('m1')
    expect(ensureForView).toHaveBeenCalled()
  })

  test('skips a message it cannot resolve', async () => {
    const { policy } = makePolicy()
    expect((await policy.onCandidate('ghost')).skipped).toBe(SKIP.UnknownMessage)
  })

  test('skips everything while the global switch is off', async () => {
    const { policy, ensureForView } = makePolicy({ context: { autoTranslate: false } })

    expect((await policy.onCandidate('m1')).skipped).toBe(SKIP.AutoDisabled)
    expect(ensureForView).not.toHaveBeenCalled()
  })

  test('skips while the room or tab is not the active surface', async () => {
    const { policy } = makePolicy({ context: { active: false } })
    expect((await policy.onCandidate('m1')).skipped).toBe(SKIP.Inactive)
  })

  test('runs the rules in order, so the cheapest gate wins', async () => {
    // Own + system + non-textual all apply; the first rule is the one
    // reported. Order matters because the rules get more expensive as the
    // language-detection step lands between dwell and the queue.
    const { policy } = makePolicy({
      messages: [message({ sender: { account: 'alice' }, sysMsgData: {}, content: '123' })],
    })
    expect((await policy.onCandidate('m1')).skipped).toBe(SKIP.OwnMessage)
  })
})

describe('requests-per-minute ceiling', () => {
  test('stops issuing once the window is full', async () => {
    const { policy, ensureForView, messages } = makePolicy({
      config: { maxRequestsPerMinute: 2 },
    })
    for (const id of ['a', 'b', 'c']) messages.set(id, message({ id }))

    await policy.onCandidate('a')
    await policy.onCandidate('b')
    const third = await policy.onCandidate('c')

    expect(third.skipped).toBe(SKIP.RateLimited)
    expect(ensureForView).toHaveBeenCalledTimes(2)
  })

  test('lets requests through again once the window slides past', async () => {
    const { policy, ensureForView, advance, messages } = makePolicy({
      config: { maxRequestsPerMinute: 1 },
    })
    for (const id of ['a', 'b']) messages.set(id, message({ id }))

    await policy.onCandidate('a')
    expect((await policy.onCandidate('b')).skipped).toBe(SKIP.RateLimited)

    advance(60_001)
    await policy.onCandidate('b')

    expect(ensureForView).toHaveBeenCalledTimes(2)
  })
})

describe('failure circuit', () => {
  function failing(overrides = {}) {
    const harness = makePolicy({
      config: { failureCircuitThreshold: 2, failureCircuitCooldownMs: 30_000 },
      ...overrides,
    })
    harness.fail = (code = 'internal') =>
      harness.ensureForView.mockImplementation(async () => ({
        outcome: 'queued',
        done: Promise.reject(Object.assign(new Error('boom'), { code })),
        sent: Promise.resolve(true),
      }))
    harness.succeed = () =>
      harness.ensureForView.mockImplementation(async () => ({
        outcome: 'queued',
        done: Promise.resolve(),
        sent: Promise.resolve(true),
      }))
    return harness
  }

  test('opens after consecutive failures and stops issuing requests', async () => {
    const h = failing()
    h.fail()

    await h.policy.onCandidate('m1')
    await h.policy.onCandidate('m1')
    h.ensureForView.mockClear()

    expect((await h.policy.onCandidate('m1')).skipped).toBe(SKIP.CircuitOpen)
    expect(h.ensureForView).not.toHaveBeenCalled()
  })

  test('a success resets the failure run', async () => {
    const h = failing()
    h.fail()
    await h.policy.onCandidate('m1')

    h.succeed()
    await h.policy.onCandidate('m1')

    h.fail()
    await h.policy.onCandidate('m1')

    // One failure before and one after a success must not add up to the
    // threshold — the circuit is about a sustained outage, not a tally.
    expect(h.policy.stats().circuitOpen).toBe(false)
  })

  test('a rejected input never counts against the circuit', async () => {
    const h = failing()
    h.fail('bad_request')

    await h.policy.onCandidate('m1')
    await h.policy.onCandidate('m1')
    await h.policy.onCandidate('m1')

    // Our own malformed request must not switch the feature off for the user.
    expect(h.policy.stats().circuitOpen).toBe(false)
  })

  test('probes once after the cooldown and re-opens on a further failure', async () => {
    const h = failing()
    h.fail()
    await h.policy.onCandidate('m1')
    await h.policy.onCandidate('m1')
    expect(h.policy.stats().circuitOpen).toBe(true)

    h.advance(30_001)
    h.ensureForView.mockClear()
    await h.policy.onCandidate('m1')
    expect(h.ensureForView).toHaveBeenCalledTimes(1)

    h.ensureForView.mockClear()
    expect((await h.policy.onCandidate('m1')).skipped).toBe(SKIP.CircuitOpen)
    expect(h.ensureForView).not.toHaveBeenCalled()
  })

  test('backs off exponentially while the outage persists', async () => {
    const h = failing()
    h.fail()
    await h.policy.onCandidate('m1')
    await h.policy.onCandidate('m1')

    h.advance(30_001)
    await h.policy.onCandidate('m1')

    // The failed probe must widen the window rather than retry every 30s.
    h.advance(30_001)
    expect((await h.policy.onCandidate('m1')).skipped).toBe(SKIP.CircuitOpen)
  })

  test('closes for good once a probe succeeds', async () => {
    const h = failing()
    h.fail()
    await h.policy.onCandidate('m1')
    await h.policy.onCandidate('m1')

    h.advance(30_001)
    h.succeed()
    await h.policy.onCandidate('m1')

    expect(h.policy.stats().circuitOpen).toBe(false)
    expect(h.policy.stats().consecutiveFailures).toBe(0)
  })

  test('declares that it does not gate manual requests', async () => {
    // The policy only governs the automatic path; manual requests never go
    // through onCandidate. Asserted so the boundary stays explicit if the
    // policy ever grows a manual entry point.
    const h = failing()
    expect(h.policy.gatesManualRequests).toBe(false)
  })
})

describe('outcome accounting', () => {
  test('a cache hit does not consume rate-limit budget', async () => {
    const { policy, ensureForView, messages } = makePolicy({
      config: { maxRequestsPerMinute: 1 },
    })
    ensureForView.mockImplementation(async () => ({ outcome: 'cached' }))
    for (const id of ['a', 'b']) messages.set(id, message({ id }))

    await policy.onCandidate('a')
    const second = await policy.onCandidate('b')

    expect(second.skipped).toBeUndefined()
  })

  test('a suppressed message does not consume rate-limit budget', async () => {
    const { policy, ensureForView, messages } = makePolicy({
      config: { maxRequestsPerMinute: 1 },
    })
    ensureForView.mockImplementation(async () => ({ outcome: 'suppressed' }))
    for (const id of ['a', 'b']) messages.set(id, message({ id }))

    await policy.onCandidate('a')
    expect((await policy.onCandidate('b')).skipped).toBeUndefined()
  })
})

describe('rate accounting follows real requests', () => {
  test('a job dropped before it was sent costs no budget', async () => {
    // Measured on a 100-message scroll before this changed: 60 candidates
    // accepted, 14 actually sent, and the remaining 46 charges exhausted a
    // 60-per-minute budget in about seven seconds. Every later candidate was
    // then silently rate-limited — automatic translation switching itself off
    // with nothing anywhere to say why.
    const { policy, ensureForView, messages } = makePolicy({
      config: { maxRequestsPerMinute: 2 },
    })
    for (const id of ['a', 'b', 'c', 'd']) messages.set(id, message({ id }))
    ensureForView.mockImplementation(async () => ({
      outcome: 'queued',
      done: Promise.resolve(),
      sent: Promise.resolve(false),
    }))

    for (const id of ['a', 'b', 'c', 'd']) await policy.onCandidate(id)

    expect(policy.stats().requestsInWindow).toBe(0)
    expect(ensureForView).toHaveBeenCalledTimes(4)
  })

  test('a job that reaches the backend does cost budget', async () => {
    const { policy, messages } = makePolicy({ config: { maxRequestsPerMinute: 10 } })
    for (const id of ['a', 'b']) messages.set(id, message({ id }))

    await policy.onCandidate('a')
    await policy.onCandidate('b')

    expect(policy.stats().requestsInWindow).toBe(2)
  })

  test('a dropped job does not reset the failure counter', async () => {
    // A drop is not evidence the backend recovered. Counting it as a success
    // lets a scroll full of dropped jobs hold the breaker open-eyed through
    // an outage.
    const h = makePolicy({ config: { failureCircuitThreshold: 2 } })
    for (const id of ['a', 'b', 'c']) h.messages.set(id, message({ id }))

    h.ensureForView.mockImplementation(async () => ({
      outcome: 'queued',
      done: Promise.reject(Object.assign(new Error('boom'), { code: 'internal' })),
      sent: Promise.resolve(true),
    }))
    await h.policy.onCandidate('a')
    expect(h.policy.stats().consecutiveFailures).toBe(1)

    h.ensureForView.mockImplementation(async () => ({
      outcome: 'queued',
      done: Promise.resolve(),
      sent: Promise.resolve(false),
    }))
    await h.policy.onCandidate('b')

    expect(h.policy.stats().consecutiveFailures).toBe(1)
  })
})

describe('re-offering what is still on screen', () => {
  // The gap this closes: the visibility observer raises a candidate once per
  // visibility transition. Anything that ends a job WITHOUT translating it —
  // a full queue, a slot lost to a race — leaves the message idle, on screen,
  // and with nothing left to re-trigger it. Measured before this existed: 10
  // of the 12 messages on screen stayed untranslated indefinitely.

  test('re-offers a message that is idle and still on screen', async () => {
    const h = makePolicy()
    h.visible.add('m1')

    await h.policy.recheckVisible()

    expect(h.ensureForView).toHaveBeenCalledTimes(1)
  })

  test('leaves a message that is already translated alone', async () => {
    const h = makePolicy()
    h.visible.add('m1')
    h.entries.set('m1', { status: 'translated', reqSeq: 1 })

    await h.policy.recheckVisible()

    expect(h.ensureForView).not.toHaveBeenCalled()
  })

  test('leaves a message that is queued or in flight alone', async () => {
    for (const status of ['queued', 'loading']) {
      const h = makePolicy()
      h.visible.add('m1')
      h.entries.set('m1', { status, reqSeq: 1 })

      await h.policy.recheckVisible()

      expect(h.ensureForView, status).not.toHaveBeenCalled()
    }
  })

  test('leaves a failed message alone, so a rejected body is not retried forever', async () => {
    // Without this the sweep becomes an infinite retry loop against the
    // backend for any message it will always refuse — and a bad_request never
    // trips the circuit breaker, so nothing else would stop it.
    const h = makePolicy()
    h.visible.add('m1')
    h.entries.set('m1', { status: 'failed', reqSeq: 1 })

    await h.policy.recheckVisible()

    expect(h.ensureForView).not.toHaveBeenCalled()
  })

  test('still obeys the skip rules', async () => {
    const h = makePolicy({ context: { autoTranslate: false } })
    h.visible.add('m1')

    await h.policy.recheckVisible()

    expect(h.ensureForView).not.toHaveBeenCalled()
  })

  test('does nothing when no visible set was wired in', async () => {
    const h = makePolicy()
    // The policy is usable without an observer — message rendering must not
    // depend on one.
    await expect(h.policy.recheckVisible()).resolves.toBeUndefined()
  })
})

describe('every declared knob is wired', () => {
  test('AUTO_TRANSLATE_CONFIG contains only keys something actually reads', () => {
    // Three defects this session were exactly this: a knob declared here,
    // read by nothing (timeoutMs, maxQueueLength before they were wired, and
    // scrollIdleMs from the out-of-scope T8). A declared-but-dead knob is
    // worse than none — it documents behaviour the code does not have.
    const wired = [
      'dwellMs', // visibilityObserver
      'prefetchMarginPx', // visibilityObserver
      'maxConcurrent', // store
      'maxConcurrentAuto', // store
      'maxQueueLength', // store
      'timeoutMs', // store
      'recheckIntervalMs', // TranslationProvider sweep
      'maxRequestsPerMinute', // autoPolicy
      'failureCircuitThreshold', // autoPolicy
      'failureCircuitCooldownMs', // autoPolicy
      'skipNonTextual', // autoPolicy
    ]
    expect(Object.keys(AUTO_TRANSLATE_CONFIG).sort()).toEqual([...wired].sort())
  })
})
