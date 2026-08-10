# Phase C — store 邊界:`ensureForView` 與可觀測的丟棄

工作量最大的一相。做完之後 F7/F8 兩道 guard 可以刪 —— 它們補的 race 不再存在。

## 這一相要達成的三件事

1. **合併入隊路徑。** `translate()` 與 `ensureTranslationForView()` 收斂成單一
   `ensureForView`,快取讀取從 policy 移進 store。
2. **讓丟棄變成可觀測事件。** pump 丟掉一個 job 時(離開視窗、佇列滿、被取代)
   必須 `markSent(false)` 並結算,而不是靜默 `setState(idle)`。
3. **刪掉 pump 裡的斷路器。** 連同 `00-assessment.md` B4 的兩個 bug 一起消失。
   斷路器 Phase D 會在 policy 重建。

> ⚠️ **不可以只做 1 和 2 就進 Phase D。** 第 3 點沒做,會有兩個獨立計數的斷路器。

---

## C.1 快取 adapter

現有 `idbTranslationCache` **保留**(裡面的 intent 是使用者按過的「查看原文」,
是使用者資料)。寫一層 adapter 把它變成參考實作要的形狀。

兩邊 schema 的差異:

```ts
// 現況
translationCache.intent.get(id)     // → { mode: 'manual' | 'off' } | undefined
translationCache.content.get(id)    // → { targetLang, translatedText } | undefined

// 參考實作要的
cache.intent.get(id)                          // → 'manual' | 'off' | undefined
cache.content.get(id, { targetLang, srcVersion })  // → { translatedText, identical } | undefined
```

差別不只是形狀:**`srcVersion` 失效判定與 `identical` 旗標在參考實作裡是快取的
責任**,在現況是呼叫端的。adapter 要把這兩件事搬進去。

```ts
/** Adapts the existing IndexedDB cache to the interface the ported store
 *  expects. The stored records gain two plain (non-indexed) fields —
 *  `srcVersion` and `identical` — which Dexie accepts without a version bump:
 *  only indexed fields have to be declared in version(n).stores(). */
export const cacheAdapter = {
  intent: {
    async get(messageId: string): Promise<'manual' | 'off' | undefined> {
      const record = await translationCache.intent.get(messageId).catch(() => undefined);
      return record?.mode;
    },
    async set(messageId: string, roomId: string, mode: 'manual' | 'off') {
      await translationCache.intent.set(messageId, roomId, mode);
    },
  },

  content: {
    async get(
      messageId: string,
      { targetLang, srcVersion }: { targetLang: string; srcVersion: number | string },
    ) {
      const record = await translationCache.content.get(messageId).catch(() => undefined);
      if (!record) return undefined;
      if (record.targetLang !== targetLang) return undefined;
      // A record written before this migration has no srcVersion. Treated as
      // a miss rather than a hit: the cost is one extra translation, and the
      // alternative is showing the pre-edit translation of an edited message
      // with no way to tell.
      if (record.srcVersion === undefined || record.srcVersion !== srcVersion) return undefined;
      return { translatedText: record.translatedText, identical: record.identical === true };
    },

    async set(args: {
      messageId: string;
      roomId: string;
      targetLang: string;
      srcVersion: number | string;
      translatedText: string;
      originalText: string;
    }) {
      await translationCache.content.set({
        messageId: args.messageId,
        roomId: args.roomId,
        targetLang: args.targetLang,
        srcVersion: args.srcVersion,
        translatedText: args.translatedText,
        // Computed at write time so the read path never needs the original.
        identical: args.translatedText === args.originalText,
      });
    },

    clear: (messageId: string) => translationCache.content.clear(messageId),
  },

  clearMessages: (ids: string[]) => translationCache.clearMessages(ids),
  clearRoom: (roomId: string) => translationCache.clearRoom(roomId),
  clearAll: () => translationCache.clearAll(),
};
```

> **`.catch(() => undefined)` 只包讀取,不包寫入。** 讀取失敗退化成 cache miss
> 是安全的;寫入失敗要讓上層知道(見 C.4),但不能讓它變成翻譯失敗。

---

## C.2 job 的新形狀

現況的 queue item:

```ts
{ messageId, roomId, targetLang, seq, threadId?, origin }
```

改成:

```ts
type Outcome = {
  ok: boolean;
  aborted?: boolean;
  superseded?: boolean;
  dropped?: boolean;
  deduped?: boolean;
  error?: unknown;
};

type QueueItem = {
  messageId: string;
  roomId: string;
  text: string;
  targetLang: string;
  srcVersion: number | string;
  threadId?: string;
  origin: 'manual' | 'auto';
  reqSeq: number;
  enqueuedAt: number;
  /** Resolves the caller's `sent` promise. TRUE exactly once, when the job
   *  reaches the transport. FALSE on every path that ends the job before
   *  that. Must be called on every path — see C.3. */
  markSent: (value: boolean) => void;
  /** Resolves the caller's `done` promise. Never rejects: a failed
   *  translation is a UI state, not an exception for the caller to catch. */
  settle: (outcome: Outcome) => void;
};
```

`text` 現在是 job 的欄位。目前 `run()` 從別處取得原文;把它移到入隊時決定,
呼叫端已經有訊息物件了。這也讓 job 自足 —— 訊息在佇列等待期間被編輯,舊 job
帶的是舊文,而 `reqSeq` 會把它作廢,兩件事不會互相污染。

---

## C.3 每一條路徑都要結算

這是整相最容易漏、也最貴的一點。**`markSent` 與 `settle` 必須在每一條離開的
路徑上被呼叫恰好一次。** 漏掉任何一條,等待 `sent` 的 policy 會永久 pending,
並連帶卡住斷路器的 probe token。

| 路徑 | `markSent` | `settle` |
|---|---|---|
| 送出並收到回覆 | `true`(送出前) | `{ ok: true }` |
| 送出但失敗/逾時 | `true`(送出前) | `{ ok: false, error }` |
| 被 abort | `true`(送出前) | `{ ok: false, aborted: true, error }` |
| G2 dedupe 早退 | `false` | `{ ok: true, deduped: true }` |
| 佇列滿被拒 | `false` | `{ ok: false, dropped: true }` |
| pick 時已離開視窗 | `false` | `{ ok: false, dropped: true }` |
| `invalidate()` purge 掉排隊中的 job | `false` | `{ ok: false, superseded: true }` |
| 登出 / 換房間 drain | `false` | `{ ok: false, superseded: true }` |

> 參考實作的缺陷 #17 就是漏了第四列。它在那邊因為前面兩道保護而不可達,但
> **現況的 G2 是裸 `return`,前面沒有 generation guard —— 直接可達。**

`invalidate()` 也要跟著改:現在它只中止飛行中的請求,必須同時把佇列裡同一則
訊息的 job 撈出來結算,否則那個 job 之後照樣上線,而且它的 `superseded` 結算
會被 policy 讀成成功。

```ts
function invalidate(messageId: string): number {
  const current = controllers.get(messageId);
  if (current) {
    controllers.delete(messageId);
    current.abort();
  }
  // A QUEUED job has no controller to abort. Left in place it eventually
  // sends a request whose reply is unusable — for a reverted message, one the
  // user explicitly declined.
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].messageId !== messageId) continue;
    const [item] = queue.splice(i, 1);
    decisionLog.emit(DECISION.Drop, messageId, { reason: 'superseded', origin: item.origin });
    item.markSent(false);
    item.settle({ ok: false, superseded: true });
  }
  generation += 1;
  return generation;
}
```

---

## C.4 `run()` 的兩處改動

### 1. 快取寫入失敗不是翻譯失敗

```ts
const result = await translationService.translate(job.text, job.targetLang, {
  signal: ctrl.signal,
  maxAttempts: job.origin === 'auto' ? 1 : 3,
});
if (getState().byId[job.messageId]?.reqSeq !== job.reqSeq) return;   // G1

const identical = result === job.text;

// Settled BEFORE the write. The translation succeeded the moment the backend
// replied; persisting it is a local convenience. A full quota, a private-mode
// database, a corrupt store — each would otherwise be caught below as a failed
// translation: the text discarded, an error shown, and the circuit breaker fed
// for a backend that never misbehaved.
outcome = { ok: true };
try {
  await cacheAdapter.content.set({
    messageId: job.messageId,
    roomId: job.roomId,
    targetLang: job.targetLang,
    srcVersion: job.srcVersion,
    translatedText: result,
    originalText: job.text,
  });
} catch (err) {
  decisionLog.emit(DECISION.Violation, job.messageId, {
    reason: 'cache-write-failed',
    error: err,
  });
}

setState(/* status: 'translated', translatedText: identical ? job.text : result, ... */);
```

### 2. `finally` 裡刪掉 `probeInFlight = false`

整行刪除。probe token 是 policy 的狀態,Phase D 會在那裡管理。

### 3. `maxAttempts` 依 origin 分流

自動路徑一律 `maxAttempts: 1`。退避交給斷路器 —— 否則每個自動 job 在飽和的
後端上變成三個真實請求,並佔著格子走完整條重試梯。以 `failureCircuitThreshold: 5`
計,兩個控制迴圈疊起來是「15 個請求、48 秒佔用」才跳閘,而不是設計上的 5 個。

---

## C.5 `pump()` 的改動

```ts
function pump() {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const job = takeNext();
    if (!job) return;      // 子閘門滿 ≠ 佇列空
    run(job);
  }
}

/** Take the next job that is allowed to run right now, dropping automatic
 *  jobs whose message has since left the viewport. Returns null when nothing
 *  is currently runnable. */
function takeNext(): QueueItem | null {
  // Manual first, always. A click never queues behind background work.
  const manualIndex = queue.findIndex((item) => item.origin !== 'auto');
  if (manualIndex !== -1) return queue.splice(manualIndex, 1)[0];

  if (countAutoInFlight() >= MAX_CONCURRENT_AUTO) return null;

  const autoItems = queue.filter((item) => item.origin === 'auto');
  if (autoItems.length === 0) return null;

  const byId = new Map(autoItems.map((item) => [item.messageId, item]));
  // Unsigned distance from the centre of what the user is looking at, measured
  // live at pick time. The old signed comparator ordered "topmost first",
  // which is arrival order, not attention order.
  const ordered = visibilityObserver.byDistanceFromCentre([...byId.keys()]);

  for (const id of ordered) {
    const item = byId.get(id);
    if (!item) continue;
    queue.splice(queue.indexOf(item), 1);
    if (visibilityObserver.visibleIds.has(id)) return item;

    // Dropped, not run: release the entry so a later view can retry it, and
    // tell the caller — a silent setState(idle) is how the policy ends up
    // charging its rate budget for a request that never happened.
    if (getState().byId[id]?.reqSeq === item.reqSeq) {
      setState(/* [id]: { status: 'idle', reqSeq: item.reqSeq } */);
    }
    decisionLog.emit(DECISION.Drop, id, {
      reason: 'left-viewport',
      waitedMs: Date.now() - item.enqueuedAt,
      queued: queue.length,
    });
    item.markSent(false);
    item.settle({ ok: false, dropped: true });
  }
  return null;
}
```

**同時刪除**:`consecutiveAutoFailures`、`breakerOpenUntil`、`probeInFlight`
三個模組變數,以及 pump 裡讀它們的兩個分支。

> F3 那個修正(排序搬到 while 迴圈之外)在新結構裡自然成立:`takeNext` 每次
> 只挑一個,沒有「排序完再 unshift 回去」這回事。

---

## C.6 佇列上限

```ts
/** An explicit request is never refused. The ceiling exists to stop background
 *  work growing without bound while the user scrolls; a click is not
 *  background work, and a queue length must never be the reason a button does
 *  nothing. */
function hasQueueRoom(origin: 'manual' | 'auto'): boolean {
  if (origin !== 'auto') return true;
  if (!MAX_QUEUE_LENGTH) return true;
  return queue.length < MAX_QUEUE_LENGTH;
}
```

`MAX_QUEUE_LENGTH` 加進 `constants.ts`,值 `50`。

> ⚠️ **這個常數在 Phase D 的 sweep 上線之前必須維持 `0`(關閉)。** 上限單獨
> 存在會把被拒的訊息永久擱淺 —— 它不動,觀察器就不會再發候選。參考實作量到
> 的是 12 則裡只有 2 則被翻譯。C.6 先把程式碼寫好、值設 0,D 再改成 50。

---

## C.7 `ensureForView` — 唯一入口

```ts
async function ensureForView(
  messageId: string,
  {
    roomId,
    text,
    targetLang,
    srcVersion,
    autoTranslate,
    threadId,
  }: {
    roomId: string;
    text: string;
    targetLang: string;
    srcVersion: number | string;
    autoTranslate: boolean;
    threadId?: string;
  },
): Promise<{
  outcome: 'settled' | 'suppressed' | 'superseded' | 'cached' | 'dropped' | 'queued';
  sent?: Promise<boolean>;
  done?: Promise<Outcome>;
}> {
  const current = getState().byId[messageId];
  const settledForThisView =
    current?.targetLang === targetLang &&
    current?.srcVersion === srcVersion &&
    (current?.status === 'queued' ||
      current?.status === 'loading' ||
      current?.status === 'translated');
  if (settledForThisView) return { outcome: 'settled' };

  // This function is not atomic: between here and the enqueue sit two cache
  // reads, and a revert or an edit can land inside that window. The sequence
  // captured now is re-checked before the enqueue — losing that race must mean
  // standing down, or the enqueue takes a fresh generation and translates a
  // message whose user just said "see original".
  const seqAtStart = current?.reqSeq ?? 0;

  const intent = await cacheAdapter.intent.get(messageId);
  if (intent === 'off') {
    decisionLog.emit(DECISION.Suppressed, messageId, { reason: 'see-original' });
    return { outcome: 'suppressed' };
  }

  const wanted = intent === 'manual' || autoTranslate;
  if (!wanted) {
    decisionLog.emit(DECISION.Suppressed, messageId, { reason: 'auto-off-no-intent' });
    return { outcome: 'suppressed' };
  }

  const cached = await cacheAdapter.content.get(messageId, { targetLang, srcVersion });

  // The atomicity re-check, placed BEFORE the cached branch: a cache hit
  // writes 'translated' into the entry, which would overwrite a revert just as
  // surely as a fresh request would.
  if ((getState().byId[messageId]?.reqSeq ?? 0) !== seqAtStart) {
    return { outcome: 'superseded', sent: Promise.resolve(false) };
  }

  if (cached) {
    hydrateEntry(messageId, {
      status: 'translated',
      targetLang,
      translatedText: cached.identical ? text : cached.translatedText,
      identical: cached.identical,
      srcVersion,
      reqSeq: getState().byId[messageId]?.reqSeq ?? 0,
    });
    decisionLog.emit(DECISION.Cached, messageId, { targetLang, identical: cached.identical });
    return { outcome: 'cached' };
  }

  const origin: 'manual' | 'auto' = intent === 'manual' ? 'manual' : 'auto';

  // Reported as its own outcome rather than as a queued job that fails: the
  // policy layer charges its rate budget and its circuit breaker on 'queued'
  // alone, and neither should move for a request never made.
  if (!hasQueueRoom(origin)) {
    decisionLog.emit(DECISION.Drop, messageId, { reason: 'queue-full', queued: queue.length });
    return { outcome: 'dropped', sent: Promise.resolve(false) };
  }

  let markSent!: (v: boolean) => void;
  const sent = new Promise<boolean>((resolve) => {
    markSent = resolve;
  });

  // Enqueue and return the job promise without awaiting it. A view hook must
  // not stay suspended for the whole round trip — the entry it renders from is
  // already 'queued'. Both promises are handed back so the policy layer can
  // charge its rate budget on `sent` and its circuit breaker on `done`.
  const done = enqueue(messageId, {
    roomId, text, targetLang, srcVersion, threadId, origin, onSent: markSent,
  });
  return { outcome: 'queued', done, sent };
}
```

`enqueue` 就是現況的 `translate()` 改名並改回傳值。它保留 G2 dedupe,但**加上
C.3 表格要求的 `onSent?.(false)`**:

```ts
function enqueue(
  messageId: string,
  { roomId, text, targetLang, srcVersion, threadId, origin = 'manual', onSent }: EnqueueArgs,
): Promise<Outcome> {
  const cur = getState().byId[messageId];
  const alreadyRunning =
    (cur?.status === 'loading' || cur?.status === 'queued') &&
    cur.targetLang === targetLang &&
    cur.srcVersion === srcVersion;
  if (alreadyRunning) {
    decisionLog.emit(DECISION.Deduped, messageId, { origin, status: cur.status });
    // ensureForView reports 'queued' for every call that reaches this
    // function, so `sent` has to settle on every path out of it. A caller that
    // awaits it — the policy does — would otherwise wait forever.
    onSent?.(false);
    return Promise.resolve({ ok: true, deduped: true });
  }

  if (!hasQueueRoom(origin)) {
    onSent?.(false);
    return Promise.resolve({ ok: false, dropped: true });
  }

  const reqSeq = invalidate(messageId);
  setState(/* [messageId]: { status: 'queued', targetLang, srcVersion, reqSeq, origin } */);

  let settle!: (o: Outcome) => void;
  const done = new Promise<Outcome>((resolve) => { settle = resolve; });

  queue.push({
    messageId, roomId, text, targetLang, srcVersion, threadId, origin,
    reqSeq, enqueuedAt: Date.now(),
    markSent: onSent ?? (() => {}),
    settle,
  });
  decisionLog.emit(DECISION.Enqueue, messageId, { origin, queued: queue.length });
  pump();
  return done;
}
```

---

## C.8 兩個舊入口的處置

| 舊入口 | 處置 |
|---|---|
| `useEnsureTranslationForView` hook | 內部改成呼叫 `ensureForView`,**不要**再自己讀 IDB、不要再直接呼叫 `translate()`。hook 的對外簽名不變 |
| 手動翻譯按鈕 | 改成 `enqueue(id, { ..., origin: 'manual' })`,或先 `cacheAdapter.intent.set(id, roomId, 'manual')` 再 `ensureForView(...)`。**兩者擇一,不要兩條都留** |

`store` 對外 export 增加 `ensureForView`,保留 `translate`(指向 `enqueue`)
讓現有元件先編得過。

---

## C.9 這一相要刪掉的東西

- `autoPolicy.ts` 的 F7 前置同步 guard
- `autoPolicy.ts` 的 F8 後置同步 guard
- `autoPolicy.ts` `applySkipRules` 裡的兩次 IDB 讀取與 `hydrateEntry` 分支
- `store.ts` 的 `consecutiveAutoFailures` / `breakerOpenUntil` / `probeInFlight`
- pump 裡讀上面三個變數的分支
- `run()` `finally` 裡的 `probeInFlight = false`

> F7/F8 不是「補得不夠好」,是 Phase C 之後**沒有東西需要它們補**:policy
> 在呼叫 store 之前不再做非同步工作,那個競態窗口不存在了。

---

## C.10 驗收

見 `06-verification.md` §C。摘要:

1. `store.test.ts` 55 個測試全綠(參考實作 §9.2)。特別是
   **「每一條路徑都結算 `sent`」** 與 **「快取寫入失敗仍算翻譯成功」** 兩組。
2. 突變 M13、M14 全殺。
3. `__translate.timeline(id)` 對一則「入隊後捲走」的訊息,必須看得到
   `drop reason=left-viewport`;在 Phase C 之前這條路徑完全靜默。
4. 手動翻譯行為完全不變(這一相沒有改動它的語意,只換了引擎)。
5. `MAX_QUEUE_LENGTH` 仍為 `0`。
