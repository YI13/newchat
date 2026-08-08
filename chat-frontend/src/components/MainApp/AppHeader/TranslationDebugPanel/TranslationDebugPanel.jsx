import { useState } from 'react'
import { useTranslationDiagnostics } from '@/context/TranslationContext'
import './style.css'

/**
 * Live view of the automatic-translation queue.
 *
 * The whole feature fails silently: when it goes wrong, messages simply stay
 * in their source language and nothing in the UI says why. This panel makes
 * the two things that decide that outcome — what the queue is doing, and what
 * the observer thinks is on screen — directly visible.
 *
 * The collapsed pill is the part that matters day to day: counters that move,
 * and a marker when an invariant has broken.
 */

function ago(t, now) {
  if (t == null) return '-'
  const ms = now - t
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fields(record) {
  return Object.entries(record)
    .filter(
      ([key, value]) =>
        !['seq', 't', 'kind', 'messageId'].includes(key) &&
        value !== undefined &&
        value !== null &&
        value !== '',
    )
    .map(([key, value]) => `${key}=${value instanceof Error ? (value.code ?? value.name) : value}`)
    .join(' ')
}

export default function TranslationDebugPanel() {
  const { available, log, snapshot, violations, records, printing } = useTranslationDiagnostics()
  const [open, setOpen] = useState(false)

  if (!available || !snapshot) return null

  const now = Date.now()
  const { config, activeCount, activeAutoCount, queue, inflight, entries, visibleIds } = snapshot
  const waiting = entries.filter((e) => e.status === 'queued' || e.status === 'loading')

  return (
    <div className="tdp">
      <button
        type="button"
        className={`tdp-pill${violations.length ? ' tdp-pill-alert' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Automatic translation queue"
        aria-expanded={open}
      >
        ⇄ {activeCount}/{config.maxConcurrent}
        <span className="tdp-sep">·</span>a{activeAutoCount}/{config.maxConcurrentAuto}
        <span className="tdp-sep">·</span>q{queue.length}
        <span className="tdp-sep">·</span>👁{visibleIds.length}
        {violations.length > 0 && <span className="tdp-alert-dot">●</span>}
      </button>

      {open && (
        <div className="tdp-panel">
          <div className="tdp-actions">
            <button type="button" onClick={() => log.setPrinting(!printing)}>
              {printing ? 'Stop console' : 'Print to console'}
            </button>
            <button type="button" onClick={() => navigator.clipboard?.writeText(log.export())}>
              Copy JSON
            </button>
            <button type="button" onClick={() => log.clear()}>
              Clear
            </button>
          </div>

          {violations.length > 0 && (
            <section className="tdp-section tdp-violations">
              <h4>Broken invariants</h4>
              {violations.map((v) => (
                <div key={`${v.code}:${v.messageId ?? ''}`} className="tdp-violation">
                  <code>{v.code}</code> {v.messageId ? <b>{v.messageId}</b> : null} {v.detail}
                </div>
              ))}
            </section>
          )}

          <section className="tdp-section">
            <h4>
              In progress ({waiting.length}) · on the wire ({inflight.length})
            </h4>
            {waiting.length === 0 && <div className="tdp-empty">nothing pending</div>}
            {waiting.map((entry) => {
              const job = inflight.find((j) => j.messageId === entry.messageId)
              const queued = queue.find((q) => q.messageId === entry.messageId)
              return (
                <div key={entry.messageId} className="tdp-row">
                  <span className={`tdp-status tdp-status-${entry.status}`}>{entry.status}</span>
                  <b>{entry.messageId}</b>
                  <span className="tdp-dim">
                    {job
                      ? `on wire ${ago(job.sentAt, now)}`
                      : queued
                        ? `waiting ${ago(queued.enqueuedAt, now)} (${queued.origin})`
                        : `no job — ${ago(entry.since, now)}`}
                  </span>
                </div>
              )
            })}
          </section>

          <section className="tdp-section">
            <h4>Decisions</h4>
            {records.length === 0 && <div className="tdp-empty">nothing recorded yet</div>}
            {records.map((r) => (
              <div key={r.seq} className="tdp-record">
                <span className={`tdp-kind tdp-kind-${r.kind}`}>{r.kind}</span>
                <b>{r.messageId ?? '-'}</b>
                <span className="tdp-dim">{fields(r)}</span>
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  )
}
