// A decision log for automatic translation.
//
// Not OpenTelemetry (see lib/telemetry.ts for that): nothing here leaves the
// browser. This is a capped in-memory ring buffer answering one question —
// "why did this message not get translated?" — which no single module can
// answer alone. The visibility observer knows the element scrolled past; the
// policy knows the sender matched; the queue knows the slot was full. Each is
// individually correct and the message stays in its source language, so the
// only way to see the cause is to record the decisions in one place.
//
// Recording is always on; printing is not. The buffer costs one small object
// per decision and is what makes a panel switched on AFTER the symptom still
// useful.

export const DECISION_LOG_CAP = 2000

export const DECISION = {
  // visibility observer
  Observe: 'observe',
  Unobserve: 'unobserve',
  Visible: 'visible',
  Hidden: 'hidden',
  Dwell: 'dwell',
  // Not message-scoped: carries a null messageId. Suspending the tracker
  // stops every candidate at once, so without a marker the log just goes
  // quiet — indistinguishable from the registry going blind.
  Tracker: 'tracker',
  // policy
  Skip: 'skip',
  Cached: 'cached',
  Suppressed: 'suppressed',
  Deduped: 'deduped',
  // queue
  Enqueue: 'enqueue',
  Send: 'send',
  Drop: 'drop',
  Settle: 'settle',
  // health
  Violation: 'violation',
}

/** Never printed: identifiers already carried in their own column, and
 *  anything that could contain what the user actually wrote. */
const NEVER_PRINTED = new Set([
  'seq',
  't',
  'kind',
  'messageId',
  'sinceFirst',
  'text',
  'originalText',
  'translatedText',
  'content',
])

const KIND_WIDTH = 10

function renderValue(value) {
  if (value instanceof Error) return value.code ?? value.name ?? 'Error'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function formatRecord(record) {
  const kind = String(record.kind).padEnd(KIND_WIDTH)
  const fields = []
  for (const [key, value] of Object.entries(record)) {
    if (NEVER_PRINTED.has(key)) continue
    if (value === undefined || value === null || value === '') continue
    fields.push(`${key}=${renderValue(value)}`)
  }
  return `[translate] ${kind} ${record.messageId ?? '-'} ${fields.join(' ')}`.trimEnd()
}

export function createDecisionLog({
  cap = DECISION_LOG_CAP,
  printing = false,
  sink = (line) => console.debug(line),
  now = () => Date.now(),
} = {}) {
  const buffer = []
  const listeners = new Set()
  let seq = 0
  let isPrinting = printing

  function emit(kind, messageId, fields) {
    seq += 1
    const record = { seq, t: now(), kind, messageId, ...fields }

    if (cap > 0) {
      buffer.push(record)
      if (buffer.length > cap) buffer.splice(0, buffer.length - cap)
    }

    if (isPrinting) sink(formatRecord(record), record)

    // A subscriber is a React panel. It must not be able to fail the
    // translation call that happens to be emitting.
    for (const listener of listeners) {
      try {
        listener(record)
      } catch {
        // Diagnostics only — deliberately swallowed.
      }
    }
    return record
  }

  function timeline(messageId) {
    const mine = buffer.filter((r) => r.messageId === messageId)
    if (mine.length === 0) return []
    const start = mine[0].t
    return mine.map((r) => ({ ...r, sinceFirst: r.t - start }))
  }

  return {
    emit,
    timeline,
    records: () => [...buffer],
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setPrinting(value) {
      isPrinting = Boolean(value)
    },
    isPrinting: () => isPrinting,
    clear() {
      buffer.length = 0
    },
    export: () => JSON.stringify({ cap, records: buffer }, null, 2),
  }
}

/** A log that records nothing, for the modules' own unit tests and for any
 *  caller that would otherwise have to null-check every emit site. */
export const NOOP_DECISION_LOG = createDecisionLog({ cap: 0 })
