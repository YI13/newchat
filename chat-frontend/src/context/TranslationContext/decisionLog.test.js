import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DECISION, DECISION_LOG_CAP, createDecisionLog, formatRecord } from './decisionLog'

let clock = 0
const now = () => clock

beforeEach(() => {
  clock = 0
})

describe('recording', () => {
  test('keeps records in emission order with a monotonic sequence', () => {
    const log = createDecisionLog({ now })

    log.emit(DECISION.Dwell, 'm1')
    clock = 5
    log.emit(DECISION.Enqueue, 'm1', { origin: 'auto' })

    const records = log.records()
    expect(records.map((r) => r.kind)).toEqual([DECISION.Dwell, DECISION.Enqueue])
    expect(records.map((r) => r.seq)).toEqual([1, 2])
    expect(records[1].t).toBe(5)
    expect(records[1].origin).toBe('auto')
  })

  test('records even while printing is off', () => {
    const sink = vi.fn()
    const log = createDecisionLog({ now, sink, printing: false })

    log.emit(DECISION.Dwell, 'm1')

    // The buffer is the point: switching the panel on must show what already
    // happened, not start from empty.
    expect(log.records()).toHaveLength(1)
    expect(sink).not.toHaveBeenCalled()
  })

  test('prints once printing is switched on, and stops again when off', () => {
    const sink = vi.fn()
    const log = createDecisionLog({ now, sink })

    log.setPrinting(true)
    log.emit(DECISION.Send, 'm1', { targetLang: 'ja' })
    log.setPrinting(false)
    log.emit(DECISION.Send, 'm2', { targetLang: 'ja' })

    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0][0]).toContain('m1')
  })

  test('drops the oldest record once the buffer is full', () => {
    const log = createDecisionLog({ now, cap: 3 })

    for (let i = 0; i < 5; i += 1) log.emit(DECISION.Dwell, `m${i}`)

    expect(log.records().map((r) => r.messageId)).toEqual(['m2', 'm3', 'm4'])
  })

  test('a zero cap disables recording entirely', () => {
    const log = createDecisionLog({ now, cap: 0 })

    log.emit(DECISION.Dwell, 'm1')

    expect(log.records()).toEqual([])
  })

  test('ships a finite default cap, so an all-day session cannot grow unbounded', () => {
    expect(DECISION_LOG_CAP).toBeGreaterThan(0)
    expect(Number.isFinite(DECISION_LOG_CAP)).toBe(true)
  })
})

describe('subscribers', () => {
  test('are notified on every record', () => {
    const log = createDecisionLog({ now })
    const listener = vi.fn()

    const unsubscribe = log.subscribe(listener)
    log.emit(DECISION.Dwell, 'm1')
    unsubscribe()
    log.emit(DECISION.Dwell, 'm2')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('a throwing subscriber cannot break the instrumented code path', () => {
    const log = createDecisionLog({ now })
    log.subscribe(() => {
      throw new Error('render blew up')
    })

    // This is diagnostics. A panel that crashes must not take the translation
    // queue down with it.
    expect(() => log.emit(DECISION.Dwell, 'm1')).not.toThrow()
    expect(log.records()).toHaveLength(1)
  })
})

describe('timeline', () => {
  test('returns one message-s records in order, and nothing else', () => {
    const log = createDecisionLog({ now })

    log.emit(DECISION.Dwell, 'm1')
    log.emit(DECISION.Dwell, 'm2')
    log.emit(DECISION.Enqueue, 'm1')
    log.emit(DECISION.Settle, 'm1', { ok: true })

    expect(log.timeline('m1').map((r) => r.kind)).toEqual([
      DECISION.Dwell,
      DECISION.Enqueue,
      DECISION.Settle,
    ])
  })

  test('reports elapsed time from that message-s first record', () => {
    const log = createDecisionLog({ now })

    log.emit(DECISION.Dwell, 'm1')
    clock = 5000
    log.emit(DECISION.Settle, 'm1', { ok: true })

    expect(log.timeline('m1').map((r) => r.sinceFirst)).toEqual([0, 5000])
  })
})

describe('formatting', () => {
  test('leads with the kind and the message so a console scan lines up', () => {
    const line = formatRecord({
      seq: 7,
      t: 12,
      kind: DECISION.Skip,
      messageId: 'm1',
      reason: 'own-message',
    })

    expect(line).toMatch(/skip/)
    expect(line).toMatch(/m1/)
    expect(line).toMatch(/own-message/)
  })

  test('renders extra fields as key=value, skipping empty ones', () => {
    const line = formatRecord({
      seq: 1,
      t: 0,
      kind: DECISION.Enqueue,
      messageId: 'm1',
      origin: 'auto',
      queued: 6,
      error: undefined,
    })

    expect(line).toContain('origin=auto')
    expect(line).toContain('queued=6')
    expect(line).not.toContain('error')
  })

  test('never prints message bodies', () => {
    // Trace output gets pasted into issues and chat. Bodies are exactly what
    // must not travel with it.
    const line = formatRecord({
      seq: 1,
      t: 0,
      kind: DECISION.Send,
      messageId: 'm1',
      text: 'a private sentence',
      targetLang: 'ja',
    })

    expect(line).not.toContain('a private sentence')
    expect(line).toContain('targetLang=ja')
  })
})

describe('export', () => {
  test('produces parseable JSON of the buffer', () => {
    const log = createDecisionLog({ now })
    log.emit(DECISION.Dwell, 'm1')

    const parsed = JSON.parse(log.export())

    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0].kind).toBe(DECISION.Dwell)
  })

  test('clear empties the buffer but keeps the sequence moving', () => {
    const log = createDecisionLog({ now })
    log.emit(DECISION.Dwell, 'm1')
    log.clear()
    log.emit(DECISION.Dwell, 'm2')

    // Sequence numbers are how you tell "nothing happened" apart from
    // "records were dropped". Resetting them would hide the difference.
    expect(log.records().map((r) => r.seq)).toEqual([2])
  })
})
