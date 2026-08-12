import { describe, expect, test, vi } from 'vitest'
import { AUTO_TRANSLATE_CONFIG, SKIP, createAutoPolicy } from './autoPolicy'
import { createDecisionLog } from './decisionLog'

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
    log: overrides.log,
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

describe('the policy never throws', () => {
  test('a rejecting store read resolves as a logged skip, not an unhandled rejection', async () => {
    // The dwell timer and the sweep interval both call onCandidate without a
    // catch. A broken IndexedDB (private browsing, exhausted quota) rejects
    // the very first cache read inside ensureForView — and would turn into
    // one unhandled rejection per second, forever.
    const log = createDecisionLog()
    const { policy, ensureForView } = makePolicy({ log })
    ensureForView.mockRejectedValue(Object.assign(new Error('idb gone'), { name: 'QuotaExceededError' }))

    await expect(policy.onCandidate('m1')).resolves.toMatchObject({
      skipped: SKIP.InternalError,
    })
    expect(log.records().at(-1)).toMatchObject({ kind: 'skip', reason: SKIP.InternalError })
  })

  test('an internal error does not feed the circuit breaker', async () => {
    // The breaker models the BACKEND's health; a local cache failure says
    // nothing about it, and counting it would let a broken IDB switch
    // automatic translation off for a healthy backend.
    const { policy, ensureForView } = makePolicy()
    ensureForView.mockRejectedValue(new Error('idb gone'))

    for (let i = 0; i < 6; i += 1) await policy.onCandidate('m1')

    expect(policy.stats().consecutiveFailures).toBe(0)
    expect(policy.stats().circuitOpen).toBe(false)
  })
})

describe('sweep throughput and cost', () => {
  test('offers every idle message without waiting for translations to finish', async () => {
    // The sweep must hand out work, not chaperone it: onCandidate resolves
    // when the translation SETTLES, so awaiting it repairs one message per
    // tick instead of one sweep — a screen of 12 stranded messages takes 12
    // seconds against a fast backend instead of one.
    const h = makePolicy()
    for (const id of ['a', 'b', 'c']) {
      h.messages.set(id, message({ id }))
      h.visible.add(id)
    }
    h.ensureForView.mockImplementation(async () => ({
      outcome: 'queued',
      done: new Promise(() => {}),
      sent: Promise.resolve(true),
    }))

    await h.policy.recheckVisible()

    expect(h.ensureForView).toHaveBeenCalledTimes(3)
  })

  test('a disabled switch costs no log records per tick', async () => {
    // The sweep fires every second for as long as the page lives. Logging a
    // skip per visible message per tick while auto is simply off would churn
    // the decision log's whole buffer in about four minutes — evicting
    // exactly the history a diagnosis needs.
    const log = createDecisionLog()
    const h = makePolicy({ log, context: { autoTranslate: false } })
    h.visible.add('m1')

    await h.policy.recheckVisible()

    expect(h.ensureForView).not.toHaveBeenCalled()
    expect(log.records()).toHaveLength(0)
  })

  test('a hidden page costs no log records per tick', async () => {
    const log = createDecisionLog()
    const h = makePolicy({ log, context: { active: false } })
    h.visible.add('m1')

    await h.policy.recheckVisible()

    expect(h.ensureForView).not.toHaveBeenCalled()
    expect(log.records()).toHaveLength(0)
  })
})

describe('probe concurrency', () => {
  test('while one probe is in flight, further candidates stay blocked', async () => {
    // The sequential probe test cannot see this: it lets each probe settle
    // before the next candidate arrives, so the re-opened circuit does the
    // blocking. The guard exists for the CONCURRENT case — cooldown elapsed,
    // probe still on the wire — where without it every candidate on screen
    // probes the recovering backend at once. Mutation testing found the gap.
    const h = makePolicy({ config: { failureCircuitThreshold: 2 } })
    for (const id of ['a', 'b', 'c']) h.messages.set(id, message({ id }))

    h.ensureForView.mockImplementation(async () => ({
      outcome: 'queued',
      done: Promise.reject(Object.assign(new Error('boom'), { code: 'internal' })),
      sent: Promise.resolve(true),
    }))
    await h.policy.onCandidate('a')
    await h.policy.onCandidate('a')
    expect(h.policy.stats().circuitOpen).toBe(true)

    h.advance(30_001)
    // The probe's translation never settles — it is still on the wire when
    // the next candidates arrive.
    h.ensureForView.mockImplementation(async () => ({
      outcome: 'queued',
      done: new Promise(() => {}),
      sent: Promise.resolve(true),
    }))
    h.ensureForView.mockClear()

    const probe = h.policy.onCandidate('a')
    const second = await h.policy.onCandidate('b')
    const third = await h.policy.onCandidate('c')

    expect(h.ensureForView).toHaveBeenCalledTimes(1)
    expect(second.skipped).toBe(SKIP.CircuitOpen)
    expect(third.skipped).toBe(SKIP.CircuitOpen)
    void probe
  })
})

describe('probe token release', () => {
  // The circuit breaker lets exactly one request through once its cooldown
  // elapses. That permission is a token: claimed when the probe is allowed
  // out, returned when it settles. Every one of these tests fails if a path
  // claims the token and then declines to send, because the token is never
  // returned and the breaker stays open with the backend healthy.
  function opened(config = {}) {
    const h = makePolicy({
      config: { failureCircuitThreshold: 2, failureCircuitCooldownMs: 30_000, ...config },
    })
    h.fail = () =>
      h.ensureForView.mockImplementation(async () => ({
        outcome: 'queued',
        done: Promise.reject(Object.assign(new Error('boom'), { code: 'internal' })),
        sent: Promise.resolve(true),
      }))
    h.succeed = () =>
      h.ensureForView.mockImplementation(async () => ({
        outcome: 'queued',
        done: Promise.resolve(),
        sent: Promise.resolve(true),
      }))
    return h
  }

  test('a rate limit that declines the probe does not consume it', async () => {
    // maxRequestsPerMinute is reached by the same two failures that open the
    // circuit, so the first post-cooldown candidate is refused by the rate
    // limit rather than by the breaker.
    const h = opened({ maxRequestsPerMinute: 2 })
    h.fail()
    await h.policy.onCandidate('m1')
    await h.policy.onCandidate('m1')
    expect(h.policy.stats().circuitOpen).toBe(true)

    h.advance(30_001)
    expect((await h.policy.onCandidate('m1')).skipped).toBe(SKIP.RateLimited)

    // Rate window has now passed; the breaker's cooldown passed long ago.
    // Nothing is left to block a probe — unless the refusal above quietly
    // took the token with it.
    h.advance(30_001)
    h.succeed()
    h.ensureForView.mockClear()
    await h.policy.onCandidate('m1')
    expect(h.ensureForView).toHaveBeenCalledTimes(1)
    expect(h.policy.stats().circuitOpen).toBe(false)
  })

  test('a probe that throws before it is sent does not consume it', async () => {
    // The broken-IndexedDB case: a local fault, which must neither feed the
    // breaker nor strand its probe token.
    const h = opened()
    h.fail()
    await h.policy.onCandidate('m1')
    await h.policy.onCandidate('m1')

    h.advance(30_001)
    h.ensureForView.mockImplementation(async () => {
      throw new Error('IndexedDB is closing')
    })
    expect((await h.policy.onCandidate('m1')).skipped).toBe(SKIP.InternalError)

    h.succeed()
    h.ensureForView.mockClear()
    await h.policy.onCandidate('m1')
    expect(h.ensureForView).toHaveBeenCalledTimes(1)
    expect(h.policy.stats().circuitOpen).toBe(false)
  })

  test('the sweep reads the breaker without consuming the probe', async () => {
    // recheckVisible consults the breaker to stay silent while it is open.
    // That read must be a question, not a claim: here the cooldown has
    // elapsed and nothing on screen is eligible for re-offering, so the sweep
    // does no work at all — and must still leave the probe for the next real
    // candidate. A sweep that claimed the token would take one per second and
    // send none of them, so the circuit could never close.
    const h = opened()
    h.fail()
    await h.policy.onCandidate('m1')
    await h.policy.onCandidate('m1')

    h.advance(30_001)
    h.visible.add('m1')
    // Not idle: the per-message loop skips it, leaving only the gates.
    h.entries.set('m1', { status: 'translated', reqSeq: 0 })
    for (let tick = 0; tick < 10; tick += 1) await h.policy.recheckVisible()

    h.entries.delete('m1')
    h.succeed()
    h.ensureForView.mockClear()
    await h.policy.onCandidate('m1')
    expect(h.ensureForView).toHaveBeenCalledTimes(1)
  })
})

describe('sweep log volume', () => {
  test('stays silent while the circuit is open', async () => {
    // The sweep fires once a second for the life of the page. A per-message
    // skip while the breaker is open churns the decision log's whole buffer
    // in minutes, evicting the failures that opened it — the one piece of
    // history a diagnosis needs.
    const log = createDecisionLog({ printing: false })
    const h = makePolicy({
      config: { failureCircuitThreshold: 2, failureCircuitCooldownMs: 30_000 },
      messages: [message({ id: 'a' }), message({ id: 'b' }), message({ id: 'c' })],
      log,
    })
    h.ensureForView.mockImplementation(async () => ({
      outcome: 'queued',
      done: Promise.reject(Object.assign(new Error('boom'), { code: 'internal' })),
      sent: Promise.resolve(true),
    }))
    await h.policy.onCandidate('a')
    await h.policy.onCandidate('a')
    expect(h.policy.stats().circuitOpen).toBe(true)

    h.visible.add('a')
    h.visible.add('b')
    h.visible.add('c')
    const before = log.records().length
    for (let tick = 0; tick < 10; tick += 1) await h.policy.recheckVisible()

    expect(log.records().length).toBe(before)
  })

  test('stays silent while the rate limit is saturated', async () => {
    const log = createDecisionLog({ printing: false })
    const h = makePolicy({
      config: { maxRequestsPerMinute: 1 },
      messages: [message({ id: 'a' }), message({ id: 'b' })],
      log,
    })
    await h.policy.onCandidate('a')

    h.visible.add('a')
    h.visible.add('b')
    const before = log.records().length
    for (let tick = 0; tick < 10; tick += 1) await h.policy.recheckVisible()

    expect(log.records().length).toBe(before)
  })
})

// The repair sweep re-offers every idle visible message once a second. For a
// message that can never be translated — a sticker, your own post — the answer
// is the same every time, so the sweep spends a store read, the whole rule
// chain and a log line per message per second, forever. For one the user
// reverted, it spends an IndexedDB read on top of that.
describe('the sweep stops re-asking questions whose answer cannot have changed', () => {
  function sweepTwice(h) {
    h.visible.add('m1')
    return h.policy.recheckVisible().then(() => h.policy.recheckVisible())
  }

  test.each([
    ['non-textual', message({ content: '😀🎉' })],
    ['own message', message({ sender: { account: 'alice' } })],
    ['system message', message({ sysMsgData: { type: 'join' } })],
  ])('a permanent %s skip is evaluated once, not once per sweep', async (_name, msg) => {
    const h = makePolicy({ messages: [msg] })
    const reads = vi.spyOn(h.store, 'getEntry')

    await sweepTwice(h)

    // One store read, from the first sweep. The second recognises the id
    // before it touches anything.
    expect(reads).toHaveBeenCalledTimes(1)
  })

  test('a reverted message costs one intent read, not one per sweep', async () => {
    // `suppressed` is how ensureForView reports intent === 'off'. Reaching it
    // means an IndexedDB transaction, and the answer only changes when the
    // user presses a button.
    const h = makePolicy()
    h.ensureForView.mockResolvedValue({ outcome: 'suppressed' })

    await sweepTwice(h)

    expect(h.ensureForView).toHaveBeenCalledTimes(1)
  })

  test('editing a message re-opens it', async () => {
    // The whole reason the memo cannot be keyed on id alone: a sticker edited
    // to add words becomes translatable, and the store sets the entry back to
    // idle precisely so the sweep picks it up again.
    const h = makePolicy({ messages: [message({ content: '😀', editedAt: 0 })] })
    h.visible.add('m1')
    await h.policy.recheckVisible()

    h.messages.set('m1', message({ content: '😀 morning', editedAt: 7 }))
    await h.policy.recheckVisible()

    expect(h.ensureForView).toHaveBeenCalledTimes(1)
  })

  test('forgetting a message re-opens it', async () => {
    // What the manual Translate / See original buttons call: the user just
    // changed the answer the memo is holding.
    const h = makePolicy()
    h.ensureForView.mockResolvedValue({ outcome: 'suppressed' })
    await sweepTwice(h)

    h.policy.forget('m1')
    await h.policy.recheckVisible()

    expect(h.ensureForView).toHaveBeenCalledTimes(2)
  })

  test('an unknown message is never memoised', async () => {
    // A message can be absent for a moment while the list is still filling in.
    // Memoising that would strand it for as long as it stays on screen.
    const h = makePolicy({ messages: [] })
    h.visible.add('m1')
    await h.policy.recheckVisible()

    h.messages.set('m1', message())
    await h.policy.recheckVisible()

    expect(h.ensureForView).toHaveBeenCalledTimes(1)
  })

  test('a translatable message is still re-offered every sweep', async () => {
    // The repair path itself. A message left idle by a full queue has to keep
    // coming back — memoising it would silently disable the sweep.
    const h = makePolicy()
    h.ensureForView.mockResolvedValue({ outcome: 'dropped', sent: Promise.resolve(false) })

    await sweepTwice(h)

    expect(h.ensureForView).toHaveBeenCalledTimes(2)
  })
})
