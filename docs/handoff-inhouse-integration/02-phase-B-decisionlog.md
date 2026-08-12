# Phase B — 決策軌跡 `decisionLog.ts`

**零行為變更。** 新增一個檔案、在三處接線。

## 為什麼要先做

Phase C/D 之後,絕大多數的決策是「**沒有**送出」。現在的三行 console.log
(`queued` / `start` / `done`)只記錄有發生的事,看不出「為什麼沒發生」——
而那正是這整個問題的形狀。沒有這一層,C 和 D 只能靠猜測驗證。

它同時是缺陷 #16 的載體:sweep 每秒觸發,一旦全域 gate 沒擋好,2000 筆的環形
緩衝區會在三分鐘內被同一種 skip 洗光。參考實作已經修好,但你要知道這個常數
存在的原因。

---

## B.1 完整檔案:`decisionLog.ts`

新增在 `visibilityTracker.ts` 同一層。

```ts
/**
 * A decision log for automatic translation.
 *
 * Not telemetry: nothing here leaves the browser. This is a capped in-memory
 * ring buffer answering one question — "why did this message not get
 * translated?" — which no single module can answer alone. The visibility
 * observer knows the element scrolled past; the policy knows the sender
 * matched; the queue knows the slot was full. Each is individually correct
 * and the message stays in its source language, so the only way to see the
 * cause is to record the decisions in one place.
 *
 * Recording is always on; printing is not. The buffer costs one small object
 * per decision and is what makes a panel switched on AFTER the symptom still
 * useful.
 */

export const DECISION_LOG_CAP = 2000;

export const DECISION = {
  // visibility observer
  Observe: 'observe',
  Unobserve: 'unobserve',
  Visible: 'visible',
  Hidden: 'hidden',
  Dwell: 'dwell',
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
} as const;

export type DecisionKind = (typeof DECISION)[keyof typeof DECISION];

export interface DecisionRecord {
  seq: number;
  t: number;
  kind: string;
  messageId?: string;
  sinceFirst?: number;
  [field: string]: unknown;
}

/**
 * Never printed: identifiers already carried in their own column, and
 * anything that could contain what the user actually wrote.
 *
 * DO NOT add a field here without also asking whether it can hold message
 * text. DO NOT remove one. A decision log that prints bodies is a decision
 * log nobody is allowed to turn on.
 */
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
]);

const KIND_WIDTH = 10;

function renderValue(value: unknown): string {
  if (value instanceof Error) {
    return (value as Error & { code?: string }).code ?? value.name ?? 'Error';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function formatRecord(record: DecisionRecord): string {
  const kind = String(record.kind).padEnd(KIND_WIDTH);
  const fields: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (NEVER_PRINTED.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    fields.push(`${key}=${renderValue(value)}`);
  }
  return `[translate] ${kind} ${record.messageId ?? '-'} ${fields.join(' ')}`.trimEnd();
}

export interface DecisionLog {
  emit(kind: string, messageId?: string, fields?: Record<string, unknown>): DecisionRecord;
  timeline(messageId: string): DecisionRecord[];
  records(): DecisionRecord[];
  subscribe(listener: (r: DecisionRecord) => void): () => void;
  setPrinting(value: boolean): void;
  isPrinting(): boolean;
  clear(): void;
  export(): string;
}

export function createDecisionLog({
  cap = DECISION_LOG_CAP,
  printing = false,
  sink = (line: string) => console.debug(line),
  now = () => Date.now(),
}: {
  cap?: number;
  printing?: boolean;
  sink?: (line: string, record: DecisionRecord) => void;
  now?: () => number;
} = {}): DecisionLog {
  const buffer: DecisionRecord[] = [];
  const listeners = new Set<(r: DecisionRecord) => void>();
  let seq = 0;
  let isPrinting = printing;

  function emit(kind: string, messageId?: string, fields?: Record<string, unknown>) {
    seq += 1;
    const record: DecisionRecord = { seq, t: now(), kind, messageId, ...fields };

    if (cap > 0) {
      buffer.push(record);
      if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
    }

    if (isPrinting) sink(formatRecord(record), record);

    // A subscriber is a React panel. It must not be able to fail the
    // translation call that happens to be emitting.
    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // Diagnostics only — deliberately swallowed.
      }
    }
    return record;
  }

  function timeline(messageId: string) {
    const mine = buffer.filter((r) => r.messageId === messageId);
    if (mine.length === 0) return [];
    const start = mine[0].t;
    return mine.map((r) => ({ ...r, sinceFirst: r.t - start }));
  }

  return {
    emit,
    timeline,
    records: () => [...buffer],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPrinting(value) {
      isPrinting = Boolean(value);
    },
    isPrinting: () => isPrinting,
    clear() {
      buffer.length = 0;
    },
    export: () => JSON.stringify({ cap, records: buffer }, null, 2),
  };
}

/** A log that records nothing, for unit tests and for any caller that would
 *  otherwise have to null-check every emit site. */
export const NOOP_DECISION_LOG = createDecisionLog({ cap: 0 });

/** The one the app uses. Module singleton to match the rest of this folder. */
export const decisionLog = createDecisionLog();
```

---

## B.2 接線點(三處)

### 1. 觀察器 — 把 Phase A 留的 `onEvent` 掛上

`visibilityTracker.ts`,包裝層的 `createVisibilityObserver` 呼叫:

```ts
import { decisionLog } from './decisionLog';

const impl = createVisibilityObserver({
  onCandidate: (id) => {
    for (const fn of [...candidateFns]) fn(id);
  },
  onEvent: (kind, id, fields) => decisionLog.emit(kind, id, fields),
});
```

### 2. store — 換掉三行 console.log

`store.ts` 現有的 `queued` / `start` / `done` 三行(F6 加的,包在
`!isProductionBundle()` 裡)換成:

```ts
// translate(),入隊之後
decisionLog.emit(DECISION.Enqueue, messageId, { origin, queued: queue.length });

// run(),送出之前
decisionLog.emit(DECISION.Send, job.messageId, { origin: job.origin, inFlight: activeCount });

// run() 的 finally
decisionLog.emit(DECISION.Settle, job.messageId, {
  origin: job.origin,
  ok, aborted, superseded, error,
  tookMs: Date.now() - sentAt,
});
```

**同時補上目前完全沒有記錄的三個丟棄點** —— 這是 Phase B 真正的價值,現在
這三條路徑是完全靜默的:

```ts
// pump(),G5 判定訊息已離開視窗
decisionLog.emit(DECISION.Drop, job.messageId, { reason: 'left-viewport', queued: queue.length });

// pump(),斷路器冷卻中
decisionLog.emit(DECISION.Drop, job.messageId, { reason: 'circuit-open', queued: queue.length });

// translate(),G2 dedupe
decisionLog.emit(DECISION.Deduped, messageId, { origin, status: cur?.status });
```

> `emit` 的 `fields` **絕對不要**放 `message.message`、譯文、或任何原文片段。
> `NEVER_PRINTED` 是最後一道防線,不是第一道。

### 3. 開發者入口

掛到 `window`,只在非 production bundle:

```ts
if (!isProductionBundle()) {
  (window as unknown as Record<string, unknown>).__translate = {
    log: decisionLog,
    timeline: (id: string) => console.table(decisionLog.timeline(id)),
    print: (on = true) => decisionLog.setPrinting(on),
    dump: () => decisionLog.export(),
  };
}
```

用法:`__translate.timeline('<messageId>')` 會列出那一則訊息從 observe 到
settle 的完整決策路徑,含每一步的相對毫秒數。這是之後每一次診斷的起點。

---

## B.3 驗收

見 `06-verification.md` §B。摘要:

1. `decisionLog.test.ts` 15 個測試全綠(參考實作 §9.6)。
2. **`NEVER_PRINTED` 有測試釘住**:emit 一筆帶 `text` / `translatedText` 的
   記錄,`formatRecord` 的輸出不得包含那些字串。這條測試不可刪。
3. 瀏覽器:捲一段之後 `__translate.timeline(id)` 對任一則可視訊息都能給出
   可解釋的路徑(observe → visible → dwell → …)。
4. 行為完全不變:佇列深度、翻譯結果、時序都與 Phase A 結束時相同。
