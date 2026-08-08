# Handoff — 自動翻譯管線參考實作(v2,含完整程式碼與驗證方法)

> 給 in-house agent 的交接文件。本文自包含:所有核心程式碼**原文嵌入**於 §5,
> 並附驗證這份程式碼所用的混沌測試、突變清單與量測基準。

---

## 0. 安全與命名約束(不可放寬)

- 絕不把公司內部的產品/系統代號、內部網域、內部工具名寫進任何 repo 檔案、
  issue、PR、commit message 或程式註解。一律使用中性名稱:「翻譯服務 /
  Translation API」。
- 既有產出物若使用佔位符(`__REDACTED_PRODUCT_NAME__` 等系列),原樣保留。
- 模型識別碼、session id、AI 來源標註不得出現在任何推進 repo 的產出物中。
- 訊息內文(message body)不得出現在任何 log、trace、診斷輸出中 —— §5 的
  `decisionLog.js` 以 `NEVER_PRINTED` 集合強制這一點,移植時不得刪除。

---

## 1. 給 in-house agent 的直接指令

1. **§5 的六個核心檔案,逐字採用。** 不要「參考後重寫」:這份程式碼上的每一個
   非顯然決策都對應一個曾實際發生、有回歸測試釘住的缺陷(§3),重寫幾乎必然把
   其中幾個 bug 重新引入。合理的改動只有 §6 列出的適配點(import 路徑、transport
   簽名、subject 命名)。
2. **§7 的測試檔案一併採用。** 沒有測試的移植無法驗證;這些測試曾以突變測試
   驗證過殺傷力(9/9 已知 bug 全部殺死,見 §8.2)。
3. 移植完成後,**跑 §8 的三層驗證**:單元/整合套件全綠 → 混沌測試三個種子全綠
   → 突變測試 9/9 全殺。三層全過才算移植完成。
4. 如果你(in-house agent)現有一版 visibilityObserver / autoPolicy:**不要合併,
   直接替換**,然後把你舊版程式碼對照 §3 的缺陷目錄逐條檢查 —— 那份目錄就是
   為了診斷你的舊版而寫的。

---

## 2. 架構總覽

三個模組 + 一個 provider,加兩個診斷件。單一請求路徑、單一佇列、單一快取。

```
MessageRow(ref) ──registerMessage──▶ visibilityObserver
                                        │  IntersectionObserver 跨越 + dwell(400ms)
                                        ▼ onCandidate(id)
                                     autoPolicy
                                        │  gate(own/system/non-textual)、RPM、斷路器
                                        │  + recheckVisible 每秒 sweep(修復路徑)
                                        ▼ ensureForView / translate
                                       store ──▶ translate(nats, {text, targetLang}, {signal})
                                        │  佇列、併發閘門(4 總量 / 2 自動)、逾時、
                                        │  generation 計數、queued/loading 分離
                                        ▼
                              idb cache(intent 與 content 分表)
```

診斷件(不是選配,是功能的一部分 —— 這個功能的所有失敗模式都是靜默的):
- `decisionLog.js`:capped ring buffer,記錄每一個決策
  (visible/dwell/skip/enqueue/send/drop/settle/violation),永不記錄內文。
- `invariants.js`:純函數,對佇列宣稱的保證做逐條斷言,provider 每 2 秒審計。

### 2.1 三條核心合約(舊版只要有任何一條不成立,就會「莫名不動」)

**合約 A —「候選只在可視轉換時觸發一次」**(observer 的輸出合約)
observer 對一則訊息只在「進入可視 + dwell 完成」時發一次候選。這意味著下游
*任何*拒絕(rate limit、斷路器、佇列滿、inactive、內部錯誤)都會讓**留在畫面上
的訊息永久擱淺** —— 它不動,就不會再有 intersection entry。唯一的修復路徑是
`autoPolicy.recheckVisible`:每秒重新供給「可視且 idle」的訊息。
實測:沒有 sweep 時,停下閱讀的畫面 12 則只有 2 則被翻譯;有 sweep 是 12/12。
**佇列上限(maxQueueLength)只有在 sweep 存在時才是安全的。**

**合約 B —「進佇列 ≠ 送出」**(store 的合約)
捲動時大多數自動候選在佇列裡就被丟棄(取出時發現已捲出畫面),從未到達後端。
任何計數(RPM 預算、斷路器)必須觀察**真正的 send**,不能觀察 accept。
store 的 `ensureForView` 回傳 `{outcome, done, sent}` 兩個承諾:`sent` 管
流量計費,`done` 管斷路器。實測:在 enqueue 計費時,一次快速捲動 60 個候選
只有 14 個送出,46 筆幽靈計費在 7 秒內耗盡每分鐘 60 的預算,之後 36 個候選
全部被靜默 rate-limit —— 功能自己關機,無任何錯誤。

**合約 C —「狀態在讀取時計算,不在 render 時快照」**(provider 的合約)
`document.visibilityState` 這類會在 React render 之外變化的狀態,必須在
`getContext()` 呼叫當下讀。背景載入的分頁只 render 一次(hidden),切回前景
不觸發 re-render —— 快照進 ref 的 `active: false` 會讓 policy 永遠跳過所有
候選(實測:601 筆 `skip:inactive`,畫面一片平靜)。

### 2.2 組裝順序

provider 以 `useState` lazy initializer(**不是** `useMemo` —— 那是 React 可
丟棄的快取提示,StrictMode 下會建兩套,把佇列和 AbortController 弄丟)一次性
建好三件,順序固定:**observer → store → policy**,store 在建構時就拿到
`isAutoEligible` / `orderAutoQueue` 兩個閘門,不做事後補接。三者共用同一個
decisionLog —— 決策只有交織在同一條時間軸上才可解讀。

---

## 3. 缺陷目錄(全部實際發生過、修復、有回歸測試)

拿你的舊版逐條對照。「症狀」欄就是使用者回報的樣子。

| # | 症狀 | 根因 | 修法(在 §5 程式碼中的位置) |
|---|---|---|---|
| 1 | 捲一陣子之後自動翻譯整個停止,無錯誤 | RPM 在 enqueue 計費,幽靈候選耗盡預算(合約 B) | policy `onCandidate` 等 `result.sent`,false 則不計費也不進斷路器 |
| 2 | 停下來閱讀,畫面上訊息永遠停在原文 | 佇列滿的拒絕沒有重觸發(合約 A) | policy `recheckVisible` + provider 每秒驅動;只收 `idle` |
| 3 | 翻譯順序像亂數,不是「先翻正在看的」 | 排序用 IO 跨越時快取的座標;列進場後移動不再有 entry | observer `centreOf` 取出時活測 `getBoundingClientRect`,量不到才退快取;距離在比較器外算一次 |
| 4 | 後端掉一個回覆,自動翻譯從此死掉 | request/reply 掉回覆=promise 永不 settle,格子永久佔用;2 個就吃光自動閘門 | store `withTimeout`;**先 reject 再 abort**(順序反了會被歸類成使用者取消,豁免於失敗計數,斷路器在全面故障下永不跳) |
| 5 | 背景開的分頁,切回前景後自動翻譯不動 | `active` 在 render 時快照進 ref(合約 C) | provider 在 `getContext()` 內活讀 `visibilityState` |
| 6 | IndexedDB 壞掉時 console 每秒一個 unhandled rejection | `onCandidate` 的 cache 讀取在 try 之外;dwell timer 和 sweep 都不接 catch | policy `onCandidate` 永不 reject:包 `offerCandidate`,內部錯誤變 `skip:internal-error`,**不餵斷路器**(本地故障≠後端故障) |
| 7 | 擱淺修復很慢(一秒一則) | sweep 串行 `await onCandidate`(它等到翻譯結算才 resolve) | sweep fire-and-forget;dedup 靠 store 的 status 檢查,不靠迴圈順序 |
| 8 | 診斷 log 幾分鐘就被洗光 | auto 關閉/頁面隱藏時,sweep 每秒每則可視訊息記一筆 skip | sweep 開頭靜默過便宜 gate(不記 log) |
| 9 | 對排隊中的訊息按「See original」,它還是被翻譯了 | `invalidate()` 只中止飛行中請求;**排隊中的工作沒有 controller**,留在佇列照樣上線;其 `superseded` settle 被當成功 | store `invalidate` purge 佇列中同訊息工作,以 never-sent 結算;`onLogout` 同樣 drain 而非截斷 |
| 10 | revert 與自動候選賽跑,revert 偶爾輸 | `ensureForView` 非原子:intent 讀→content 讀→enqueue,revert 落在窗口內被蓋掉;**cache-hit 分支同樣中招** | 進場記 `reqSeq`,**在 cached 分支之前**重驗;輸了回 `{outcome:'superseded'}` |
| 11 | 診斷面板 slot 計數在切換語言時對不上 | in-flight 以 messageId 為 key;supersede 期間同一訊息有兩個真實在途請求(transport 無法取消飛行中),per-message map 數不到 | store per-job `running` 集合,與計數器同步增減;`inspect()` 從它報 |
| 12 | config 宣告的行為實際不存在 | `scrollIdleMs` / `timeoutMs` / `maxQueueLength` 曾宣告而無人讀取 | 「every declared knob is wired」白名單測試;死旋鈕刪除 |
| 13 | 佇列滿看起來跟後端慢一模一樣 | 單一 `loading` 狀態 | `queued`(未送出,可能永不送出)/`loading`(已上線)分離;UI 分開顯示 |

### 3.1 已知而未修(設計取捨,留給產品決策)

- **持續快速捲動時 ~73% 的完成翻譯送達時訊息已捲走**(dwell 400 + 佇列等待 +
  後端往返 > 訊息可視壽命 ~1s)。可調桿:`prefetchMarginPx` 給正值(提前翻,
  換後端流量)、放寬 `maxConcurrentAuto`、縮短 dwell。
- **停下閱讀的滿屏(12 則)要 ~5.2s 全部翻完**(`maxConcurrentAuto: 2` × 後端
  0.8s × 6 批)。
- **`failed` 不被 sweep 重供給**(防 bad_request 無限重試),要視窗離開再進入
  才重試;與斷路器冷卻疊加時,一次重入可能被 `circuit-open` 吃掉,需再一次
  重入。若要改善:按 `error.code` 區分 retryable(unavailable/timeout)允許
  sweep 收回,必須有界。
- 譯文長度改變列高 → 內容位移。Chrome/Firefox 有原生 scroll anchoring 補償,
  **Safari 沒有**;如果目標使用者含 Safari,需要 layout compensation。
- transport 層 in-flight abort **刻意不做**:底層 request API 通常無 abort 支援,
  wire 有自己的 timeout,而且 publish 已出去、後端照樣做完 —— 取消等待救不回
  成本。格子回收由 store 的 timeout 與 `detach()` 負責,過期回覆由 generation
  丟棄。不要為此改共用 transport。

---

## 4. 設定值與其量測依據

```
dwellMs: 400                  // 實測捲速下只過濾 ~3%;真正的過濾是取出時可視檢查
prefetchMarginPx: 0           // 產品取捨未定;>0 是解決「送達時已捲走」的主要桿
maxConcurrent: 4              // 總閘門
maxConcurrentAuto: 2          // 嚴格小於總量:使用者點擊永遠有格子,不排在背景工作後面
maxQueueLength: 50            // 只擋 auto;手動永不拒絕。僅在 sweep 存在時安全(缺陷 #2)
recheckIntervalMs: 1000       // 修復路徑,1s 延遲無感;更快只是重問同樣的問題
maxRequestsPerMinute: 60      // runaway guard 而非容量控制;只對真正送出計費(缺陷 #1)
failureCircuitThreshold: 5    // 連續失敗;bad_request 不計(自己的 bug 不該關掉功能)
failureCircuitCooldownMs: 30s // probe 失敗則指數退避;probe 全域同時只允許一個
timeoutMs: 15s                // 掉回覆的格子回收(缺陷 #4);0 = 停用
skipNonTextual: true          // \p{L} 無字母即跳過
```

---

## 5. 核心程式碼(逐字採用)

以下每個檔案為完整原文,與通過全部驗證(§8)的版本逐字一致。目錄結構:

```
src/context/TranslationContext/
├── store.js               # 佇列與請求生命週期(最核心)
├── visibilityObserver.js  # 可視性 → 候選
├── autoPolicy.js          # 決策層 + sweep
├── decisionLog.js         # 決策軌跡 ring buffer
├── invariants.js          # 執行期不變量檢查
└── TranslationContext.jsx # React provider(組裝與生命週期)
```

<!-- CODE-SECTIONS-INJECTED-BELOW -->

### 5.1 store.js — 佇列與請求生命週期

檔案:`src/context/TranslationContext/store.js`

```js
// Translation store: per-message display state plus the request queue.
//
// Two invariants carry most of the weight here.
//
// 1. Every state-resetting action bumps a generation counter and stamps it on
//    the message's entry. A reply may only win if its generation still
//    matches. Late replies are therefore structurally unable to overwrite
//    newer state, rather than relying on an abort landing in time.
//
// 2. The queue is the only thing that decides what runs. Callers enqueue and
//    receive a promise; they never start a request themselves. Concurrency,
//    ordering and the automatic-translation sub-gate are all changeable in
//    one place.

import { DECISION, NOOP_DECISION_LOG } from './decisionLog'

export const IDLE_ENTRY = Object.freeze({ status: 'idle', reqSeq: 0 })

/**
 * Work already under way for a message.
 *
 *   queued  — accepted, waiting for a concurrency slot. Nothing has been sent
 *             and nothing may ever be: an automatic job whose message leaves
 *             the viewport is dropped at pick time.
 *   loading — the request is on the wire.
 *
 * Both count as "in progress" for deduplication and for deciding whether a
 * freshly mounted message still needs anything done.
 */
export const IN_PROGRESS = new Set(['queued', 'loading'])

const DEFAULT_CONFIG = {
  maxConcurrent: 4,
  // Strictly below maxConcurrent, so a message the user explicitly asked for
  // never queues behind background work. This is the single most important
  // number here.
  maxConcurrentAuto: 2,
  // Automatic jobs are re-checked at pick time, not at enqueue time: a
  // message can leave the viewport while it waits, and translating it then is
  // pure waste. Manual jobs bypass this — the user asked.
  isAutoEligible: () => true,
  // Lets the caller rank the waiting automatic jobs (by distance from the
  // centre of the viewport). Read at pick time so scrolling never has to
  // reorder a queue.
  orderAutoQueue: (ids) => ids,
  // Under request/reply a lost reply produces no rejection: the promise
  // simply never settles. Without this the slot is held forever, and two of
  // them exhaust maxConcurrentAuto and end automatic translation for the
  // session — with no error anywhere to show for it. 0 disables.
  timeoutMs: 15_000,
  // A bound on background work only, so a fast scroll through a long room
  // cannot grow the queue without limit. Off by default: refusing a job is
  // only safe when something re-offers it later, and that is the caller's
  // responsibility, not the queue's. See AUTO_TRANSLATE_CONFIG.
  maxQueueLength: 0,
}

function isAbort(err) {
  return err?.name === 'AbortError'
}

function timeoutError(ms) {
  const err = new Error(`translate timed out after ${ms}ms`)
  err.name = 'TimeoutError'
  // Counts against the automatic circuit breaker: a backend that stops
  // replying is exactly the outage the breaker exists for.
  err.code = 'timeout'
  return err
}

export function createTranslationStore({
  nats,
  translate,
  cache,
  config = {},
  log = NOOP_DECISION_LOG,
  now = () => Date.now(),
}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  const entries = new Map()
  const listeners = new Set()
  const inflight = new Map()
  /** One record per job currently HOLDING a slot — see runJob. */
  const running = new Set()
  const queue = []
  let activeCount = 0
  let activeAutoCount = 0
  let generation = 0

  function getEntry(messageId) {
    return entries.get(messageId) ?? IDLE_ENTRY
  }

  function emit() {
    for (const listener of listeners) listener()
  }

  function setEntry(messageId, next) {
    // `since` stamps when the *status* last changed, not when the entry was
    // last touched. A row that has read "queued" for forty seconds is the
    // thing worth seeing, and that is unanswerable without this.
    const previous = entries.get(messageId)
    const since = previous && previous.status === next.status ? previous.since : now()
    entries.set(messageId, { ...next, since })
    emit()
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** Cancel any in-flight request for this message and invalidate its
   *  generation, so a reply already on the wire can no longer be applied.
   *
   *  Also purges the message's QUEUED job, which has no controller to abort:
   *  left in place it would eventually send a request whose reply is
   *  unusable — for a reverted message, one the user explicitly declined —
   *  and its 'superseded' settle would read as a success to the policy's
   *  failure accounting. (Found by the chaos harness: reverting a queued
   *  message left a ghost job that still reached the wire.) */
  function invalidate(messageId) {
    const current = inflight.get(messageId)
    if (current) {
      inflight.delete(messageId)
      current.controller.abort()
    }
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].messageId !== messageId) continue
      const [item] = queue.splice(i, 1)
      log.emit(DECISION.Drop, messageId, {
        reason: 'superseded',
        origin: item.origin,
        queued: queue.length,
      })
      item.markSent(false)
      item.settle({ ok: false, superseded: true })
    }
    generation += 1
    return generation
  }

  /** Take the next job that is allowed to run right now, dropping automatic
   *  jobs whose message has since left the viewport. Returns null when
   *  nothing is currently runnable — a full sub-gate is not the same as an
   *  empty queue. */
  function takeNext() {
    const manualIndex = queue.findIndex((item) => item.origin !== 'auto')
    if (manualIndex !== -1) return queue.splice(manualIndex, 1)[0]

    if (activeAutoCount >= cfg.maxConcurrentAuto) return null

    const autoItems = queue.filter((item) => item.origin === 'auto')
    if (autoItems.length === 0) return null

    const byId = new Map(autoItems.map((item) => [item.messageId, item]))
    const ordered = cfg.orderAutoQueue([...byId.keys()])

    for (const id of ordered) {
      const item = byId.get(id)
      if (!item) continue
      queue.splice(queue.indexOf(item), 1)
      if (cfg.isAutoEligible(id)) return item
      // Dropped, not run: release the entry so a later view can retry it.
      if (getEntry(id).reqSeq === item.reqSeq) {
        setEntry(id, { status: 'idle', reqSeq: item.reqSeq })
      }
      log.emit(DECISION.Drop, id, {
        reason: 'left-viewport',
        waitedMs: now() - item.enqueuedAt,
        queued: queue.length,
      })
      item.markSent(false)
      item.settle()
    }
    return null
  }

  /** An explicit request is never refused. The ceiling exists to stop
   *  background work growing without bound while the user scrolls; a click is
   *  not background work, and a queue length must never be the reason a
   *  button does nothing. */
  function hasQueueRoom(origin) {
    if (origin !== 'auto') return true
    if (!cfg.maxQueueLength) return true
    return queue.length < cfg.maxQueueLength
  }

  function refuse(messageId) {
    log.emit(DECISION.Drop, messageId, {
      reason: 'queue-full',
      queued: queue.length,
      max: cfg.maxQueueLength,
    })
    return { ok: false, dropped: true }
  }

  function pump() {
    while (activeCount < cfg.maxConcurrent && queue.length > 0) {
      const item = takeNext()
      if (!item) return
      runJob(item)
    }
  }

  async function runJob(item) {
    const isAuto = item.origin === 'auto'
    activeCount += 1
    if (isAuto) activeAutoCount += 1
    const controller = new AbortController()
    const sentAt = now()
    // The slot ledger, per JOB. The inflight map cannot serve this purpose:
    // it is keyed by messageId, and during a supersede two requests for the
    // same message are genuinely outstanding at once — the aborted-but-alive
    // old one (the transport cannot cancel mid-flight) and the new one. A
    // per-message map undercounts that, which made the slot-leak invariant
    // fire on every supersede window. This record lives exactly as long as
    // the slot: added here, removed in release().
    const slotRecord = { messageId: item.messageId, origin: item.origin, sentAt }
    running.add(slotRecord)
    inflight.set(item.messageId, {
      controller,
      reqSeq: item.reqSeq,
      sentAt,
      origin: item.origin,
      release: () => release(),
    })

    // The slot models an outstanding *request*, so it is given back the
    // moment the wire is free — not after the result has been persisted.
    // Holding it across the IndexedDB write would idle the queue for a
    // database round trip on every single translation.
    let released = false
    const release = () => {
      if (released) return
      released = true
      activeCount -= 1
      if (isAuto) activeAutoCount -= 1
      running.delete(slotRecord)
      pump()
    }

    // Default covers the early returns taken when a newer generation has
    // already superseded this job: not a failure, just no longer ours.
    let outcome = { ok: false, superseded: true }

    // The slot is ours and the request is about to go out: this is the point
    // where 'loading' becomes true.
    if (getEntry(item.messageId).reqSeq === item.reqSeq) {
      setEntry(item.messageId, { ...getEntry(item.messageId), status: 'loading' })
    }

    // The one point at which a queued candidate becomes a real request. Rate
    // accounting hangs off this rather than off the enqueue: most automatic
    // candidates never get here.
    item.markSent(true)
    log.emit(DECISION.Send, item.messageId, {
      origin: item.origin,
      targetLang: item.targetLang,
      // How long the job sat in the queue. The gap between this and the
      // round-trip time is what tells a saturated gate apart from a slow
      // backend.
      waitedMs: sentAt - item.enqueuedAt,
      active: `${activeCount}/${cfg.maxConcurrent}`,
      auto: `${activeAutoCount}/${cfg.maxConcurrentAuto}`,
    })

    // A request that never replies would otherwise hold its slot forever.
    // The timer is the only thing that can end such a job: there is no
    // rejection to catch and nothing else to wait on.
    let timeoutTimer = null
    let timedOut = false
    const withTimeout = (promise) => {
      if (!cfg.timeoutMs) return promise
      return new Promise((resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          timedOut = true
          // Reject BEFORE aborting. Aborting can make the transport reject
          // synchronously, and an AbortError winning this race would be
          // classified as somebody else's cancellation — exempt from failure
          // accounting — rather than as the outage it actually is.
          reject(timeoutError(cfg.timeoutMs))
          controller.abort()
        }, cfg.timeoutMs)
        promise.then(resolve, reject)
      })
    }

    try {
      const result = await withTimeout(
        translate(
          nats,
          { text: item.text, targetLang: item.targetLang },
          { signal: controller.signal },
        ),
      )
      release()

      if (getEntry(item.messageId).reqSeq !== item.reqSeq) return

      const identical = result.translatedText === item.text
      await cache.content.set({
        messageId: item.messageId,
        roomId: item.roomId,
        targetLang: item.targetLang,
        srcVersion: item.srcVersion,
        translatedText: result.translatedText,
        originalText: item.text,
      })

      outcome = { ok: true }
      if (getEntry(item.messageId).reqSeq !== item.reqSeq) return
      setEntry(item.messageId, {
        status: 'translated',
        targetLang: item.targetLang,
        translatedText: identical ? item.text : result.translatedText,
        identical,
        srcVersion: item.srcVersion,
        reqSeq: item.reqSeq,
      })
    } catch (err) {
      release()
      // An abort is somebody else's decision that already reset this entry.
      // Reporting it as a failure would show an error for a state the user
      // deliberately moved away from — and would count against the automatic
      // circuit breaker for something that was not an outage.
      if (isAbort(err) && !timedOut) {
        outcome = { ok: false, aborted: true, error: err }
        return
      }
      outcome = { ok: false, error: err }
      if (getEntry(item.messageId).reqSeq !== item.reqSeq) return
      setEntry(item.messageId, {
        ...getEntry(item.messageId),
        status: 'failed',
        error: err,
      })
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      release()
      if (inflight.get(item.messageId)?.reqSeq === item.reqSeq) {
        inflight.delete(item.messageId)
      }
      log.emit(DECISION.Settle, item.messageId, {
        origin: item.origin,
        ok: outcome.ok,
        aborted: outcome.aborted,
        superseded: outcome.superseded,
        error: outcome.error,
        tookMs: now() - sentAt,
      })
      // Resolved, never rejected: a failed translation is a UI state, not an
      // exception for the caller to catch. The descriptor is how a policy
      // layer learns the outcome without the store having to throw.
      item.settle(outcome)
    }
  }

  /**
   * Queue a translation. `origin` is an explicit parameter rather than
   * something derived from stored intent: the queue classifies jobs
   * synchronously, while intent lives behind an async read whose write races
   * the very click that caused it.
   */
  function translateMessage(
    messageId,
    { roomId, text, targetLang, srcVersion, origin = 'manual', onSent },
  ) {
    const current = getEntry(messageId)
    const alreadyRunning =
      IN_PROGRESS.has(current.status) &&
      current.targetLang === targetLang &&
      current.srcVersion === srcVersion
    if (alreadyRunning) {
      log.emit(DECISION.Deduped, messageId, { origin, status: current.status })
      return Promise.resolve({ ok: true, deduped: true })
    }

    // Refused before the entry is touched, so the message stays idle rather
    // than showing an error for a request that was never attempted — a later
    // view can simply try again.
    if (!hasQueueRoom(origin)) {
      onSent?.(false)
      return Promise.resolve(refuse(messageId))
    }

    const reqSeq = invalidate(messageId)

    // 'queued', not 'loading'. The job may sit here behind the concurrency
    // gate, and may never be sent at all if its message scrolls away first.
    // Calling that "loading" makes a saturated queue look exactly like a slow
    // backend — the one distinction worth being able to see.
    setEntry(messageId, {
      status: 'queued',
      targetLang,
      srcVersion,
      reqSeq,
    })

    // Automatic translation never records intent. "No intent + switch on" IS
    // the auto state, which is what makes switching auto off fall straight
    // back to the source text with no restore pass.
    //
    // The write runs alongside the request, not before it: the two are
    // independent, and gating the queue on a database round-trip would add
    // that latency to every single translation the user asks for.
    const intentWrite =
      origin === 'manual'
        ? cache.intent.set(messageId, roomId, 'manual')
        : Promise.resolve()

    let settle
    const jobDone = new Promise((resolve) => {
      settle = resolve
    })

    queue.push({
      // Called with true the moment the request goes on the wire, false if
      // the job is dropped first. Separate from `settle` because the two
      // answer different questions: "did this reach the backend" governs rate
      // accounting, "how did it end" governs the circuit breaker.
      markSent: onSent ?? (() => {}),
      messageId,
      roomId,
      text,
      targetLang,
      srcVersion,
      origin,
      reqSeq,
      enqueuedAt: now(),
      settle,
    })
    log.emit(DECISION.Enqueue, messageId, {
      origin,
      targetLang,
      queued: queue.length,
      active: `${activeCount}/${cfg.maxConcurrent}`,
      auto: `${activeAutoCount}/${cfg.maxConcurrentAuto}`,
    })
    pump()

    return Promise.all([jobDone, intentWrite]).then(([result]) => result)
  }

  /**
   * Decide what a freshly mounted message shows, in the one order that keeps
   * intent authoritative:
   *   intent 'off'    -> source text, no request
   *   intent 'manual' -> translate regardless of the global switch
   *   no intent       -> translate only while the switch is on
   */
  async function ensureForView(
    messageId,
    { roomId, text, targetLang, srcVersion, autoTranslate },
  ) {
    const current = getEntry(messageId)
    const settledForThisView =
      current.targetLang === targetLang &&
      current.srcVersion === srcVersion &&
      (IN_PROGRESS.has(current.status) || current.status === 'translated')
    if (settledForThisView) return { outcome: 'settled' }

    // This function is not atomic: between here and the enqueue sit two
    // cache reads, and a revert or an edit can land inside that window. The
    // sequence captured now is re-checked before the enqueue — losing that
    // race must mean standing down, or the enqueue takes a fresh generation
    // and translates a message whose user just said "see original".
    const seqAtStart = current.reqSeq

    const intent = await cache.intent.get(messageId)
    if (intent === 'off') {
      log.emit(DECISION.Suppressed, messageId, { reason: 'see-original' })
      return { outcome: 'suppressed' }
    }

    const wanted = intent === 'manual' || autoTranslate
    if (!wanted) {
      log.emit(DECISION.Suppressed, messageId, { reason: 'auto-off-no-intent' })
      return { outcome: 'suppressed' }
    }

    const cached = await cache.content.get(messageId, { targetLang, srcVersion })

    // The atomicity re-check, placed BEFORE the cached branch: a cache hit
    // writes 'translated' into the entry, which would overwrite a revert
    // just as surely as a fresh request would. A moved sequence means
    // somebody — a revert, an edit, another request — changed this message's
    // state while the reads above were in flight; their decision is newer.
    if (getEntry(messageId).reqSeq !== seqAtStart) {
      return { outcome: 'superseded', sent: Promise.resolve(false) }
    }

    if (cached) {
      setEntry(messageId, {
        status: 'translated',
        targetLang,
        translatedText: cached.identical ? text : cached.translatedText,
        identical: cached.identical,
        srcVersion,
        reqSeq: getEntry(messageId).reqSeq,
      })
      log.emit(DECISION.Cached, messageId, { targetLang, identical: cached.identical })
      return { outcome: 'cached' }
    }

    const origin = intent === 'manual' ? 'manual' : 'auto'

    // Reported as its own outcome rather than as a queued job that fails: the
    // policy layer charges its rate budget and its circuit breaker on
    // 'queued' alone, and neither should move for a request never made.
    if (!hasQueueRoom(origin)) {
      refuse(messageId)
      return { outcome: 'dropped', sent: Promise.resolve(false) }
    }

    let markSent
    const sent = new Promise((resolve) => {
      markSent = resolve
    })

    // Enqueue and return the job promise without awaiting it. A view hook
    // must not stay suspended for the whole round trip — the entry it renders
    // from is already 'loading'. Both promises are handed back so a policy
    // layer can charge its rate budget on `sent` and its circuit breaker on
    // `done`.
    const done = translateMessage(messageId, {
      roomId,
      text,
      targetLang,
      srcVersion,
      origin,
      onSent: markSent,
    })
    return { outcome: 'queued', done, sent }
  }

  /** "See original". Writes 'off' whatever the current mode — one rule, no
   *  mode dependence — so the choice survives an LRU eviction of the text. */
  async function revert(messageId, roomId) {
    const reqSeq = invalidate(messageId)
    setEntry(messageId, { status: 'idle', reqSeq })
    await cache.intent.set(messageId, roomId, 'off')
  }

  /** A new revision invalidates the text, never the intent. Writing 'off'
   *  here is what would make an edited message opt out of automatic
   *  translation permanently. */
  async function onMessageEdited(messageId) {
    const reqSeq = invalidate(messageId)
    setEntry(messageId, { status: 'idle', reqSeq })
    await cache.content.clear(messageId)
  }

  async function onMessagesDeleted(messageIds) {
    for (const id of messageIds) {
      invalidate(id)
      entries.delete(id)
    }
    emit()
    await cache.clearMessages(messageIds)
  }

  async function onRoomLeft(roomId) {
    await cache.clearRoom(roomId)
  }

  async function onLogout() {
    for (const id of [...inflight.keys()]) invalidate(id)
    // Same defect class as the invalidate purge: truncating the queue
    // without settling its jobs leaves their promises pending forever, and a
    // policy awaiting `sent` on one of them never learns the answer.
    for (const item of queue.splice(0)) {
      item.markSent(false)
      item.settle({ ok: false, superseded: true })
    }
    entries.clear()
    emit()
    await cache.clearAll()
  }

  /**
   * Give back the concurrency slot for a request that is still on the wire.
   *
   * Used when a message scrolls away or the user changes room: the reply is
   * already paid for server-side, and under request/reply an abort has
   * nowhere to deliver it. Cancelling would waste the work AND lose the
   * result; holding the slot would idle the queue behind a message nobody is
   * looking at. So: release the budget, keep the request.
   */
  function detach(messageId) {
    inflight.get(messageId)?.release()
  }

  return {
    config: cfg,
    getEntry,
    subscribe,
    translate: translateMessage,
    ensureForView,
    revert,
    detach,
    onMessageEdited,
    onMessagesDeleted,
    onRoomLeft,
    onLogout,
    stats: () => ({ activeCount, activeAutoCount, queued: queue.length }),
    /**
     * A copy of everything the invariant checks need. Deliberately separate
     * from stats(): stats() is three numbers for a display, this is the
     * internal state the queue is asserted against, and neither should have
     * to grow into the other.
     */
    inspect: () => ({
      config: cfg,
      activeCount,
      activeAutoCount,
      queue: queue.map(({ messageId, origin, enqueuedAt }) => ({
        messageId,
        origin,
        enqueuedAt,
      })),
      // From the slot ledger, not the inflight map: this is what the
      // slot-leak invariant compares activeCount against, and the two are
      // mutated together synchronously.
      inflight: [...running].map((job) => ({
        messageId: job.messageId,
        origin: job.origin,
        sentAt: job.sentAt,
      })),
      entries: [...entries.entries()].map(([messageId, entry]) => ({
        messageId,
        status: entry.status,
        since: entry.since,
      })),
    }),
  }
}
```

### 5.2 visibilityObserver.js — 可視性→候選

檔案:`src/context/TranslationContext/visibilityObserver.js`

```js
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

  function observe(id, element) {
    if (!element) return
    // Idempotent: a re-render that re-registers the same element must not
    // restart a dwell the user has already partly served.
    if (elements.get(id) === element) {
      ensureObserver().observe(element)
      return
    }
    if (elements.has(id)) unobserve(id)

    elements.set(id, element)
    elementIds.set(element, id)
    ensureObserver().observe(element)
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

    if (elements.size === 0) return
    const next = ensureObserver()
    for (const element of elements.values()) next.observe(element)
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
    setRoot,
    setViewportCentre,
    byDistanceFromCentre,
    destroy,
  }
}
```

### 5.3 autoPolicy.js — 決策層與修復 sweep

檔案:`src/context/TranslationContext/autoPolicy.js`

```js
// The automatic-translation policy layer.
//
// It decides *whether* a message the user dwelled on should be translated.
// It does not translate anything itself: it hands the message to the same
// store action the Translate button uses, with `origin: 'auto'`. One request
// path, one queue, one cache — the policy only adds gates in front.
//
// Gate order is deliberate and cheapest-first, because a language-detection
// step is expected to land between dwell and the queue. Anything decidable
// from the message object alone runs before anything that costs a lookup.

import { DECISION, NOOP_DECISION_LOG } from './decisionLog'

// No scrollIdleMs here, deliberately: the "hold dwell until scrolling stops"
// refinement was cut from this iteration, and measurement showed dwell only
// filters ~3% at realistic scroll speeds — doing it for real means rethinking
// dwell itself, not adding a delay constant nothing reads. Its earlier
// presence as a declared-but-unwired knob is exactly the defect class the
// "every declared knob is wired" test now guards against.
export const AUTO_TRANSLATE_CONFIG = {
  dwellMs: 400,
  prefetchMarginPx: 0,
  maxConcurrent: 4,
  // Strictly below maxConcurrent so an explicit request always has somewhere
  // to run.
  maxConcurrentAuto: 2,
  // Safe only because recheckVisible re-offers what is still on screen. On
  // its own a ceiling strands whatever was visible when it bit: the observer
  // raises a candidate once per visibility transition, so a refused message
  // that does not move never gets a second chance. Measured on a scroll-then-
  // read, with the ceiling but without the sweep: 2 of the 12 messages on
  // screen were ever translated.
  maxQueueLength: 50,
  // How often idle-but-visible messages are re-offered. This is a repair
  // path, so a second of latency costs nothing; sweeping much faster would
  // just re-ask the same questions between settles.
  recheckIntervalMs: 1000,
  // A runaway guard, not a capacity control. Sustained reading sits around
  // 1-2 requests a minute; 60 is far above anything a human generates and far
  // below anything that would hurt the backend.
  maxRequestsPerMinute: 60,
  failureCircuitThreshold: 5,
  failureCircuitCooldownMs: 30_000,
  timeoutMs: 15_000,
  skipNonTextual: true,
}

export const SKIP = {
  AutoDisabled: 'auto-disabled',
  Inactive: 'inactive',
  UnknownMessage: 'unknown-message',
  OwnMessage: 'own-message',
  SystemMessage: 'system-message',
  NonTextual: 'non-textual',
  RateLimited: 'rate-limited',
  CircuitOpen: 'circuit-open',
  InternalError: 'internal-error',
}

const HAS_LETTER = /\p{L}/u
const RATE_WINDOW_MS = 60_000

function bodyOf(message) {
  return message?.content ?? message?.msg ?? ''
}

/**
 * The per-message gates, as an ordered list rather than an if-chain so a new
 * rule is an insertion rather than an edit. Local language detection belongs
 * at the end of this list: after dwell, before the queue. Placing it earlier
 * would run it for every message the user scrolls past, which is exactly the
 * cost dwell exists to avoid.
 */
export function createSkipRules(config) {
  return [
    (message) => (message ? null : SKIP.UnknownMessage),
    (message, ctx) =>
      message.sender?.account === ctx.currentUserAccount ? SKIP.OwnMessage : null,
    (message) => (message.sysMsgData != null ? SKIP.SystemMessage : null),
    (message) =>
      config.skipNonTextual && !HAS_LETTER.test(bodyOf(message)) ? SKIP.NonTextual : null,
  ]
}

export function createAutoPolicy({
  store,
  getMessage,
  getContext,
  getVisibleIds,
  config = {},
  log = NOOP_DECISION_LOG,
  now = () => Date.now(),
}) {
  const cfg = { ...AUTO_TRANSLATE_CONFIG, ...config }
  const rules = createSkipRules(cfg)

  let recentRequests = []
  let consecutiveFailures = 0
  let circuitOpenUntil = 0
  let circuitCooldownMs = cfg.failureCircuitCooldownMs
  let probing = false

  function circuitBlocks() {
    if (consecutiveFailures < cfg.failureCircuitThreshold) return false
    if (now() < circuitOpenUntil) return true
    // Cooldown elapsed: let exactly one request through to test the water.
    if (probing) return true
    probing = true
    return false
  }

  function rateLimited() {
    const cutoff = now() - RATE_WINDOW_MS
    recentRequests = recentRequests.filter((t) => t > cutoff)
    return recentRequests.length >= cfg.maxRequestsPerMinute
  }

  function recordSuccess() {
    consecutiveFailures = 0
    circuitOpenUntil = 0
    circuitCooldownMs = cfg.failureCircuitCooldownMs
    probing = false
  }

  function recordFailure(err) {
    probing = false
    // A rejected input is our bug, not an outage. Counting it would let one
    // malformed message switch the feature off for the whole session.
    if (err?.code === 'bad_request') return

    const wasOpen = consecutiveFailures >= cfg.failureCircuitThreshold
    consecutiveFailures += 1
    if (consecutiveFailures < cfg.failureCircuitThreshold) return

    if (wasOpen) {
      // A probe just failed — widen the window rather than retry at the same
      // cadence against a backend that is still down.
      circuitCooldownMs *= 2
    }
    circuitOpenUntil = now() + circuitCooldownMs
  }

  /**
   * Called once per message the user has dwelled on. Returns `{ skipped }`
   * with a reason, or the store's outcome. Automatic failures are silent by
   * design: the message simply stays in its source language.
   *
   * Never rejects. Both callers — the dwell timer and the sweep interval —
   * fire without a catch, so a rejection here (a broken IndexedDB rejecting
   * the first cache read, say) would surface as one unhandled rejection per
   * second, forever. An internal error becomes a logged skip and nothing
   * more: it says nothing about the backend, so it must not feed the
   * circuit breaker either.
   */
  async function onCandidate(messageId) {
    try {
      return await offerCandidate(messageId)
    } catch (err) {
      log.emit(DECISION.Skip, messageId, { reason: SKIP.InternalError, error: err })
      return { skipped: SKIP.InternalError }
    }
  }

  async function offerCandidate(messageId) {
    const skip = (reason, fields) => {
      log.emit(DECISION.Skip, messageId, { reason, ...fields })
      return { skipped: reason }
    }

    const ctx = getContext()
    if (!ctx.autoTranslate) return skip(SKIP.AutoDisabled)
    if (!ctx.active) return skip(SKIP.Inactive)

    const message = getMessage(messageId)
    for (const rule of rules) {
      const reason = rule(message, ctx)
      if (reason) return skip(reason)
    }

    if (circuitBlocks()) {
      return skip(SKIP.CircuitOpen, {
        failures: consecutiveFailures,
        reopensInMs: Math.max(0, circuitOpenUntil - now()),
      })
    }
    if (rateLimited()) return skip(SKIP.RateLimited, { inWindow: recentRequests.length })

    const result = await store.ensureForView(messageId, {
      roomId: ctx.roomId,
      text: bodyOf(message),
      targetLang: ctx.targetLang,
      srcVersion: message.editedAt ?? 0,
      autoTranslate: true,
    })

    // A cache hit or a suppressed message costs nothing, and charging for
    // them would throttle the cheapest paths hardest.
    if (result?.outcome !== 'queued') {
      probing = false
      return result ?? {}
    }

    try {
      // Charged when the request actually goes out, not when the candidate is
      // accepted. Most automatic candidates never reach the backend: they sit
      // in the queue until their message scrolls away and are dropped at pick
      // time. Charging at enqueue lets one brisk scroll spend the whole
      // minute's budget on requests that were never made, after which every
      // further candidate is silently rate-limited and automatic translation
      // stops for the rest of the window. Measured over a 100-message scroll
      // before this change: 60 accepted, 14 sent, 36 then rate-limited.
      if (!(await result.sent)) {
        // It never ran, so it is neither a probe result nor a data point for
        // the breaker.
        probing = false
        return result
      }
      recentRequests.push(now())

      // The store settles rather than throws: a failed translation is a UI
      // state, not an exception. Reading only the rejection path is how a
      // circuit breaker ends up never tripping — every job looks successful.
      const settled = await result.done
      if (settled?.ok === false && !settled.aborted && !settled.superseded) {
        recordFailure(settled.error)
      } else {
        recordSuccess()
      }
    } catch (err) {
      recordFailure(err)
    }
    return result
  }

  /**
   * Re-offer messages that are on screen and have nothing happening to them.
   *
   * The visibility observer raises a candidate once per visibility
   * transition. Anything that ends a job without translating it — a full
   * queue, a slot lost to a scroll that came back — leaves the message idle,
   * still on screen, and with nothing left to re-trigger it: it is not moving,
   * so no further intersection entry is ever delivered. Measured before this
   * existed: after scrolling and stopping, 10 of the 12 messages on screen
   * stayed in their source language indefinitely.
   *
   * Swept rather than driven by a "capacity freed" event, deliberately. The
   * failure being repaired is precisely that no event arrives; a repair that
   * itself waits for one inherits the same blind spot.
   *
   * Only `idle` is re-offered. `failed` is left alone or a body the backend
   * will always reject becomes an unbounded retry loop — and a bad_request
   * never trips the circuit breaker, so nothing else would stop it.
   */
  async function recheckVisible() {
    const ids = getVisibleIds?.()
    if (!ids) return

    // Checked here, silently, before any per-message work. The sweep fires
    // every second for as long as the page lives; while the switch is off or
    // the page is hidden, logging a skip per visible message per tick would
    // churn the decision log's whole buffer in minutes — evicting exactly
    // the history a diagnosis needs.
    const ctx = getContext()
    if (!ctx.autoTranslate || !ctx.active) return

    for (const id of ids) {
      if (store.getEntry(id).status !== 'idle') continue
      // Fire-and-forget: onCandidate resolves when the translation SETTLES,
      // so awaiting it here would repair one message per tick instead of one
      // sweep. Deduplication is the store's status check above, not this
      // loop's ordering — and onCandidate never rejects.
      onCandidate(id)
    }
  }

  return {
    config: cfg,
    onCandidate,
    recheckVisible,
    // The circuit governs background work only. Manual requests never reach
    // this module; the flag keeps that a stated contract.
    gatesManualRequests: false,
    stats: () => ({
      consecutiveFailures,
      circuitOpen: consecutiveFailures >= cfg.failureCircuitThreshold,
      circuitOpenUntil,
      requestsInWindow: recentRequests.length,
    }),
  }
}
```

### 5.4 decisionLog.js — 決策軌跡

檔案:`src/context/TranslationContext/decisionLog.js`

```js
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
```

### 5.5 invariants.js — 執行期不變量

檔案:`src/context/TranslationContext/invariants.js`

```js
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
```

### 5.6 TranslationContext.jsx — provider 組裝

檔案:`src/context/TranslationContext/TranslationContext.jsx`

```jsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { translateText } from '@/api'
import { createTranslateTextStub } from '@/api/translateText/stub'
import { useNats } from '@/context/NatsContext'
import { translationCache } from '@/lib/idbTranslationCache'
import {
  DEFAULT_AUTO_TRANSLATE,
  DEFAULT_TARGET_LANG,
  getAutoTranslate,
  getTargetLang,
  setAutoTranslate as persistAutoTranslate,
  setTargetLang as persistTargetLang,
} from '@/lib/translationSettings'
import {
  TRANSLATE_STUB_DELAY_MS,
  TRANSLATE_STUB_MODE,
  TRANSLATE_USE_STUB,
} from '@/lib/runtimeConfig'
import { AUTO_TRANSLATE_CONFIG, createAutoPolicy } from './autoPolicy'
import { DECISION, createDecisionLog } from './decisionLog'
import { checkInvariants } from './invariants'
import { IDLE_ENTRY, createTranslationStore } from './store'
import { createVisibilityObserver } from './visibilityObserver'

/** How often the queue is audited against its own guarantees. Frequent enough
 *  that a stall shows up while you are still looking at the screen, rare
 *  enough to cost nothing. */
const INVARIANT_INTERVAL_MS = 2000

const TranslationContext = createContext(null)

function resolveTranslate() {
  if (!TRANSLATE_USE_STUB) return translateText
  return createTranslateTextStub({
    mode: TRANSLATE_STUB_MODE,
    delayMs: TRANSLATE_STUB_DELAY_MS,
  })
}

export function TranslationProvider({ children, translate, cache }) {
  const nats = useNats()

  const [targetLang, setTargetLangState] = useState(getTargetLang)
  const [autoTranslate, setAutoTranslateState] = useState(getAutoTranslate)

  const setTargetLang = useCallback((lang) => {
    persistTargetLang(lang)
    // Read back rather than trusting the argument: the settings layer rejects
    // an unsupported value, and the UI must not display a language that was
    // never stored.
    setTargetLangState(getTargetLang())
  }, [])

  const setAutoTranslate = useCallback((enabled) => {
    persistAutoTranslate(enabled)
    setAutoTranslateState(getAutoTranslate())
  }, [])

  // Message bodies for the ids the observer is watching. Registration
  // supplies both at once, so the policy never has to reach into a message
  // store it does not own.
  const registryRef = useRef(new Map())
  const contextRef = useRef({})
  contextRef.current = {
    targetLang,
    autoTranslate,
    currentUserAccount: nats?.user?.account,
  }

  // useState's lazy initialiser, not useMemo: these own a queue, in-flight
  // AbortControllers and a live IntersectionObserver, so a second set would
  // strand real work. useMemo is a caching hint React may discard, and
  // StrictMode's double render makes that observable.
  //
  // Built observer -> store -> policy so the store receives its automatic
  // gates at construction rather than having them patched in afterwards.
  const [{ store, auto }] = useState(() => {
    let policy = null
    let candidateId = null

    // One log shared by all three. Their decisions are only interpretable
    // together — the observer's "hidden" is the reason the queue's "drop"
    // happened — and interleaving them in one ordered buffer is the whole
    // point.
    const log = createDecisionLog()

    const observer = createVisibilityObserver({
      dwellMs: AUTO_TRANSLATE_CONFIG.dwellMs,
      prefetchMarginPx: AUTO_TRANSLATE_CONFIG.prefetchMarginPx,
      log,
      onCandidate: (id) => {
        candidateId = id
        policy?.onCandidate(id)
      },
    })

    const createdStore = createTranslationStore({
      nats,
      translate: translate ?? resolveTranslate(),
      cache: cache ?? translationCache,
      log,
      config: {
        maxConcurrent: AUTO_TRANSLATE_CONFIG.maxConcurrent,
        maxConcurrentAuto: AUTO_TRANSLATE_CONFIG.maxConcurrentAuto,
        // Passed through explicitly rather than left to the store's own
        // defaults: AUTO_TRANSLATE_CONFIG is where these numbers are declared
        // and read, and a declared knob that nothing wires up is worse than
        // no knob at all.
        timeoutMs: AUTO_TRANSLATE_CONFIG.timeoutMs,
        maxQueueLength: AUTO_TRANSLATE_CONFIG.maxQueueLength,
        // Re-checked when a slot frees, not when the job was queued: a
        // message can scroll away while it waits, and translating it then is
        // pure waste.
        isAutoEligible: (id) => observer.visibleIds.has(id),
        orderAutoQueue: (ids) => observer.byDistanceFromCentre(ids),
      },
    })

    policy = createAutoPolicy({
      store: createdStore,
      log,
      getVisibleIds: () => observer.visibleIds,
      getMessage: (id) => registryRef.current.get(id)?.message,
      getContext: () => ({
        ...contextRef.current,
        // Read at call time, never snapshotted at render time. A tab that
        // loads in the background renders `false` exactly once, and coming to
        // the foreground re-renders nothing — a snapshot then reports the
        // page hidden while the user is looking straight at it, and every
        // candidate is skipped 'inactive' with no way to see why.
        active: typeof document === 'undefined' || document.visibilityState === 'visible',
        roomId: registryRef.current.get(candidateId)?.roomId,
      }),
    })

    const snapshot = () => ({
      ...createdStore.inspect(),
      visibleIds: [...observer.visibleIds],
      registeredIds: observer.registeredIds(),
    })

    return { store: createdStore, auto: { policy, observer, log, snapshot } }
  })

  // A backgrounded tab must not keep translating, and on return the viewport
  // is re-evaluated rather than resuming a queue built for a screen the user
  // has since scrolled away from.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') auto.observer.reset()
    }
    document.addEventListener('visibilitychange', onVisibility)
    // Only the listener is torn down here. The observer's registry belongs to
    // the provider, not to this effect: destroying it in the cleanup empties
    // the registry on StrictMode's mount/unmount/mount cycle, and the message
    // refs that filled it have already fired and will not fire again. The
    // result is an observer watching nothing, which presents as automatic
    // translation silently never happening.
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [auto])

  // Audit the queue against its own guarantees. A stalled queue produces no
  // error and no failed request — the only symptom is that messages quietly
  // stop being translated — so the properties are checked directly rather
  // than inferred from the UI.
  //
  // Each violation is reported once per continuous occurrence: a stall that
  // lasts a minute is one line, not thirty.
  useEffect(() => {
    const reported = new Set()
    const timer = setInterval(() => {
      const violations = checkInvariants(auto.snapshot())
      const seen = new Set()
      for (const violation of violations) {
        const key = `${violation.code}:${violation.messageId ?? ''}`
        seen.add(key)
        if (reported.has(key)) continue
        reported.add(key)
        auto.log.emit(DECISION.Violation, violation.messageId, {
          code: violation.code,
          detail: violation.detail,
        })
      }
      for (const key of [...reported]) if (!seen.has(key)) reported.delete(key)
    }, INVARIANT_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [auto])

  // Re-offer messages sitting on screen with nothing happening to them. The
  // observer raises a candidate once per visibility transition, so a message
  // whose job ended without translating it — a full queue, a slot lost to a
  // scroll that came back — has nothing left to re-trigger it while it stays
  // still. A sweep repairs that without depending on an event; depending on
  // one would inherit the same blind spot.
  useEffect(() => {
    const timer = setInterval(() => {
      auto.policy.recheckVisible()
    }, AUTO_TRANSLATE_CONFIG.recheckIntervalMs)
    return () => clearInterval(timer)
  }, [auto])

  // A console handle, because the questions worth asking here are ad hoc:
  // "what happened to this one message", "is the queue actually stuck".
  // Attached in an effect so it follows the provider's lifetime.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    window.__translate = {
      log: auto.log,
      store,
      observer: auto.observer,
      policy: auto.policy,
      snapshot: auto.snapshot,
      check: () => checkInvariants(auto.snapshot()),
      timeline: (messageId) => auto.log.timeline(messageId),
      print: (on = true) => auto.log.setPrinting(on),
    }
    return () => {
      delete window.__translate
    }
  }, [auto, store])

  const registerMessage = useCallback(
    (message, roomId, element) => {
      if (!element) {
        registryRef.current.delete(message.id)
        auto.observer.unobserve(message.id)
        store.detach(message.id)
        return
      }
      registryRef.current.set(message.id, { message, roomId })
      auto.observer.observe(message.id, element)
    },
    [auto, store],
  )

  const setScrollRoot = useCallback((element) => auto.observer.setRoot(element), [auto])

  const value = useMemo(
    () => ({
      store,
      auto,
      targetLang,
      autoTranslate,
      setTargetLang,
      setAutoTranslate,
      registerMessage,
      setScrollRoot,
    }),
    [
      store,
      auto,
      targetLang,
      autoTranslate,
      setTargetLang,
      setAutoTranslate,
      registerMessage,
      setScrollRoot,
    ],
  )

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>
}

export function useTranslation() {
  const ctx = useContext(TranslationContext)
  if (!ctx) throw new Error('useTranslation must be used within TranslationProvider')
  return ctx
}

/** Null outside a provider. Message rendering is shared surface: requiring
 *  the translation provider everywhere a bubble appears would couple every
 *  consumer of MessageRow to this feature. */
export function useOptionalTranslation() {
  return useContext(TranslationContext)
}

const NO_STORE_SUBSCRIBE = () => () => {}
const getIdle = () => IDLE_ENTRY

/** Subscribe to one message's display state. Entries are replaced wholesale
 *  on every transition, so identity comparison is enough for the snapshot and
 *  no selector memoisation is needed. */
export function useTranslationEntry(messageId) {
  const ctx = useOptionalTranslation()
  const store = ctx?.store
  const getSnapshot = useCallback(
    () => (store ? store.getEntry(messageId) : IDLE_ENTRY),
    [store, messageId],
  )
  return useSyncExternalStore(store?.subscribe ?? NO_STORE_SUBSCRIBE, getSnapshot, getIdle)
}

/** Ref callback that hands a mounted message and its element to the
 *  visibility observer. Returns a no-op outside a provider so message
 *  rendering stays usable without this feature wired up. */
export function useAutoTranslateRegistration(message, roomId) {
  const ctx = useOptionalTranslation()
  const registerMessage = ctx?.registerMessage
  return useCallback(
    (element) => {
      if (!registerMessage) return
      registerMessage(message, roomId, element)
    },
    // `message` is intentionally keyed by id and revision: a new object for
    // the same unchanged message must not churn the observer registration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registerMessage, message.id, message.editedAt, roomId],
  )
}

/** Tells the observer which element actually scrolls, so intersection is
 *  measured against the message list rather than the whole document. */
export function useAutoTranslateScrollRoot() {
  const ctx = useOptionalTranslation()
  const setScrollRoot = ctx?.setScrollRoot
  return useCallback(
    (element) => {
      if (!setScrollRoot) return
      setScrollRoot(element ?? null)
    },
    [setScrollRoot],
  )
}

const NOOP = () => {}

/** Degrades to read-only defaults outside a provider so header chrome can be
 *  rendered in isolation. `available` tells a caller whether the controls
 *  will actually do anything. */
export function useTranslationSettings() {
  const ctx = useOptionalTranslation()
  return {
    available: !!ctx,
    targetLang: ctx?.targetLang ?? DEFAULT_TARGET_LANG,
    autoTranslate: ctx?.autoTranslate ?? DEFAULT_AUTO_TRANSLATE,
    setTargetLang: ctx?.setTargetLang ?? NOOP,
    setAutoTranslate: ctx?.setAutoTranslate ?? NOOP,
  }
}

/** The two halves of the user's explicit choice. Both are recorded as intent
 *  so they outlive an eviction of the cached text.
 *
 *  `available` is false outside a provider; callers render no control rather
 *  than a button that cannot work. */
export function useTranslationActions() {
  const ctx = useOptionalTranslation()
  const store = ctx?.store
  const targetLang = ctx?.targetLang

  const translate = useCallback(
    (message, roomId) => {
      if (!store) return Promise.resolve()
      return store.translate(message.id, {
        roomId,
        text: message.content ?? message.msg ?? '',
        targetLang,
        srcVersion: message.editedAt ?? 0,
        origin: 'manual',
      })
    },
    [store, targetLang],
  )

  const revert = useCallback(
    (message, roomId) => (store ? store.revert(message.id, roomId) : Promise.resolve()),
    [store],
  )

  return { available: !!store, translate, revert }
}

/** Queue state, invariant violations and the tail of the decision log, for
 *  the diagnostics panel.
 *
 *  Polled rather than subscribed: the interesting readings — how long a job
 *  has been on the wire, whether the queue is draining — are functions of
 *  elapsed time, and no state change fires while a queue sits stuck. An
 *  event-driven panel goes blank at exactly the moment you need it. */
export function useTranslationDiagnostics({ intervalMs = 500, tail = 40 } = {}) {
  const ctx = useOptionalTranslation()
  const auto = ctx?.auto
  const [reading, setReading] = useState(null)

  useEffect(() => {
    if (!auto) return undefined
    const sample = () => {
      const snapshot = auto.snapshot()
      setReading({
        snapshot,
        violations: checkInvariants(snapshot),
        records: auto.log.records().slice(-tail).reverse(),
        printing: auto.log.isPrinting(),
      })
    }
    sample()
    const timer = setInterval(sample, intervalMs)
    return () => clearInterval(timer)
  }, [auto, intervalMs, tail])

  return {
    available: !!auto,
    log: auto?.log ?? null,
    snapshot: reading?.snapshot ?? null,
    violations: reading?.violations ?? [],
    records: reading?.records ?? [],
    printing: reading?.printing ?? false,
  }
}
```

---

## 6. 移植適配點(唯一允許改動的地方)

1. **`translate` 函數**(store 建構參數):簽名
   `async (nats, {text, targetLang}, {signal}) => {translatedText, targetLang}`。
   換成你們的翻譯服務 client 即可;失敗以 `error.code` 分類
   (`bad_request` / `unavailable` / `timeout` / `internal`)——斷路器與重試
   語意依賴這些 code。重試策略屬 transport 層:手動路徑可重試 `unavailable`
   (3 次,0.5/1/2s),**自動路徑一律 maxAttempts=1**,退避交給斷路器,否則
   每個自動工作在飽和後端上變成三個真實請求並佔格子走完整條重試梯。
2. **cache 介面**(store 建構參數),需實作:
   `intent.get(id)` / `intent.set(id, roomId, 'manual'|'off')`、
   `content.get(id, {targetLang, srcVersion})` / `content.set({...})` /
   `content.clear(id)`、`clearMessages(ids)` / `clearRoom(roomId)` / `clearAll()`。
   關鍵設計:**intent 與 content 分表**。intent 極小、永不淘汰(它是使用者的
   明確選擇);content 可 LRU 淘汰。淘汰掉譯文不會忘記使用者要看原文。
3. **provider 的 import 路徑與 UI hooks**:`useNats` 換成你們的連線 context;
   settings(targetLang / autoTranslate)換成你們的儲存;其餘 hooks
   (`useTranslationEntry` 等)按你們的元件樹接。
4. **不可改**:三個模組彼此之間的介面(`ensureForView` 的
   `{outcome, done, sent}`、`onCandidate`/`recheckVisible`、observer 的
   `visibleIds`/`registeredIds`/`byDistanceFromCentre`)、decisionLog 的
   `NEVER_PRINTED`、以及 §4 的計費/斷路器語意。

---

## 7. 測試資產(一併移植)

| 檔案 | 釘住什麼 |
|---|---|
| `store.test.js`(51 tests) | 生命週期、queued/loading、dedup、generation、timeout(含 reject-before-abort)、佇列上限、sent 回報、**invalidate purge(缺陷 #9)**、**revert TOCTOU(缺陷 #10)** |
| `visibilityObserver.test.js`(20) | dwell 語意、身分 WeakMap、**負 margin 夾制(含負值輸入)**、**活位置排序(缺陷 #3)** |
| `autoPolicy.test.js`(38+) | skip 規則、RPM(**只計真送出**)、斷路器(bad_request 豁免、指數退避、**並發單一 probe**)、sweep(idle-only、fire-and-forget、靜默 gate)、**never-throws**、**死旋鈕白名單** |
| `TranslationContext.test.jsx`(2) | **合約 C**:背景載入→前景,無 re-render 也要能翻;真隱藏仍拒絕 |
| `decisionLog.test.js`(15)/`invariants.test.js`(21) | ring buffer 語意、內文永不輸出;每條不變量的正反例 |
| `autoTranslate.integration.test.js`(15) | 三模組真組裝:dwell 端到端、子閘門、掉線斷路、stalled 回收、佇列上限 |
| `stress.integration.test.js`(3) | **混沌測試**(見 §8.1) |

以上檔案與突變腳本的完整原文見 §9。

測試環境注意:fake timers 會餓死 fake-indexeddb 的真實 task queue —— 整合類
測試用**真 timer + 縮小的時間常數**(dwell 6~20ms),不用 `useFakeTimers`。

---

## 8. 驗證方法(移植完成的定義)

### 8.1 混沌測試(`stress.integration.test.js`,已含於 §7)

固定種子(11/47/83)× 220 步隨機事件:可視翻動、編輯、revert、手動點擊、
後端在 ok/fail/silent 間翻轉、sweep tick。**每一步之後**跑全部不變量;結束後
治癒後端,模擬讀者反覆捲動,斷言:可視且未 revert 的訊息全部 translated、
revert 的絕不 translated、計數歸零、log 中 send 與 settle 一一配對。
固定種子=失敗可重放。本文的缺陷 #9/#10/#11 全部由它首次抓到。

### 8.2 突變測試(9 個突變,對你移植後的程式碼跑)

把以下 bug 逐一植入,**你的套件必須每一個都變紅**;活下來的突變=假覆蓋:

| 檔案 | 突變 | 重現的缺陷 |
|---|---|---|
| observer | markHidden 不 `cancelDwell` | 捲過去照樣翻 |
| observer | markVisible 不查 `visibleIds.has` | re-render 重啟已服完的 dwell |
| observer | rootMargin 不夾 `Math.max(0,·)` | 負 margin 全域無交集 |
| observer | `centreOf` 永遠走快取 fallback | 缺陷 #3 |
| policy | recordFailure 不豁免 `bad_request` | 一則壞訊息關掉整個功能 |
| policy | circuitBlocks 不查 `probing` | 恢復瞬間全體 probe 踩踏 |
| policy | 不等 `result.sent` 直接計費 | 缺陷 #1 |
| policy | sweep 不查 `status !== 'idle'` | 無限重試 rejected body |
| policy | sweep 不過靜默 gate | 缺陷 #8 |

實作:對原始檔做字串替換 → 跑套件 → 斷言紅 → 還原(用備份檔還原,不要用
git checkout,以免吃掉未提交變更)。

### 8.3 捲動分析(調參基準)

一支量測 harness(模擬 100 則、12 列視窗、每 250ms 捲 3 列、後端 800ms),
輸出決策計數、佇列深度曲線、queueWait/backend 分離延遲、排序誤差。基準數字
(移植後應在同量級):

```
持續捲動:  enqueue 78 / send 24 / drop {left-viewport 50, queue-full 18}
           排序平均誤差 0.00(修 #3 前:3.83/12)
           不變量違規 0
停下閱讀:  有 sweep 12/12(首則 ~1.1s,末則 ~5.2s);無 sweep 2/12
```

注意 jsdom 無 layout:模擬需給每列可隨捲動更新的 `getBoundingClientRect`,
否則 `centreOf` 全走 fallback,活測路徑根本沒被執行(量出來的是假的)。

### 8.4 完成清單

- [ ] §5 六檔逐字落地,只改 §6 適配點
- [ ] §7 測試全數移植,套件全綠
- [ ] 混沌測試三種子全綠(含三連跑穩定)
- [ ] 突變測試 9/9 全殺
- [ ] 真實瀏覽器冒煙:前景分頁捲動 → Queued…/Translating… 分別可見、
      `__translate.check()` 為空、`timeline(id)` 可解釋任一則的決策路徑
- [ ] 背景分頁不發請求;背景載入→前景後自動恢復(合約 C)

---

## 9. 測試程式碼(逐字採用)

依賴:`vitest` + `jsdom` 環境、`@testing-library/react`、`fake-indexeddb`
(devDependency)、快取實作使用 `dexie`。若你們以自有儲存替換 §6.2 的 cache
介面,整合/混沌測試中的 `createTranslationCache` 換成你們的工廠即可,其餘
斷言不變。`@/` 為 `src/` 的路徑別名,按你們的設定調整。

### 9.1 idbTranslationCache — 快取實作(採用,或按 §6.2 介面替換)

檔案:`src/lib/idbTranslationCache/index.js`

```js
// IndexedDB-backed translation cache: two tables with deliberately different
// lifetimes.
//
//   translationIntent  — the authoritative display decision for a message.
//                        Never pruned. It records the user's *exception* to
//                        the global auto-translate switch, so evicting it
//                        would silently un-translate a message the user asked
//                        to see translated.
//   translationContent — a rebuildable byte-LRU cache of translated text.
//                        Evicting it only costs a re-translation.
//
// There is no 'auto' intent mode. Automatic translation is derived from
// "no intent row + global switch on", which is what makes "turn the switch
// off -> instantly back to source" fall out of the display rule instead of
// needing a separate restore pass.

import Dexie from 'dexie'

export const CACHE_BYTE_CAP = 50 * 1024 * 1024
export const DEFAULT_PRUNE_BATCH = 10000
export const DEFAULT_DB_NAME = 'chat-translation-cache'

export const INTENT_MODES = ['manual', 'off']

const encoder = new TextEncoder()

function utf8Bytes(text) {
  return text ? encoder.encode(text).length : 0
}

export function createTranslationCache({
  dbName = DEFAULT_DB_NAME,
  byteCap = CACHE_BYTE_CAP,
  pruneBatch = DEFAULT_PRUNE_BATCH,
  now = () => Date.now(),
} = {}) {
  const db = new Dexie(dbName)
  db.version(1).stores({
    translationIntent: 'messageId, roomId',
    translationContent: 'messageId, roomId, bytes, lastAccessAt',
  })

  // null is the "not yet known" sentinel, distinct from a genuine 0. Storing
  // 0 for "unknown" is what lets the cap silently stop applying after a
  // reload: the total looks satisfied and nothing ever recomputes it.
  // Never persisted — a stale persisted total survives a clear, which is
  // worse than recomputing from the bytes index on first use.
  let runningTotal = null

  async function recomputeTotal() {
    // Walks the `bytes` index only; never materialises translatedText.
    let sum = 0
    await db.translationContent.orderBy('bytes').eachKey((bytes) => {
      sum += bytes
    })
    return sum
  }

  async function getRunningTotal() {
    if (runningTotal === null) runningTotal = await recomputeTotal()
    return runningTotal
  }

  // Resolve a cold total BEFORE the caller touches the store. Recomputing
  // afterwards would read a database that already reflects the write, and the
  // delta would then be applied a second time — every byte counted twice.
  async function warmTotal() {
    if (runningTotal === null) runningTotal = await recomputeTotal()
  }

  // Callers must have warmed the total first; this is pure arithmetic on a
  // known value.
  function addToTotal(delta) {
    runningTotal = Math.max(0, runningTotal + delta)
  }

  async function prune() {
    const total = runningTotal
    if (total <= byteCap) return

    const victims = await db.translationContent
      .orderBy('lastAccessAt')
      .limit(pruneBatch)
      .toArray()

    const doomed = []
    let reclaimed = 0
    for (const row of victims) {
      if (total - reclaimed <= byteCap) break
      doomed.push(row.messageId)
      reclaimed += row.bytes
    }
    if (doomed.length === 0) return

    await db.translationContent.bulkDelete(doomed)
    addToTotal(-reclaimed)
  }

  const intent = {
    async get(messageId) {
      const row = await db.translationIntent.get(messageId)
      return row?.mode
    },

    async set(messageId, roomId, mode) {
      if (!INTENT_MODES.includes(mode)) {
        throw new Error(`invalid translation intent mode: ${mode}`)
      }
      await db.translationIntent.put({ messageId, roomId, mode, updatedAt: now() })
    },

    async clear(messageId) {
      await db.translationIntent.delete(messageId)
    },
  }

  const content = {
    // peek reads without advancing lastAccessAt, so callers that inspect
    // rather than display don't distort the LRU order.
    async peek(messageId) {
      return db.translationContent.get(messageId)
    },

    // get applies both hit guards. A row translated into another language, or
    // built from a superseded source revision, is a miss — returning it would
    // show wrong text rather than merely cost a request.
    async get(messageId, { targetLang, srcVersion }) {
      const row = await db.translationContent.get(messageId)
      if (!row) return undefined
      if (row.targetLang !== targetLang) return undefined
      if (row.srcVersion !== srcVersion) return undefined

      const lastAccessAt = now()
      await db.translationContent.update(messageId, { lastAccessAt })
      return { ...row, lastAccessAt }
    },

    // Drops the cached text for one message WITHOUT touching its intent.
    // This is the edit path: a new revision invalidates the translation, but
    // not the user's decision to see this message translated.
    async clear(messageId) {
      const row = await db.translationContent.get(messageId)
      if (!row) return
      await warmTotal()
      await db.translationContent.delete(messageId)
      addToTotal(-row.bytes)
    },

    async set({ messageId, roomId, targetLang, srcVersion, translatedText, originalText }) {
      // A translation identical to its source is stored as a zero-byte hit
      // rather than skipped. Skipping would make same-language messages a
      // permanent cache miss, re-requested on every render.
      const identical = translatedText === originalText
      const storedText = identical ? '' : translatedText
      const bytes = identical ? 0 : utf8Bytes(storedText)

      const previous = await db.translationContent.get(messageId)
      await warmTotal()
      const timestamp = now()

      await db.translationContent.put({
        messageId,
        roomId,
        targetLang,
        srcVersion,
        translatedText: storedText,
        bytes,
        identical,
        lastAccessAt: timestamp,
        updatedAt: timestamp,
      })

      // An overwrite must give back the old row's bytes first, or the total
      // drifts upward forever and the cap engages far too early.
      addToTotal(bytes - (previous?.bytes ?? 0))
      await prune()
    },
  }

  async function clearMessages(messageIds) {
    const ids = Array.from(messageIds ?? [])
    if (ids.length === 0) return

    const rows = await db.translationContent.bulkGet(ids)
    const freed = rows.reduce((sum, row) => sum + (row?.bytes ?? 0), 0)
    await warmTotal()

    await db.translationContent.bulkDelete(ids)
    await db.translationIntent.bulkDelete(ids)
    addToTotal(-freed)
  }

  // Clears BOTH tables for the room. Leaving intent behind would strand
  // display decisions for messages whose text is gone.
  async function clearRoom(roomId) {
    const rows = await db.translationContent.where('roomId').equals(roomId).toArray()
    const freed = rows.reduce((sum, row) => sum + row.bytes, 0)
    await warmTotal()

    await db.translationContent.where('roomId').equals(roomId).delete()
    await db.translationIntent.where('roomId').equals(roomId).delete()
    addToTotal(-freed)
  }

  // Logout. intent is authoritative display state, so leaving it behind would
  // show one account's translations to the next account on this device.
  async function clearAll() {
    await db.translationContent.clear()
    await db.translationIntent.clear()
    runningTotal = 0
  }

  async function destroy() {
    await db.delete()
  }

  return {
    dbName,
    db,
    intent,
    content,
    clearMessages,
    clearRoom,
    clearAll,
    getRunningTotal,
    destroy,
  }
}

export const translationCache = createTranslationCache()
```

### 9.2 store.test.js

檔案:`src/context/TranslationContext/store.test.js`

```js
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createTranslationCache } from '@/lib/idbTranslationCache'
import { createTranslationStore } from './store'

let disposables = []

function makeCache() {
  const cache = createTranslationCache({
    dbName: `store-test-${disposables.length}-${Math.random().toString(36).slice(2)}`,
  })
  disposables.push(cache)
  return cache
}

/** A translate function whose every call is settled by the test, so queue
 *  occupancy is observable rather than timing-dependent. */
function deferredTranslate() {
  const calls = []
  const fn = vi.fn((_nats, args, opts) => {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    calls.push({ args, opts, resolve, reject })
    opts?.signal?.addEventListener('abort', () => {
      const err = new Error('translate aborted')
      err.name = 'AbortError'
      reject(err)
    })
    return promise
  })
  fn.calls = calls
  return fn
}

function makeStore(overrides = {}) {
  const cache = overrides.cache ?? makeCache()
  const translate = overrides.translate ?? deferredTranslate()
  const store = createTranslationStore({
    nats: { user: { account: 'alice', siteId: 'site-local' } },
    translate,
    cache,
    config: { maxConcurrent: 4, ...overrides.config },
  })
  return { store, translate, cache }
}

function job(overrides = {}) {
  return {
    roomId: 'r1',
    text: 'hello',
    targetLang: 'ja',
    srcVersion: 1,
    ...overrides,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

afterEach(async () => {
  for (const cache of disposables) await cache.destroy()
  disposables = []
  vi.restoreAllMocks()
})

describe('translate lifecycle', () => {
  test('moves idle -> loading -> translated and exposes the text', async () => {
    const { store, translate } = makeStore()

    expect(store.getEntry('m1').status).toBe('idle')

    const done = store.translate('m1', job())
    await flush()
    // A free slot means the request went out immediately, so the entry is
    // already past 'queued'.
    expect(store.getEntry('m1').status).toBe('loading')

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    const entry = store.getEntry('m1')
    expect(entry.status).toBe('translated')
    expect(entry.translatedText).toBe('[ja] hello')
    expect(entry.targetLang).toBe('ja')
  })

  test('notifies subscribers on every transition', async () => {
    const { store, translate } = makeStore()
    const listener = vi.fn()
    store.subscribe(listener)

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  test('a failure lands on failed without throwing to the caller', async () => {
    const { store, translate } = makeStore()

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].reject(Object.assign(new Error('boom'), { code: 'internal' }))
    await done

    expect(store.getEntry('m1').status).toBe('failed')
  })

  test('persists the result so a later view hydrates without a request', async () => {
    const { store, translate, cache } = makeStore()

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    const row = await cache.content.peek('m1')
    expect(row.translatedText).toBe('[ja] hello')
    expect(row.srcVersion).toBe(1)
  })

  test('an identical reply is recorded as identical', async () => {
    const { store, translate, cache } = makeStore()

    const done = store.translate('m1', job({ text: 'hello' }))
    await flush()
    translate.calls[0].resolve({ translatedText: 'hello', targetLang: 'ja' })
    await done

    expect(store.getEntry('m1').identical).toBe(true)
    expect((await cache.content.peek('m1')).identical).toBe(true)
  })
})

describe('queued vs in flight', () => {
  test('a job waiting for a slot reports queued, not loading', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()

    // 'loading' has to mean "the request is on the wire". Reporting it while
    // the job is still in the queue makes a full gate indistinguishable from
    // a slow backend.
    expect(store.getEntry('m1').status).toBe('loading')
    expect(store.getEntry('m2').status).toBe('queued')
    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('a queued job flips to loading when a slot frees', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()
    expect(store.getEntry('m2').status).toBe('queued')

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()

    expect(store.getEntry('m2').status).toBe('loading')
  })

  test('a repeat request for a queued message is still deduplicated', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()
    store.translate('m2', job())
    await flush()

    expect(store.getEntry('m2').status).toBe('queued')
    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('an automatic job dropped at pick time leaves queued for idle', async () => {
    const visible = new Set(['m1'])
    const { store } = makeStore({
      config: {
        maxConcurrent: 1,
        maxConcurrentAuto: 1,
        isAutoEligible: (id) => visible.has(id),
      },
    })

    store.translate('m1', { ...job(), origin: 'auto' })
    await flush()
    store.translate('m2', { ...job(), origin: 'auto' })
    await flush()
    expect(store.getEntry('m2').status).toBe('queued')

    visible.delete('m2')
    store.detach('m1')
    await flush()

    // Never sent, so it must not linger as though something were happening.
    expect(store.getEntry('m2').status).toBe('idle')
  })
})

describe('deduplication and generations', () => {
  test('a second request for the same message and language is a no-op', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job())
    await flush()
    store.translate('m1', job())
    await flush()

    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('a different language supersedes the in-flight request', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job({ targetLang: 'ja' }))
    await flush()
    store.translate('m1', job({ targetLang: 'de' }))
    await flush()

    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.calls[0].opts.signal.aborted).toBe(true)
  })

  test('a superseded reply arriving late is discarded', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job({ targetLang: 'ja' }))
    await flush()
    const stale = translate.calls[0]

    const fresh = store.translate('m1', job({ targetLang: 'de' }))
    await flush()

    // The stale generation answers after being superseded — it must not win.
    stale.resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    translate.calls[1].resolve({ translatedText: '[de] hello', targetLang: 'de' })
    await fresh
    await flush()

    expect(store.getEntry('m1').translatedText).toBe('[de] hello')
    expect(store.getEntry('m1').targetLang).toBe('de')
  })
})

describe('concurrency gate', () => {
  test('runs at most maxConcurrent requests at once', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 2 } })

    for (const id of ['m1', 'm2', 'm3', 'm4']) store.translate(id, job())
    await flush()

    expect(translate).toHaveBeenCalledTimes(2)
  })

  test('starts a queued request as soon as a slot frees', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 2 } })

    for (const id of ['m1', 'm2', 'm3']) store.translate(id, job())
    await flush()
    expect(translate).toHaveBeenCalledTimes(2)

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()

    expect(translate).toHaveBeenCalledTimes(3)
  })

  test('a failed request also frees its slot', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()
    expect(translate).toHaveBeenCalledTimes(1)

    translate.calls[0].reject(Object.assign(new Error('boom'), { code: 'internal' }))
    await flush()

    expect(translate).toHaveBeenCalledTimes(2)
  })
})

describe('read-through for a mounted message', () => {
  test('an off intent shows the source and issues no request', async () => {
    const { store, translate, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'off')

    await store.ensureForView('m1', { ...job(), autoTranslate: true })

    expect(translate).not.toHaveBeenCalled()
    expect(store.getEntry('m1').status).toBe('idle')
  })

  test('a manual intent translates even while the global switch is off', async () => {
    const { store, translate, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'manual')

    await store.ensureForView('m1', { ...job(), autoTranslate: false })

    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('no intent and the switch off leaves the message untranslated', async () => {
    const { store, translate } = makeStore()

    await store.ensureForView('m1', { ...job(), autoTranslate: false })

    expect(translate).not.toHaveBeenCalled()
  })

  test('a cached translation hydrates without touching the network', async () => {
    const { store, translate, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'manual')
    await cache.content.set({
      messageId: 'm1',
      roomId: 'r1',
      targetLang: 'ja',
      srcVersion: 1,
      translatedText: '[ja] hello',
      originalText: 'hello',
    })

    await store.ensureForView('m1', { ...job(), autoTranslate: false })

    expect(translate).not.toHaveBeenCalled()
    expect(store.getEntry('m1').status).toBe('translated')
    expect(store.getEntry('m1').translatedText).toBe('[ja] hello')
  })

  test('a cached translation in another language is refetched', async () => {
    const { store, translate, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'manual')
    await cache.content.set({
      messageId: 'm1',
      roomId: 'r1',
      targetLang: 'ja',
      srcVersion: 1,
      translatedText: '[ja] hello',
      originalText: 'hello',
    })

    await store.ensureForView('m1', { ...job({ targetLang: 'de' }), autoTranslate: false })

    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.calls[0].args.targetLang).toBe('de')
  })
})

describe('user intent', () => {
  test('translate records a manual intent so the choice outlives the cache', async () => {
    const { store, translate, cache } = makeStore()

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    expect(await cache.intent.get('m1')).toBe('manual')
  })

  test('revert writes off rather than deleting the intent', async () => {
    const { store, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'manual')

    await store.revert('m1', 'r1')

    expect(await cache.intent.get('m1')).toBe('off')
    expect(store.getEntry('m1').status).toBe('idle')
  })

  test('revert aborts an in-flight request', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job())
    await flush()
    await store.revert('m1', 'r1')

    expect(translate.calls[0].opts.signal.aborted).toBe(true)
  })

  test('an aborted request does not surface as failed', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job())
    await flush()
    await store.revert('m1', 'r1')
    await flush()

    expect(store.getEntry('m1').status).toBe('idle')
    expect(translate.calls[0].opts.signal.aborted).toBe(true)
  })
})

describe('message edited', () => {
  test('drops the stale translation but KEEPS the user intent', async () => {
    const { store, translate, cache } = makeStore()

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done
    expect(await cache.intent.get('m1')).toBe('manual')

    await store.onMessageEdited('m1', 'r1', 2)

    // Editing invalidates the translation, not the decision to translate.
    // Writing 'off' here is what would make an edited message permanently
    // opt out of automatic translation.
    expect(await cache.intent.get('m1')).toBe('manual')
    expect(await cache.content.peek('m1')).toBeUndefined()
    expect(store.getEntry('m1').status).toBe('idle')
  })

  test('a re-view after an edit re-translates at the new revision', async () => {
    const { store, translate, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'manual')
    await cache.content.set({
      messageId: 'm1',
      roomId: 'r1',
      targetLang: 'ja',
      srcVersion: 1,
      translatedText: '[ja] hello',
      originalText: 'hello',
    })

    await store.onMessageEdited('m1', 'r1', 2)
    await store.ensureForView('m1', {
      ...job({ srcVersion: 2, text: 'hello again' }),
      autoTranslate: false,
    })

    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.calls[0].args.text).toBe('hello again')
  })

  test('aborts an in-flight request for the superseded revision', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job())
    await flush()
    await store.onMessageEdited('m1', 'r1', 2)

    expect(translate.calls[0].opts.signal.aborted).toBe(true)
  })
})

describe('automatic translation gate', () => {
  const auto = (overrides = {}) => ({ ...job(), origin: 'auto', ...overrides })

  test('automatic jobs are capped below the overall concurrency limit', async () => {
    const { store, translate } = makeStore({
      config: { maxConcurrent: 4, maxConcurrentAuto: 2 },
    })

    for (const id of ['m1', 'm2', 'm3', 'm4']) store.translate(id, auto())
    await flush()

    // The remaining slots are reserved: a message the user explicitly asks
    // for must not queue behind background work.
    expect(translate).toHaveBeenCalledTimes(2)
  })

  test('a manual request still runs while the automatic sub-gate is full', async () => {
    const { store, translate } = makeStore({
      config: { maxConcurrent: 4, maxConcurrentAuto: 2 },
    })

    for (const id of ['a1', 'a2', 'a3']) store.translate(id, auto())
    await flush()
    expect(translate).toHaveBeenCalledTimes(2)

    store.translate('m-manual', job())
    await flush()

    expect(translate).toHaveBeenCalledTimes(3)
    expect(translate.calls[2].args.text).toBe('hello')
  })

  test('an automatic job that scrolled out of view is dropped at pick time', async () => {
    // m0 and m1 are on screen; m2 is not by the time a slot frees.
    const visible = new Set(['m0', 'm1'])
    const { store, translate } = makeStore({
      config: { maxConcurrent: 1, maxConcurrentAuto: 1, isAutoEligible: (id) => visible.has(id) },
    })

    store.translate('m0', auto())
    await flush()
    // m2 is queued behind m0 but has left the viewport by the time a slot frees.
    store.translate('m2', auto())
    store.translate('m1', auto())
    await flush()

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()

    const requested = translate.calls.map((c) => c.args.text)
    expect(translate).toHaveBeenCalledTimes(2)
    expect(requested).toHaveLength(2)
    expect(store.getEntry('m2').status).toBe('idle')
  })

  test('a manual job is never dropped by the visibility filter', async () => {
    const { store, translate } = makeStore({
      config: { maxConcurrent: 1, isAutoEligible: () => false },
    })

    store.translate('m1', job())
    await flush()

    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('queued automatic jobs are picked in the injected order', async () => {
    const { store, translate } = makeStore({
      config: {
        maxConcurrent: 1,
        maxConcurrentAuto: 1,
        orderAutoQueue: (ids) => [...ids].reverse(),
      },
    })

    store.translate('first', auto({ text: 'first' }))
    await flush()
    store.translate('second', auto({ text: 'second' }))
    store.translate('third', auto({ text: 'third' }))
    await flush()

    translate.calls[0].resolve({ translatedText: 'x', targetLang: 'ja' })
    await flush()

    expect(translate.calls[1].args.text).toBe('third')
  })

  test('detaching an in-flight job frees its slot immediately', async () => {
    const { store, translate } = makeStore({
      config: { maxConcurrent: 1, maxConcurrentAuto: 1 },
    })

    store.translate('m1', auto())
    await flush()
    store.translate('m2', auto())
    await flush()
    expect(translate).toHaveBeenCalledTimes(1)

    store.detach('m1')
    await flush()

    // The reply is still coming; what must not happen is the queue sitting
    // idle waiting for a message nobody is looking at any more.
    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.calls[0].opts.signal.aborted).toBe(false)
  })

  test('a detached reply still lands, because the request was never cancelled', async () => {
    const { store, translate } = makeStore()

    const done = store.translate('m1', auto())
    await flush()
    store.detach('m1')

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    expect(store.getEntry('m1').status).toBe('translated')
  })
})

describe('message deleted', () => {
  test('clears both tables and forgets the entry', async () => {
    const { store, translate, cache } = makeStore()

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    await store.onMessagesDeleted(['m1'])

    expect(await cache.intent.get('m1')).toBeUndefined()
    expect(await cache.content.peek('m1')).toBeUndefined()
    expect(store.getEntry('m1').status).toBe('idle')
  })
})

describe('a request that never replies', () => {
  test('gives its slot back once the timeout elapses', async () => {
    // The failure this exists for: under request/reply a lost reply produces
    // no rejection at all, so without a timeout the slot is held forever and
    // the queue behind it never moves again.
    const { store, translate } = makeStore({
      config: { maxConcurrent: 1, timeoutMs: 20 },
    })

    store.translate('m1', job())
    await flush()
    store.translate('m2', job())
    await flush()

    expect(translate.calls).toHaveLength(1)

    await sleep(60)

    // The stalled job ended and the one behind it got the slot. Without the
    // timeout the second request is never made at all.
    expect(translate.calls).toHaveLength(2)
    expect(store.getEntry('m1').status).toBe('failed')
  })

  test('is reported as a failure rather than an abort, so an outage is visible', async () => {
    // The timeout cancels the request, and a cancelled request rejects with
    // AbortError. Reporting that as "aborted" would exempt it from failure
    // accounting — which is how a circuit breaker sits open-eyed through a
    // total outage.
    const { store } = makeStore({ config: { timeoutMs: 20 } })

    const done = store.translate('m1', job())
    const outcome = await done

    expect(outcome.ok).toBe(false)
    expect(outcome.aborted).toBeFalsy()
    expect(outcome.superseded).toBeFalsy()
    expect(outcome.error.code).toBe('timeout')
    expect(store.getEntry('m1').status).toBe('failed')
  })

  test('the timer is dropped when the reply arrives in time', async () => {
    const { store, translate } = makeStore({ config: { timeoutMs: 30 } })

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    expect(store.getEntry('m1').status).toBe('translated')

    // A timeout that still fires after a success would knock a translated
    // message back to failed for no reason.
    await sleep(60)
    expect(store.getEntry('m1').status).toBe('translated')
  })

  test('no timeout is applied when the ceiling is zero', async () => {
    const { store } = makeStore({ config: { timeoutMs: 0 } })

    store.translate('m1', job())
    await sleep(40)

    expect(store.getEntry('m1').status).toBe('loading')
  })
})

describe('queue ceiling', () => {
  function saturate() {
    const made = makeStore({ config: { maxConcurrent: 1, maxQueueLength: 2 } })
    return made
  }

  test('refuses a new automatic job once the queue is at its ceiling', async () => {
    const { store } = saturate()

    store.translate('m1', job({ origin: 'auto' })) // runs
    store.translate('m2', job({ origin: 'auto' })) // queued 1
    store.translate('m3', job({ origin: 'auto' })) // queued 2 — at the ceiling
    await flush()

    const outcome = await store.translate('m4', job({ origin: 'auto' }))

    expect(outcome.dropped).toBe(true)
    expect(store.stats().queued).toBe(2)
  })

  test('leaves a refused automatic job idle so a later view can retry it', async () => {
    const { store } = saturate()

    store.translate('m1', job({ origin: 'auto' }))
    store.translate('m2', job({ origin: 'auto' }))
    store.translate('m3', job({ origin: 'auto' }))
    await flush()
    await store.translate('m4', job({ origin: 'auto' }))

    // Not 'failed': nothing was attempted. Leaving it failed would put an
    // error on a message that was never sent.
    expect(store.getEntry('m4').status).toBe('idle')
  })

  test('never refuses an explicit request, however long the queue is', async () => {
    const { store } = saturate()

    store.translate('m1', job({ origin: 'auto' }))
    store.translate('m2', job({ origin: 'auto' }))
    store.translate('m3', job({ origin: 'auto' }))
    await flush()

    store.translate('m4', job({ origin: 'manual' }))
    await flush()

    // The user asked for this one. A background ceiling must never be the
    // reason a click does nothing.
    expect(store.getEntry('m4').status).toBe('queued')
    expect(store.stats().queued).toBe(3)
  })

  test('a view request for a full queue reports the drop instead of queueing', async () => {
    const { store } = saturate()

    store.translate('m1', job({ origin: 'auto' }))
    store.translate('m2', job({ origin: 'auto' }))
    store.translate('m3', job({ origin: 'auto' }))
    await flush()

    const result = await store.ensureForView('m9', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })

    // 'dropped', not 'queued': the policy layer charges its rate budget and
    // its circuit breaker on 'queued' alone, and neither should move for a
    // request that was never made.
    expect(result.outcome).toBe('dropped')
  })
})

describe('reporting whether a request actually went out', () => {
  test('resolves sent=true when the request reaches the wire', async () => {
    const { store } = makeStore()

    const result = await store.ensureForView('m1', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })

    expect(result.outcome).toBe('queued')
    await expect(result.sent).resolves.toBe(true)
  })

  test('resolves sent=false for a job dropped before it was picked', async () => {
    // The distinction the rate limiter depends on. An accepted candidate is
    // not a request: most of them are dropped at pick time because their
    // message scrolled away while they waited.
    const visible = new Set()
    const { store } = makeStore({
      config: { maxConcurrent: 1, maxConcurrentAuto: 1, isAutoEligible: (id) => visible.has(id) },
    })

    visible.add('m1')
    store.translate('m1', job({ origin: 'auto' }))
    await flush()

    const result = await store.ensureForView('m2', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })
    expect(result.outcome).toBe('queued')

    // m2 never becomes visible, so when the slot frees it is dropped.
    store.detach('m1')
    await flush()

    await expect(result.sent).resolves.toBe(false)
  })

  test('resolves sent=false when the queue ceiling refuses the job', async () => {
    const { store } = makeStore({ config: { maxConcurrent: 1, maxQueueLength: 1 } })

    store.translate('m1', job({ origin: 'auto' }))
    store.translate('m2', job({ origin: 'auto' }))
    await flush()

    const result = await store.ensureForView('m3', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })

    expect(result.outcome).toBe('dropped')
    await expect(result.sent).resolves.toBe(false)
  })
})

describe('a queued job whose state moves on is purged, not run', () => {
  test('reverting a queued message removes its job before it can be sent', async () => {
    // invalidate() aborts the in-flight request, but a job still WAITING for
    // a slot has no controller to abort — left in the queue it eventually
    // sends a request whose reply is unusable, for a message the user
    // explicitly asked to see in the original.
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()
    expect(store.stats().queued).toBe(1)

    await store.revert('m2', 'r1')
    expect(store.stats().queued).toBe(0)

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()
    await flush()

    expect(translate).toHaveBeenCalledTimes(1)
    expect(store.getEntry('m2').status).toBe('idle')
  })

  test('switching language while queued replaces the job instead of stacking two', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job({ targetLang: 'ja' }))
    await flush()
    store.translate('m2', job({ targetLang: 'de' }))
    await flush()

    expect(store.stats().queued).toBe(1)

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()
    await flush()

    // Only the de job may reach the wire for m2.
    const m2Calls = translate.calls.slice(1)
    expect(m2Calls).toHaveLength(1)
    expect(m2Calls[0].args.targetLang).toBe('de')
  })

  test('editing a message purges its queued job', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()

    await store.onMessageEdited('m2')
    expect(store.stats().queued).toBe(0)

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()
    await flush()

    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('a purged job resolves as never-sent, so no budget is charged for it', async () => {
    const { store } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    const result = await store.ensureForView('m2', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })
    expect(result.outcome).toBe('queued')

    await store.revert('m2', 'r1')

    await expect(result.sent).resolves.toBe(false)
  })
})

describe('revert racing an in-progress view decision', () => {
  test('a revert landing between the intent read and the enqueue wins', async () => {
    // ensureForView is not atomic: intent read, then a content read (an IDB
    // round trip), then the enqueue. A revert landing inside that window used
    // to be overwritten — the enqueue took a fresh generation and translated
    // a message whose user had just said "see original". Found by the chaos
    // harness (seed 83).
    const cache = makeCache()
    let releaseContentRead
    const gate = new Promise((r) => {
      releaseContentRead = r
    })
    const gatedCache = {
      ...cache,
      intent: cache.intent,
      content: {
        ...cache.content,
        get: async (...args) => {
          await gate
          return cache.content.get(...args)
        },
      },
    }
    const { store, translate } = makeStore({ cache: gatedCache })

    const pending = store.ensureForView('m1', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })
    await flush()

    await store.revert('m1', 'r1')
    releaseContentRead()
    const result = await pending

    expect(result.outcome).not.toBe('queued')
    expect(translate).not.toHaveBeenCalled()
    expect(store.getEntry('m1').status).toBe('idle')
  })
})
```

### 9.3 visibilityObserver.test.js

檔案:`src/context/TranslationContext/visibilityObserver.test.js`

```js
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createVisibilityObserver } from './visibilityObserver'

// jsdom has no IntersectionObserver. This fake records how it was constructed
// and lets a test drive intersection changes explicitly, which is the only way
// to assert that visibility comes from the observer rather than from the act
// of registering an element.
let instances = []

class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback
    this.options = options ?? {}
    this.observed = new Set()
    this.unobserved = []
    this.disconnected = false
    instances.push(this)
  }

  observe(el) {
    this.observed.add(el)
  }

  unobserve(el) {
    this.observed.delete(el)
    this.unobserved.push(el)
  }

  disconnect() {
    this.disconnected = true
    this.observed.clear()
  }

  /** Drive the callback the way the browser would. */
  emit(entries) {
    this.callback(
      entries.map(({ target, isIntersecting, top = 0, height = 20 }) => ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: { top, height, bottom: top + height },
      })),
      this,
    )
  }
}

function latest() {
  return instances[instances.length - 1]
}

function makeEl(id) {
  const el = document.createElement('div')
  el.dataset.testid = id
  document.body.appendChild(el)
  return el
}

/** jsdom performs no layout, so every element reports an all-zero box. Give
 *  one a position the way the browser would. */
function placeAt(el, top, height = 20) {
  el.getBoundingClientRect = () => ({
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
  })
}

beforeEach(() => {
  instances = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function makeObserver(overrides = {}) {
  const onCandidate = vi.fn()
  const observer = createVisibilityObserver({
    onCandidate,
    dwellMs: 400,
    prefetchMarginPx: 0,
    ...overrides,
  })
  return { observer, onCandidate }
}

describe('observer construction', () => {
  test.each([250, -250])('never builds a negative rootMargin (prefetchMarginPx %i)', (px) => {
    // A negative rootMargin shrinks the intersection box. On most viewports
    // that makes the effective root height negative, so nothing ever
    // intersects and the feature silently does nothing. The failure mode is
    // "no candidates ever", which no behavioural test can tell apart from
    // "correctly filtered", so assert the value directly. The negative input
    // is the case that matters: a positive one passes with or without the
    // clamp (mutation testing caught exactly that gap).
    const { observer } = makeObserver({ prefetchMarginPx: px })
    observer.observe('m1', makeEl('m1'))

    const margin = latest().options.rootMargin ?? '0px'
    for (const part of margin.split(/\s+/)) {
      expect(parseFloat(part)).toBeGreaterThanOrEqual(0)
    }
  })

  test('expands the box by prefetchMarginPx', () => {
    const { observer } = makeObserver({ prefetchMarginPx: 250 })
    observer.observe('m1', makeEl('m1'))

    expect(latest().options.rootMargin).toContain('250')
  })

  test('is created lazily, only once an element is registered', () => {
    makeObserver()
    expect(instances).toHaveLength(0)
  })
})

describe('registration does not imply visibility', () => {
  test('observing an element emits no candidate on its own', async () => {
    const { observer, onCandidate } = makeObserver()

    observer.observe('m1', makeEl('m1'))
    await vi.advanceTimersByTimeAsync(1000)

    // Starting the dwell timer at registration time makes every rendered
    // message a candidate and defeats the whole point of dwell.
    expect(onCandidate).not.toHaveBeenCalled()
    expect(observer.visibleIds.has('m1')).toBe(false)
  })

  test('a non-intersecting entry keeps the element out of the visible set', async () => {
    const { observer, onCandidate } = makeObserver()
    const el = makeEl('m1')
    observer.observe('m1', el)

    latest().emit([{ target: el, isIntersecting: false }])
    await vi.advanceTimersByTimeAsync(1000)

    expect(observer.visibleIds.has('m1')).toBe(false)
    expect(onCandidate).not.toHaveBeenCalled()
  })
})

describe('dwell', () => {
  test('emits a candidate only after the dwell window elapses', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 400 })
    const el = makeEl('m1')
    observer.observe('m1', el)

    latest().emit([{ target: el, isIntersecting: true }])

    await vi.advanceTimersByTimeAsync(399)
    expect(onCandidate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('scrolling past before the window elapses cancels the candidate', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 400 })
    const el = makeEl('m1')
    observer.observe('m1', el)

    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(200)
    latest().emit([{ target: el, isIntersecting: false }])
    await vi.advanceTimersByTimeAsync(1000)

    expect(onCandidate).not.toHaveBeenCalled()
  })

  test('re-observing an already visible element does not restart its dwell', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 400 })
    const el = makeEl('m1')
    observer.observe('m1', el)
    latest().emit([{ target: el, isIntersecting: true }])

    await vi.advanceTimersByTimeAsync(300)
    observer.observe('m1', el)
    await vi.advanceTimersByTimeAsync(100)

    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('emits once per continuous visible period', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 400 })
    const el = makeEl('m1')
    observer.observe('m1', el)

    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(500)
    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(500)

    expect(onCandidate).toHaveBeenCalledTimes(1)
  })
})

describe('identity', () => {
  test('takes the id from observe(), not from a DOM attribute', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 0 })
    const el = document.createElement('div')
    document.body.appendChild(el)
    // Deliberately no data-* id: reading the id back off the element makes
    // the module silently skip anything the renderer forgot to annotate.
    observer.observe('m1', el)

    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(1)

    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('ignores an intersection for an element it never registered', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 0 })
    observer.observe('m1', makeEl('m1'))

    latest().emit([{ target: makeEl('stray'), isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(10)

    expect(onCandidate).not.toHaveBeenCalled()
  })
})

describe('unobserve', () => {
  test('detaches the element from the IntersectionObserver', () => {
    const { observer } = makeObserver()
    const el = makeEl('m1')
    observer.observe('m1', el)

    observer.unobserve('m1')

    // Dropping the registry entry before calling unobserve leaves the
    // observer holding a strong reference to a detached node forever.
    expect(latest().unobserved).toContain(el)
    expect(latest().observed.has(el)).toBe(false)
  })

  test('clears the element from the visible set and cancels its dwell', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 400 })
    const el = makeEl('m1')
    observer.observe('m1', el)
    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(100)

    observer.unobserve('m1')
    await vi.advanceTimersByTimeAsync(1000)

    expect(observer.visibleIds.has('m1')).toBe(false)
    expect(onCandidate).not.toHaveBeenCalled()
  })

  test('is safe for an id that was never registered', () => {
    const { observer } = makeObserver()
    expect(() => observer.unobserve('nope')).not.toThrow()
  })
})

describe('reset and root changes', () => {
  test('reset clears visibility and keeps observing the registered elements', async () => {
    const { observer, onCandidate } = makeObserver({ dwellMs: 0 })
    const el = makeEl('m1')
    observer.observe('m1', el)
    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(10)
    onCandidate.mockClear()

    observer.reset()

    // A tab returning to the foreground re-evaluates what is on screen; the
    // element must still be attached to an observer for that to happen.
    expect(observer.visibleIds.size).toBe(0)
    latest().emit([{ target: el, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(10)
    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('setRoot rebuilds the observer against the new scroll container', () => {
    const { observer } = makeObserver()
    const el = makeEl('m1')
    observer.observe('m1', el)
    const before = instances.length

    const root = makeEl('scroller')
    observer.setRoot(root)

    expect(instances.length).toBeGreaterThan(before)
    expect(latest().options.root).toBe(root)
    expect(latest().observed.has(el)).toBe(true)
  })
})

describe('ordering', () => {
  test('ranks visible ids by absolute distance from the viewport centre', () => {
    const { observer } = makeObserver()
    const near = makeEl('near')
    const above = makeEl('above')
    const far = makeEl('far')
    observer.observe('near', near)
    observer.observe('above', above)
    observer.observe('far', far)

    // Centre is 300. `above` sits 200px before it, `far` 250px after it — an
    // unsigned distance is what keeps "just off the top" from ranking ahead
    // of everything below.
    observer.setViewportCentre(300)
    latest().emit([
      { target: near, isIntersecting: true, top: 290, height: 20 },
      { target: above, isIntersecting: true, top: 90, height: 20 },
      { target: far, isIntersecting: true, top: 540, height: 20 },
    ])

    expect(observer.byDistanceFromCentre(['far', 'above', 'near'])).toEqual([
      'near',
      'above',
      'far',
    ])
  })

  test('ranks by where a row is now, not where it was when it entered', () => {
    // IntersectionObserver only fires when an element CROSSES the threshold.
    // A row that entered at the bottom edge and has since scrolled to the
    // middle produces no further entries at all, so a cached position ranks
    // it as though it were still at the bottom — and the queue then works on
    // whatever happened to enter first rather than on what is being read.
    const { observer } = makeObserver()
    const travelled = makeEl('travelled')
    const settled = makeEl('settled')
    observer.observe('travelled', travelled)
    observer.observe('settled', settled)

    observer.setViewportCentre(300)
    placeAt(travelled, 560)
    placeAt(settled, 340)
    latest().emit([
      { target: travelled, isIntersecting: true, top: 560, height: 20 },
      { target: settled, isIntersecting: true, top: 340, height: 20 },
    ])
    expect(observer.byDistanceFromCentre(['travelled', 'settled'])).toEqual([
      'settled',
      'travelled',
    ])

    // The user scrolls. Both rows move; neither crosses an edge, so no entry
    // is delivered.
    placeAt(travelled, 295)
    placeAt(settled, 80)

    expect(observer.byDistanceFromCentre(['travelled', 'settled'])).toEqual([
      'travelled',
      'settled',
    ])
  })

  test('falls back to the last crossing position when a row cannot be measured', () => {
    // A detached element, or any environment without layout, reports an
    // all-zero box. The position recorded when it crossed the edge is the
    // best answer available then.
    const { observer } = makeObserver()
    const near = makeEl('near')
    const far = makeEl('far')
    observer.observe('near', near)
    observer.observe('far', far)

    observer.setViewportCentre(300)
    latest().emit([
      { target: near, isIntersecting: true, top: 290, height: 20 },
      { target: far, isIntersecting: true, top: 540, height: 20 },
    ])

    expect(observer.byDistanceFromCentre(['far', 'near'])).toEqual(['near', 'far'])
  })
})
```

### 9.4 autoPolicy.test.js

檔案:`src/context/TranslationContext/autoPolicy.test.js`

```js
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
```

### 9.5 TranslationContext.test.jsx

檔案:`src/context/TranslationContext/TranslationContext.test.jsx`

```jsx
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { setAutoTranslate, setTargetLang } from '@/lib/translationSettings'
import { TranslationProvider, useAutoTranslateRegistration } from './TranslationContext'

// Provider wiring test. The modules under it have their own suites; what only
// this level can catch is a seam the provider itself gets wrong — found live:
// a tab that loads in the background renders `active: false` into a ref, and
// bringing it to the foreground re-renders nothing, so the policy skipped
// every candidate as 'inactive' while the user was looking straight at the
// page.

vi.mock('@/context/NatsContext', () => ({
  useNats: () => ({ user: { account: 'alice', siteId: 'site-local' } }),
}))

let ios = []

class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback
    ios.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const io = () => ios[ios.length - 1]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let visibility = 'visible'

function makeCache() {
  return {
    intent: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
    content: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}), clear: vi.fn() },
    clearMessages: vi.fn(async () => {}),
    clearRoom: vi.fn(async () => {}),
    clearAll: vi.fn(async () => {}),
  }
}

function Row({ message }) {
  const register = useAutoTranslateRegistration(message, 'r1')
  return <div ref={register} data-message-id={message.id} />
}

function show(id) {
  const el = document.querySelector(`[data-message-id="${id}"]`)
  io().callback(
    [
      {
        target: el,
        isIntersecting: true,
        intersectionRatio: 1,
        boundingClientRect: { top: 100, height: 20, bottom: 120 },
      },
    ],
    io(),
  )
}

beforeEach(() => {
  ios = []
  visibility = 'visible'
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => visibility !== 'visible',
  })
  setAutoTranslate(true)
  setTargetLang('ja')
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete document.visibilityState
  delete document.hidden
  localStorage.clear()
})

describe('foregrounding a tab that loaded in the background', () => {
  test('translates what is on screen without waiting for a re-render', async () => {
    // Every render happens while hidden — exactly what a tab opened via
    // "open in new tab" does.
    visibility = 'hidden'

    const translate = vi.fn(async (_n, { text, targetLang }) => ({
      translatedText: `[${targetLang}] ${text}`,
      targetLang,
    }))
    const message = { id: 'm1', content: '早安', sender: { account: 'bob' }, editedAt: 0 }

    render(
      <TranslationProvider translate={translate} cache={makeCache()}>
        <Row message={message} />
      </TranslationProvider>,
    )

    // The user brings the tab to the front. Nothing about this re-renders
    // React — the page just becomes visible and the observer starts firing.
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    show('m1')

    // Provider wires the real dwell (400ms); wait it out plus slack.
    await sleep(600)

    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0][1]).toMatchObject({ text: '早安', targetLang: 'ja' })
  })

  test('still refuses to translate while genuinely hidden', async () => {
    visibility = 'hidden'

    const translate = vi.fn(async () => ({ translatedText: 'x', targetLang: 'ja' }))
    const message = { id: 'm1', content: '早安', sender: { account: 'bob' }, editedAt: 0 }

    render(
      <TranslationProvider translate={translate} cache={makeCache()}>
        <Row message={message} />
      </TranslationProvider>,
    )

    // A hidden tab can still receive observer entries (initial computation).
    // Live-reading visibility must block these, not just the stale-ref case.
    show('m1')
    await sleep(600)

    expect(translate).not.toHaveBeenCalled()
  })
})
```

### 9.6 decisionLog.test.js

檔案:`src/context/TranslationContext/decisionLog.test.js`

```js
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
```

### 9.7 invariants.test.js

檔案:`src/context/TranslationContext/invariants.test.js`

```js
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

describe('queue ceiling scope', () => {
  test('manual jobs waiting past the ceiling are not a violation', () => {
    // The ceiling governs background work only — an explicit request is
    // never refused, so a saturated gate legitimately queues more manual
    // jobs than maxQueueLength. Counting them made the checker cry wolf on
    // exactly the behaviour the store promises.
    const queue = Array.from({ length: 5 }, (_, i) => ({
      messageId: `m${i}`,
      origin: 'manual',
      enqueuedAt: NOW,
    }))
    const entries = queue.map((q) => ({ messageId: q.messageId, status: 'queued', since: NOW }))

    const violations = checkInvariants(
      snap({
        config: { maxConcurrent: 1, maxConcurrentAuto: 1, maxQueueLength: 3 },
        queue,
        entries,
        activeCount: 1,
        activeAutoCount: 0,
        inflight: [{ messageId: 'x', sentAt: NOW }],
      }),
      { now: NOW },
    )

    expect(codes(violations)).not.toContain(INVARIANT.QueueOverLimit)
  })
})
```

### 9.8 autoTranslate.integration.test.js

檔案:`src/context/TranslationContext/autoTranslate.integration.test.js`

```js
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTranslationCache } from '@/lib/idbTranslationCache'
import { AUTO_TRANSLATE_CONFIG, createAutoPolicy } from './autoPolicy'
import { DECISION, createDecisionLog } from './decisionLog'
import { INVARIANT, checkInvariants } from './invariants'
import { createTranslationStore } from './store'
import { createVisibilityObserver } from './visibilityObserver'

// The three modules assembled exactly the way TranslationProvider assembles
// them. Their unit tests each mock the neighbours; this one does not, so a
// mistake in the seams — the order they are built in, which object owns which
// gate, what the policy hands the store — shows up here and nowhere else.
//
// Real timers on purpose. fake-indexeddb schedules its own work on the real
// task queue, so a frozen clock deadlocks the cache instead of speeding the
// test up. The dwell window is shrunk to 20ms instead.

const DWELL_MS = 20

let ios = []

class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback
    this.options = options ?? {}
    this.observed = new Set()
    ios.push(this)
  }
  observe(el) {
    this.observed.add(el)
  }
  unobserve(el) {
    this.observed.delete(el)
  }
  disconnect() {
    this.observed.clear()
  }
  emit(entries) {
    this.callback(
      entries.map(({ target, isIntersecting, top = 0, height = 20 }) => ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: { top, height, bottom: top + height },
      })),
      this,
    )
  }
}

const io = () => ios[ios.length - 1]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let caches = []

function build({ messages, translate, context = {}, config = {} } = {}) {
  const cache = createTranslationCache({
    dbName: `auto-int-${caches.length}-${Math.random().toString(36).slice(2)}`,
  })
  caches.push(cache)

  const registry = new Map(messages.map((m) => [m.id, m]))
  let policy = null

  // One log across all three, exactly as the provider wires it.
  const log = createDecisionLog()

  const observer = createVisibilityObserver({
    dwellMs: DWELL_MS,
    prefetchMarginPx: AUTO_TRANSLATE_CONFIG.prefetchMarginPx,
    log,
    onCandidate: (id) => policy.onCandidate(id),
  })

  const store = createTranslationStore({
    nats: { user: { account: 'alice', siteId: 'site-local' } },
    translate,
    cache,
    log,
    config: {
      maxConcurrent: 4,
      maxConcurrentAuto: 2,
      isAutoEligible: (id) => observer.visibleIds.has(id),
      orderAutoQueue: (ids) => observer.byDistanceFromCentre(ids),
      ...config,
    },
  })

  policy = createAutoPolicy({
    store,
    log,
    getMessage: (id) => registry.get(id),
    getContext: () => ({
      roomId: 'r1',
      targetLang: 'ja',
      autoTranslate: true,
      currentUserAccount: 'alice',
      active: true,
      ...context,
    }),
  })

  const elements = new Map()
  for (const m of messages) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    elements.set(m.id, el)
    observer.observe(m.id, el)
  }

  return { cache, store, policy, observer, elements, log }
}

/** Everything the invariant checks need, assembled the way the provider
 *  assembles it. */
const inspect = ({ store, observer }) => ({
  ...store.inspect(),
  visibleIds: [...observer.visibleIds],
  registeredIds: observer.registeredIds(),
})

function msg(id, content, account = 'bob') {
  return { id, content, sender: { account }, editedAt: 0 }
}

function okTranslate(delayMs = 0) {
  return vi.fn(async (_nats, { text, targetLang }) => {
    if (delayMs) await sleep(delayMs)
    return { translatedText: `[${targetLang}] ${text}`, targetLang }
  })
}

const show = (elements, ids, base = 0) =>
  io().emit(
    ids.map((id, i) => ({
      target: elements.get(id),
      isIntersecting: true,
      top: base + i * 30,
    })),
  )

const hide = (elements, ids) =>
  io().emit(ids.map((id) => ({ target: elements.get(id), isIntersecting: false })))

beforeEach(() => {
  ios = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const cache of caches) await cache.destroy()
  caches = []
  document.body.innerHTML = ''
})

describe('scrolling a message into view', () => {
  test('translates it after the dwell window, end to end', async () => {
    const translate = okTranslate()
    const { store, elements } = build({ messages: [msg('m1', '早安')], translate })

    show(elements, ['m1'])
    await sleep(DWELL_MS + 60)

    expect(translate).toHaveBeenCalledTimes(1)
    expect(store.getEntry('m1').translatedText).toBe('[ja] 早安')
  })

  test('scrolling past faster than the dwell window costs nothing', async () => {
    const translate = okTranslate()
    const { elements } = build({ messages: [msg('m1', '早安')], translate })

    show(elements, ['m1'])
    await sleep(DWELL_MS / 2)
    hide(elements, ['m1'])
    await sleep(DWELL_MS + 60)

    expect(translate).not.toHaveBeenCalled()
  })

  test('never records intent, so turning the switch off restores the source', async () => {
    const translate = okTranslate()
    const { cache, elements } = build({ messages: [msg('m1', '早安')], translate })

    show(elements, ['m1'])
    await sleep(DWELL_MS + 60)

    // The whole "switch off -> instantly back to source" property rests on
    // this: automatic translation writes content but never intent.
    expect(await cache.intent.get('m1')).toBeUndefined()
    expect(await cache.content.peek('m1')).toBeDefined()
  })

  test('a message the user marked "see original" stays untranslated', async () => {
    const translate = okTranslate()
    const { cache, elements } = build({ messages: [msg('m1', '早安')], translate })
    await cache.intent.set('m1', 'r1', 'off')

    show(elements, ['m1'])
    await sleep(DWELL_MS + 60)

    expect(translate).not.toHaveBeenCalled()
  })

  test('your own messages are never sent', async () => {
    const translate = okTranslate()
    const { elements } = build({ messages: [msg('m1', 'my own words', 'alice')], translate })

    show(elements, ['m1'])
    await sleep(DWELL_MS + 60)

    expect(translate).not.toHaveBeenCalled()
  })
})

describe('a screenful of messages', () => {
  const many = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, `line ${i}`))
  const ids = many.map((m) => m.id)

  test('respects the automatic sub-gate while they all dwell at once', async () => {
    let inFlight = 0
    let peak = 0
    const translate = vi.fn(async (_nats, { text, targetLang }) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await sleep(15)
      inFlight -= 1
      return { translatedText: `[${targetLang}] ${text}`, targetLang }
    })

    const { elements } = build({ messages: many, translate })

    show(elements, ids)
    await sleep(DWELL_MS + 400)

    expect(peak).toBeLessThanOrEqual(2)
    expect(translate.mock.calls.length).toBeGreaterThan(2)
  })

  test('a message that scrolls away before its turn is never requested', async () => {
    const translate = okTranslate(40)
    const { elements, observer } = build({ messages: many, translate })

    show(elements, ids)
    await sleep(DWELL_MS + 10)

    // Everything below the first two leaves the viewport while the first two
    // are still on the wire.
    hide(elements, ids.slice(2))
    await sleep(300)

    expect(observer.visibleIds.size).toBe(2)
    const requested = translate.mock.calls.map((c) => c[1].text)
    for (const m of many.slice(2)) {
      expect(requested).not.toContain(m.content)
    }
  })

  test('an explicit request is not stuck behind the automatic queue', async () => {
    const translate = okTranslate(60)
    const { store, elements } = build({ messages: many, translate })

    show(elements, ids)
    await sleep(DWELL_MS + 10)

    store.translate('urgent', {
      roomId: 'r1',
      text: 'clicked',
      targetLang: 'ja',
      srcVersion: 0,
      origin: 'manual',
    })
    await sleep(20)

    // Two automatic slots are busy; the manual request must have taken one of
    // the remaining ones rather than queued behind them.
    const requested = translate.mock.calls.map((c) => c[1].text)
    expect(requested).toContain('clicked')
  })
})

describe('the decision log', () => {
  test('records why a message was skipped, not just that nothing happened', async () => {
    const translate = okTranslate()
    const harness = build({ messages: [msg('m1', 'my own words', 'alice')], translate })

    show(harness.elements, ['m1'])
    await sleep(DWELL_MS + 60)

    // The symptom is "this message never gets translated". Without the log
    // there is nothing at all to read: no request, no error, no state change.
    const kinds = harness.log.timeline('m1').map((r) => r.kind)
    expect(kinds).toContain(DECISION.Visible)
    expect(kinds).toContain(DECISION.Dwell)
    expect(kinds).toContain(DECISION.Skip)
    expect(harness.log.timeline('m1').at(-1).reason).toBe('own-message')
  })

  test('separates waiting in the queue from waiting on the backend', async () => {
    const translate = okTranslate(40)
    const messages = Array.from({ length: 6 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const harness = build({ messages, translate })

    show(
      harness.elements,
      messages.map((m) => m.id),
    )
    await sleep(DWELL_MS + 400)

    const sends = harness.log.records().filter((r) => r.kind === DECISION.Send)
    const settles = harness.log.records().filter((r) => r.kind === DECISION.Settle)

    // Two automatic slots and six candidates: something must have waited for a
    // slot, and every send must report how long it waited. That number is the
    // one that tells a saturated gate apart from a slow backend.
    expect(sends.length).toBeGreaterThan(2)
    expect(sends.every((r) => typeof r.waitedMs === 'number')).toBe(true)
    expect(sends.some((r) => r.waitedMs > 0)).toBe(true)
    expect(settles.every((r) => typeof r.tookMs === 'number')).toBe(true)
  })

  test('records a dropped job with its reason, so a silent drop is still visible', async () => {
    const translate = okTranslate(40)
    const messages = Array.from({ length: 8 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const harness = build({ messages, translate })
    const ids = messages.map((m) => m.id)

    show(harness.elements, ids)
    await sleep(DWELL_MS + 10)
    hide(harness.elements, ids.slice(2))
    await sleep(300)

    const drops = harness.log.records().filter((r) => r.kind === DECISION.Drop)
    expect(drops.length).toBeGreaterThan(0)
    expect(drops[0].reason).toBe('left-viewport')
  })
})

describe('invariants on the real path', () => {
  test('hold while a screenful is being translated', async () => {
    const translate = okTranslate(20)
    const messages = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const harness = build({ messages, translate })

    show(
      harness.elements,
      messages.map((m) => m.id),
    )

    // Sampled repeatedly rather than once at the end: the states worth
    // checking — a full sub-gate, a job mid-flight, a queue draining — only
    // exist while the work is in progress.
    for (let i = 0; i < 12; i += 1) {
      expect(checkInvariants(inspect(harness))).toEqual([])
      await sleep(20)
    }
  })

  test('hold once everything has settled', async () => {
    const translate = okTranslate()
    const messages = Array.from({ length: 5 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const harness = build({ messages, translate })

    show(
      harness.elements,
      messages.map((m) => m.id),
    )
    await sleep(DWELL_MS + 400)

    const snapshot = inspect(harness)
    expect(checkInvariants(snapshot)).toEqual([])
    expect(snapshot.queue).toHaveLength(0)
    expect(snapshot.activeCount).toBe(0)
  })

  test('a request that never replies shows as a stalled job, then gives its slot back', async () => {
    // The failure mode the checks exist for: no error, no rejected promise,
    // the queue simply stops. Two of these fill the automatic sub-gate, and
    // without a timeout automatic translation is over for the session.
    const translate = vi.fn(() => new Promise(() => {}))
    const messages = [msg('m0', 'line 0'), msg('m1', 'line 1'), msg('m2', 'line 2')]
    const harness = build({ messages, translate, config: { timeoutMs: 120 } })

    show(
      harness.elements,
      messages.map((m) => m.id),
    )
    await sleep(DWELL_MS + 40)

    const stuck = inspect(harness)
    expect(stuck.activeAutoCount).toBe(2)
    // Nothing is wrong yet — it becomes wrong once it has lasted. A zero
    // threshold stands in for the wall-clock one a live session would use.
    const stalled = checkInvariants(stuck, { stallMs: 0 })
    expect(stalled.filter((v) => v.code === INVARIANT.StalledJob)).toHaveLength(2)

    await sleep(200)

    // The timeout ended both, and the third message got its turn rather than
    // waiting behind two requests that were never coming back. It is now
    // occupying a slot of its own — hence "fewer than two", not "none".
    const recovered = inspect(harness)
    expect(recovered.activeAutoCount).toBeLessThan(2)
    expect(checkInvariants(recovered)).toEqual([])
    expect(translate.mock.calls.length).toBeGreaterThan(2)
  })

  test('the queue stops growing at its ceiling instead of tracking the whole room', async () => {
    const translate = vi.fn(() => new Promise(() => {}))
    const messages = Array.from({ length: 20 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const harness = build({ messages, translate, config: { maxQueueLength: 5, timeoutMs: 0 } })

    show(
      harness.elements,
      messages.map((m) => m.id),
    )
    await sleep(DWELL_MS + 120)

    const snapshot = inspect(harness)
    expect(snapshot.queue.length).toBeLessThanOrEqual(5)
    expect(checkInvariants(snapshot)).toEqual([])
  })
})

describe('outage handling', () => {
  test('stops issuing requests once the circuit opens, silently', async () => {
    const translate = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { code: 'internal' })
    })
    const messages = Array.from({ length: 9 }, (_, i) => msg(`m${i}`, `line ${i}`))
    const { elements } = build({ messages, translate })

    // One at a time, so the failures are consecutive rather than concurrent.
    for (const m of messages) {
      show(elements, [m.id])
      await sleep(DWELL_MS + 40)
    }

    // Five consecutive failures trip the breaker; the remaining messages must
    // not each cost another request.
    expect(translate.mock.calls.length).toBeLessThanOrEqual(
      AUTO_TRANSLATE_CONFIG.failureCircuitThreshold,
    )
  })
})
```

### 9.9 stress.integration.test.js — 混沌測試(§8.1)

檔案:`src/context/TranslationContext/stress.integration.test.js`

```js
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTranslationCache } from '@/lib/idbTranslationCache'
import { createAutoPolicy } from './autoPolicy'
import { DECISION, createDecisionLog } from './decisionLog'
import { checkInvariants } from './invariants'
import { createTranslationStore } from './store'
import { createVisibilityObserver } from './visibilityObserver'

// Chaos harness: a seeded random event stream — visibility churn, edits,
// reverts, manual clicks, a backend flipping between healthy, failing and
// silent, and sweep ticks — driven through the real three-module assembly,
// with every queue invariant checked after every single step.
//
// The scenario tests each pin one interleaving somebody thought of. This one
// exists for the interleavings nobody thought of: with a fixed seed a failure
// replays deterministically, so a red run here is a reproducible bug report,
// not flake.
//
// Timers are real (fake-indexeddb deadlocks under a frozen clock); all delays
// are single-digit milliseconds to keep the whole file under a few seconds.

const TOTAL = 24
const STEPS = 220
const SEEDS = [11, 47, 83]

const DWELL_MS = 6
const TIMEOUT_MS = 60

/** mulberry32 — tiny, deterministic, good enough for event selection. */
function mulberry32(seed) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ios = []

class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback
    ios.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const io = () => ios[ios.length - 1]

let caches = []

function build(rand) {
  const cache = createTranslationCache({
    dbName: `stress-${Math.random().toString(36).slice(2)}`,
  })
  caches.push(cache)

  const messages = Array.from({ length: TOTAL }, (_, i) => ({
    id: `m${i}`,
    content: `line ${i}`,
    sender: { account: 'bob' },
    editedAt: 0,
  }))
  const registry = new Map(messages.map((m) => [m.id, m]))
  const log = createDecisionLog({ cap: 100_000 })
  let policy = null

  // 'ok' resolves after a short latency, 'fail' rejects, 'silent' never
  // settles — the store's timeout is what reclaims those slots.
  const backend = { mode: 'ok' }
  const translate = vi.fn(async (_n, { text, targetLang }) => {
    if (backend.mode === 'silent') return new Promise(() => {})
    await sleep(4 + Math.floor(rand() * 8))
    if (backend.mode === 'fail') {
      throw Object.assign(new Error('boom'), { code: 'internal' })
    }
    return { translatedText: `[${targetLang}] ${text}`, targetLang }
  })

  const observer = createVisibilityObserver({
    dwellMs: DWELL_MS,
    prefetchMarginPx: 0,
    log,
    onCandidate: (id) => policy.onCandidate(id),
  })

  const store = createTranslationStore({
    nats: { user: { account: 'alice', siteId: 'site-local' } },
    translate,
    cache,
    log,
    config: {
      maxConcurrent: 4,
      maxConcurrentAuto: 2,
      timeoutMs: TIMEOUT_MS,
      // Small on purpose: refusals must actually happen for the sweep's
      // repair path to be exercised.
      maxQueueLength: 3,
      isAutoEligible: (id) => observer.visibleIds.has(id),
      orderAutoQueue: (ids) => observer.byDistanceFromCentre(ids),
    },
  })

  policy = createAutoPolicy({
    store,
    log,
    getVisibleIds: () => observer.visibleIds,
    getMessage: (id) => registry.get(id),
    getContext: () => ({
      roomId: 'r1',
      targetLang: 'ja',
      autoTranslate: true,
      currentUserAccount: 'alice',
      active: true,
    }),
    config: {
      maxRequestsPerMinute: 10_000,
      failureCircuitThreshold: 4,
      failureCircuitCooldownMs: 40,
    },
  })

  const elements = new Map()
  for (const m of messages) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    elements.set(m.id, el)
    observer.observe(m.id, el)
  }

  const snapshot = () => ({
    ...store.inspect(),
    visibleIds: [...observer.visibleIds],
    registeredIds: observer.registeredIds(),
  })

  return { cache, store, policy, observer, elements, log, registry, backend, translate, snapshot }
}

beforeEach(() => {
  ios = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const cache of caches) await cache.destroy()
  caches = []
  document.body.innerHTML = ''
})

describe.each(SEEDS)('randomized interleavings, seed %i', (seed) => {
  test('every step preserves the queue invariants and the run converges', async () => {
    const rand = mulberry32(seed)
    const h = build(rand)
    const pick = (arr) => arr[Math.floor(rand() * arr.length)]
    const id = () => `m${Math.floor(rand() * TOTAL)}`

    const visible = new Set()
    const show = (mid) => {
      if (visible.has(mid)) return
      visible.add(mid)
      io().callback(
        [
          {
            target: h.elements.get(mid),
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: { top: rand() * 600, height: 30, bottom: 30 },
          },
        ],
        io(),
      )
    }
    const hide = (mid) => {
      if (!visible.delete(mid)) return
      io().callback(
        [
          {
            target: h.elements.get(mid),
            isIntersecting: false,
            intersectionRatio: 0,
            boundingClientRect: { top: 0, height: 30, bottom: 30 },
          },
        ],
        io(),
      )
    }

    // The user's explicit choices, tracked so the convergence assertion can
    // honour them: a reverted message must stay untranslated.
    const reverted = new Set()

    const allViolations = []
    const check = (step, op) => {
      const violations = checkInvariants(h.snapshot(), { stallMs: 10_000 })
      for (const v of violations) allViolations.push({ step, op, ...v })
    }

    for (let step = 0; step < STEPS; step += 1) {
      const op = pick([
        'show', 'show', 'show',
        'hide', 'hide',
        'sweep', 'sweep',
        'edit',
        'manual',
        'revert',
        'flip',
        'wait',
      ])

      switch (op) {
        case 'show':
          show(id())
          break
        case 'hide':
          hide(id())
          break
        case 'sweep':
          h.policy.recheckVisible()
          break
        case 'edit': {
          const mid = id()
          h.registry.get(mid).editedAt += 1
          await h.store.onMessageEdited(mid)
          break
        }
        case 'manual': {
          const mid = id()
          reverted.delete(mid)
          h.store.translate(mid, {
            roomId: 'r1',
            text: h.registry.get(mid).content,
            targetLang: 'ja',
            srcVersion: h.registry.get(mid).editedAt,
            origin: 'manual',
          })
          break
        }
        case 'revert': {
          const mid = id()
          reverted.add(mid)
          await h.store.revert(mid, 'r1')
          break
        }
        case 'flip':
          h.backend.mode = pick(['ok', 'ok', 'fail', 'silent'])
          break
        case 'wait':
          await sleep(1 + Math.floor(rand() * 8))
          break
      }

      check(step, op)
    }

    expect(allViolations).toEqual([])

    // ---- convergence: heal the backend and let the repair paths finish.
    //
    // The sweep re-offers only `idle` — a message that FAILED during the
    // outage retries when it leaves and re-enters the viewport, by design.
    // Model that the way a reader produces it: scroll away, scroll back.
    h.backend.mode = 'ok'
    const onScreen = [...visible]
    for (let i = 0; i < 150; i += 1) {
      // Periodic leave-and-return, because one is not always enough: a
      // re-entry candidate that lands while the failure circuit is still in
      // an accumulated-backoff cooldown is skipped, the message stays
      // 'failed', and the sweep will not touch it — only the NEXT re-entry
      // retries. A reader scrolling around produces exactly this.
      if (i % 20 === 0) {
        for (const mid of onScreen) hide(mid)
        await sleep(DWELL_MS + 5)
        for (const mid of onScreen) show(mid)
      }
      h.policy.recheckVisible()
      await sleep(10)
      const snap = h.snapshot()
      const settledDown = snap.activeCount === 0 && snap.queue.length === 0
      const done = [...visible].every((mid) => {
        const status = h.store.getEntry(mid).status
        if (reverted.has(mid)) return status !== 'translated'
        return status === 'translated'
      })
      if (settledDown && done) break
    }

    const finalSnap = h.snapshot()
    expect(checkInvariants(finalSnap, { stallMs: 10_000 })).toEqual([])
    expect(finalSnap.activeCount).toBe(0)
    expect(finalSnap.queue).toHaveLength(0)

    for (const mid of visible) {
      const status = h.store.getEntry(mid).status
      if (reverted.has(mid)) {
        // "See original" is the user's explicit word; no amount of sweeping
        // may override it.
        expect(status, `${mid} was reverted`).not.toBe('translated')
      } else {
        expect(status, `${mid} is visible and unreverted`).toBe('translated')
      }
    }

    // Ledger consistency: every request that went out came back, one way or
    // another, and the log agrees with itself.
    const records = h.log.records()
    const sends = records.filter((r) => r.kind === DECISION.Send).length
    const settles = records.filter((r) => r.kind === DECISION.Settle).length
    expect(settles).toBe(sends)
  }, 30_000)
})
```

### 9.10 scrollAnalysis.test.js — 調參量測 harness(§8.3,env-gated)

檔案:`src/context/TranslationContext/scrollAnalysis.test.js`

```js
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTranslationCache } from '@/lib/idbTranslationCache'
import { AUTO_TRANSLATE_CONFIG, createAutoPolicy } from './autoPolicy'
import { DECISION, createDecisionLog } from './decisionLog'
import { checkInvariants } from './invariants'
import { createTranslationStore } from './store'
import { createVisibilityObserver } from './visibilityObserver'

// Investigation harness, not a behavioural test. It drives the three modules
// through a realistic scroll and reports what the decision log says about it.
//
// Opt-in: it adds ~40s of simulated scrolling to a suite run and prints an
// analysis report, so it stays out of the default `npm test`. Run it with
//
//   TRANSLATION_SCROLL_ANALYSIS=1 npx vitest run src/context/TranslationContext/scrollAnalysis.test.js
//
// Kept in the tree because it is the instrument the queue-policy numbers came
// from — rerun it after any change to dwell, concurrency, ceiling or sweep,
// and to compare against other implementations of the same design.
//
// The important fidelity detail: a real IntersectionObserver only fires when
// an element CROSSES the threshold. A message that stays on screen across
// several scroll steps produces no further entries at all. The simulation
// emits entries only on state changes, for exactly that reason.

const DWELL_MS = AUTO_TRANSLATE_CONFIG.dwellMs // 400
const LATENCY_MS = 800
const SCROLL_STEP_MS = 250
const WINDOW = 12
const STEP = 3
const TOTAL = 100
const ROW_HEIGHT = 60

let ios = []
let caches = []

class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback
    ios.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  emit(entries) {
    this.callback(entries, this)
  }
}

const describeAnalysis = process.env.TRANSLATION_SCROLL_ANALYSIS === '1' ? describe : describe.skip

const io = () => ios[ios.length - 1]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function build(configOverrides = {}) {
  const cache = createTranslationCache({
    dbName: `scroll-analysis-${Math.random().toString(36).slice(2)}`,
  })
  caches.push(cache)

  const messages = Array.from({ length: TOTAL }, (_, i) => ({
    id: `m${i}`,
    content: `line ${i}`,
    sender: { account: 'bob' },
    editedAt: 0,
  }))
  const registry = new Map(messages.map((m) => [m.id, m]))
  const log = createDecisionLog()
  let policy = null

  const observer = createVisibilityObserver({
    dwellMs: DWELL_MS,
    prefetchMarginPx: AUTO_TRANSLATE_CONFIG.prefetchMarginPx,
    log,
    onCandidate: (id) => policy.onCandidate(id),
  })

  const store = createTranslationStore({
    nats: { user: { account: 'alice', siteId: 'site-local' } },
    translate: vi.fn(async (_n, { text, targetLang }) => {
      await sleep(LATENCY_MS)
      return { translatedText: `[${targetLang}] ${text}`, targetLang }
    }),
    cache,
    log,
    config: {
      maxConcurrent: AUTO_TRANSLATE_CONFIG.maxConcurrent,
      maxConcurrentAuto: AUTO_TRANSLATE_CONFIG.maxConcurrentAuto,
      timeoutMs: AUTO_TRANSLATE_CONFIG.timeoutMs,
      maxQueueLength: AUTO_TRANSLATE_CONFIG.maxQueueLength,
      isAutoEligible: (id) => observer.visibleIds.has(id),
      orderAutoQueue: (ids) => observer.byDistanceFromCentre(ids),
      ...configOverrides,
    },
  })

  policy = createAutoPolicy({
    store,
    log,
    getVisibleIds: () => observer.visibleIds,
    getMessage: (id) => registry.get(id),
    getContext: () => ({
      roomId: 'r1',
      targetLang: 'ja',
      autoTranslate: true,
      currentUserAccount: 'alice',
      active: true,
    }),
  })

  // jsdom performs no layout, so every element would report an all-zero box
  // and the observer would fall back to its cached crossing positions —
  // silently not exercising the live measurement at all. Each row therefore
  // carries a position the scroll keeps up to date, the way a browser would.
  const elements = new Map()
  const positions = new Map()
  for (const m of messages) {
    const el = document.createElement('div')
    el.getBoundingClientRect = () => {
      const top = positions.get(m.id)
      if (top === undefined) return { top: 0, height: 0, bottom: 0 }
      return { top, height: ROW_HEIGHT, bottom: top + ROW_HEIGHT }
    }
    document.body.appendChild(el)
    elements.set(m.id, el)
    observer.observe(m.id, el)
  }

  // The viewport is 12 rows tall and sits at a fixed screen position; the
  // content scrolls under it.
  observer.setViewportCentre((WINDOW * ROW_HEIGHT) / 2)

  return { cache, store, policy, observer, elements, positions, log, messages }
}

beforeEach(() => {
  ios = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const cache of caches) await cache.destroy()
  caches = []
  document.body.innerHTML = ''
})

describeAnalysis('scrolling a long room', () => {
  test('analysis', async () => {
    const h = build()
    const onScreen = new Set()
    const samples = []
    const violations = []
    /** The screen position each row genuinely has right now. */
    const trueCentre = new Map()

    const scrollTo = (top) => {
      const next = new Set()
      for (let i = top; i < Math.min(top + WINDOW, TOTAL); i += 1) next.add(`m${i}`)

      const entries = []
      for (const id of next) {
        const index = Number(id.slice(1))
        const y = (index - top) * ROW_HEIGHT
        // Every visible row moves on every scroll step, whether or not it
        // crosses an edge. That is precisely what the observer cannot see.
        h.positions.set(id, y)
        trueCentre.set(id, y + ROW_HEIGHT / 2)
        // Only a CROSSING produces an entry. A row already on screen stays
        // silent no matter how far it has moved.
        if (!onScreen.has(id)) {
          entries.push({
            target: h.elements.get(id),
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: { top: y, height: ROW_HEIGHT, bottom: y + ROW_HEIGHT },
          })
        }
      }
      for (const id of onScreen) {
        if (!next.has(id)) {
          trueCentre.delete(id)
          h.positions.delete(id)
          entries.push({
            target: h.elements.get(id),
            isIntersecting: false,
            intersectionRatio: 0,
            boundingClientRect: { top: 0, height: ROW_HEIGHT, bottom: ROW_HEIGHT },
          })
        }
      }
      if (entries.length) io().emit(entries)
      onScreen.clear()
      for (const id of next) onScreen.add(id)
    }

    scrollTo(0)
    for (let top = 0; top + WINDOW <= TOTAL; top += STEP) {
      scrollTo(top)
      const snapshot = {
        ...h.store.inspect(),
        visibleIds: [...h.observer.visibleIds],
        registeredIds: h.observer.registeredIds(),
      }
      samples.push({
        top,
        queue: snapshot.queue.length,
        active: snapshot.activeCount,
        auto: snapshot.activeAutoCount,
        visible: snapshot.visibleIds.length,
      })
      violations.push(...checkInvariants(snapshot))
      await sleep(SCROLL_STEP_MS)
    }

    // Let everything in flight land.
    await sleep(LATENCY_MS * 3)

    const records = h.log.records()
    const by = (kind) => records.filter((r) => r.kind === kind)
    const count = (kind) => by(kind).length

    const skipReasons = {}
    for (const r of by(DECISION.Skip)) skipReasons[r.reason] = (skipReasons[r.reason] ?? 0) + 1
    const dropReasons = {}
    for (const r of by(DECISION.Drop)) dropReasons[r.reason] = (dropReasons[r.reason] ?? 0) + 1

    const sends = by(DECISION.Send)
    const settles = by(DECISION.Settle)
    const waits = sends.map((r) => r.waitedMs).sort((a, b) => a - b)
    const tooks = settles.map((r) => r.tookMs).sort((a, b) => a - b)

    // Work paid for that the reader never saw. Reconstructed properly: replay
    // the visible/hidden records for that message and ask what its state was
    // at the instant its reply landed. "Hidden at some point afterwards" is
    // not the same question — everything is hidden once the scroll ends.
    const sentIds = new Set(sends.map((r) => r.messageId))
    const visibleAt = (id, t) => {
      let visible = false
      for (const r of records) {
        if (r.messageId !== id || r.t > t) continue
        if (r.kind === DECISION.Visible) visible = true
        if (r.kind === DECISION.Hidden) visible = false
      }
      return visible
    }
    const wasted = settles.filter((r) => r.ok && !visibleAt(r.messageId, r.t))

    // The ordering question: byDistanceFromCentre ranks on the position the
    // observer recorded when the row CROSSED the edge. For a row that has
    // since travelled across the viewport, that number is stale. Measure how
    // far off it is for the rows on screen right now.
    const rankErrors = []
    for (const [id, actual] of trueCentre) {
      const believedOrder = h.observer.byDistanceFromCentre([...trueCentre.keys()])
      const believedRank = believedOrder.indexOf(id)
      const actualOrder = [...trueCentre.entries()]
        .sort((a, b) => Math.abs(a[1] - 360) - Math.abs(b[1] - 360))
        .map(([k]) => k)
      const actualRank = actualOrder.indexOf(id)
      rankErrors.push(Math.abs(believedRank - actualRank))
      void actual
    }
    const meanRankError = rankErrors.length
      ? (rankErrors.reduce((a, b) => a + b, 0) / rankErrors.length).toFixed(2)
      : 'n/a'

    /* eslint-disable no-console */
    console.log('\n===== SCROLL ANALYSIS =====')
    console.log(`messages=${TOTAL} window=${WINDOW} step=${STEP} scrollEvery=${SCROLL_STEP_MS}ms`)
    console.log(
      `dwell=${DWELL_MS}ms latency=${LATENCY_MS}ms autoGate=${AUTO_TRANSLATE_CONFIG.maxConcurrentAuto}`,
    )
    console.log('---- decision counts ----')
    console.log({
      visible: count(DECISION.Visible),
      hidden: count(DECISION.Hidden),
      dwell: count(DECISION.Dwell),
      skip: count(DECISION.Skip),
      suppressed: count(DECISION.Suppressed),
      enqueue: count(DECISION.Enqueue),
      send: count(DECISION.Send),
      drop: count(DECISION.Drop),
      settle: count(DECISION.Settle),
      cached: count(DECISION.Cached),
      deduped: count(DECISION.Deduped),
    })
    console.log('skip reasons', skipReasons)
    console.log('drop reasons', dropReasons)
    console.log('---- latency ----')
    console.log({
      queueWaitMedian: waits[Math.floor(waits.length / 2)],
      queueWaitMax: waits[waits.length - 1],
      backendMedian: tooks[Math.floor(tooks.length / 2)],
      cancelledDwells: by(DECISION.Hidden).filter((r) => r.cancelledDwell).length,
    })
    console.log('---- coverage ----')
    console.log({
      messagesSeen: new Set(by(DECISION.Visible).map((r) => r.messageId)).size,
      messagesDwelled: new Set(by(DECISION.Dwell).map((r) => r.messageId)).size,
      messagesSent: sentIds.size,
      repliesThatLandedOffScreen: `${wasted.length}/${settles.filter((r) => r.ok).length}`,
    })
    console.log('---- queue depth over the scroll (top:queue/auto/visible) ----')
    console.log(samples.map((s) => `${s.top}:q${s.queue}/a${s.auto}/v${s.visible}`).join(' '))
    console.log('---- invariants ----')
    console.log(violations.length === 0 ? 'no violations' : violations.slice(0, 10))
    console.log('---- centre ranking ----')
    console.log(`mean rank error vs true position: ${meanRankError} (0 = perfect)`)
    console.log('===========================\n')
    /* eslint-enable no-console */

    expect(records.length).toBeGreaterThan(0)
  }, 60_000)
})


describeAnalysis('scrolling, then stopping to read', () => {
  /** Scroll for a while, stop, and watch what the screen you settled on does.
   *  `sweep` mirrors the provider's recheck interval. */
  async function stopAndRead(label, configOverrides, { sweep = true } = {}) {
    const h = build(configOverrides)
    const sweepTimer = sweep
      ? setInterval(() => h.policy.recheckVisible(), AUTO_TRANSLATE_CONFIG.recheckIntervalMs)
      : null
    const onScreen = new Set()
    let currentTop = 0
    /** Settles landing on a row ABOVE the viewport. Swapping text there
     *  changes its height, shifting everything below it. */
    let settledAbove = 0
    h.log.subscribe((r) => {
      if (r.kind !== DECISION.Settle || !r.ok) return
      if (Number(r.messageId.slice(1)) < currentTop) settledAbove += 1
    })

    const scrollTo = (top) => {
      currentTop = top
      const next = new Set()
      const entries = []
      for (let i = top; i < Math.min(top + WINDOW, TOTAL); i += 1) {
        const id = `m${i}`
        next.add(id)
        h.positions.set(id, (i - top) * ROW_HEIGHT)
        if (!onScreen.has(id)) {
          entries.push({
            target: h.elements.get(id),
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: {
              top: (i - top) * ROW_HEIGHT,
              height: ROW_HEIGHT,
              bottom: (i - top + 1) * ROW_HEIGHT,
            },
          })
        }
      }
      for (const id of onScreen) {
        if (next.has(id)) continue
        h.positions.delete(id)
        entries.push({
          target: h.elements.get(id),
          isIntersecting: false,
          intersectionRatio: 0,
          boundingClientRect: { top: 0, height: ROW_HEIGHT, bottom: ROW_HEIGHT },
        })
      }
      if (entries.length) io().emit(entries)
      onScreen.clear()
      for (const id of next) onScreen.add(id)
    }

    // Far enough to build the backlog a real reader builds while hunting for
    // where they left off. The distance matters: a short scroll leaves an
    // empty queue and flatters the result.
    for (let top = 0; top <= 75; top += STEP) {
      scrollTo(top)
      await sleep(SCROLL_STEP_MS)
    }

    // Now stop. This is the moment the user starts reading.
    const stoppedAt = Date.now()
    const visible = [...onScreen]
    const translatedAt = new Map()
    let waited = 0
    while (translatedAt.size < visible.length && waited < 10_000) {
      for (const id of visible) {
        if (translatedAt.has(id)) continue
        if (h.store.getEntry(id).status === 'translated') {
          translatedAt.set(id, Date.now() - stoppedAt)
        }
      }
      await sleep(100)
      waited = Date.now() - stoppedAt
    }

    if (sweepTimer) clearInterval(sweepTimer)
    const times = [...translatedAt.values()].sort((a, b) => a - b)
    const stuck = visible.filter((id) => !translatedAt.has(id))

    /* eslint-disable no-console */
    console.log(`\n===== STOP AND READ — ${label} =====`)
    console.log({
      translatedOnScreen: `${translatedAt.size}/${visible.length}`,
      firstAfterMs: times[0] ?? null,
      lastAfterMs: times[times.length - 1] ?? null,
      settledAboveViewport: settledAbove,
    })
    for (const id of stuck.slice(0, 2)) {
      console.log(
        `  ${id} [${h.store.getEntry(id).status}] visible=${h.observer.visibleIds.has(id)}`,
        h.log
          .timeline(id)
          .map((r) => `${r.kind}${r.reason ? `(${r.reason})` : ''}+${r.sinceFirst}ms`)
          .join(' → '),
      )
    }
    console.log('==========================================\n')
    /* eslint-enable no-console */

    return { translated: translatedAt.size, total: visible.length, stuck }
  }

  test('the sweep is what makes a queue ceiling survivable', async () => {
    // Without it, the observer raises a candidate once per visibility
    // transition, so a message refused while it STAYS on screen gets no
    // second chance: it sits at 'idle' in the middle of the viewport showing
    // its source text for as long as the user looks at it.
    const unswept = await stopAndRead('ceiling 50, no sweep', { maxQueueLength: 50 }, {
      sweep: false,
    })
    const swept = await stopAndRead('ceiling 50, with sweep (shipping)', { maxQueueLength: 50 })

    expect(unswept.stuck.length).toBeGreaterThan(0)
    expect(swept.translated).toBeGreaterThan(unswept.translated)
    expect(swept.stuck).toEqual([])
  }, 90_000)
})
```

### 9.11 mutation-test.py — 突變測試腳本(§8.2,置於 repo 外執行)

檔案:`mutation-test.py`

```python
import subprocess, shutil, sys, os

ROOT = 'src/context/TranslationContext'
VO = f'{ROOT}/visibilityObserver.js'
AP = f'{ROOT}/autoPolicy.js'

# (file, name, what-bug-this-reintroduces, old, new)
MUTANTS = [
    (VO, 'M1 hide-keeps-dwell', 'scrolling past still translates',
     '    cancelDwell(id)\n    if (wasVisible) {', '    if (wasVisible) {'),
    (VO, 'M2 dwell-restarts', 're-render restarts served dwell',
     'if (visibleIds.has(id)) return', 'if (false) return'),
    (VO, 'M3 negative-margin', 'negative rootMargin kills all intersection',
     'Math.max(0, config.prefetchMarginPx)', 'config.prefetchMarginPx'),
    (VO, 'M4 stale-centre', 'ranking by entry position again',
     'if (rect && (rect.height > 0 || rect.top !== 0)) return rect.top + rect.height / 2',
     'if (false) return 0'),
    (AP, 'M5 bad-request-counts', 'one malformed message trips the breaker',
     "if (err?.code === 'bad_request') return", 'if (false) return'),
    (AP, 'M6 probe-stampede', 'every candidate probes an open circuit',
     'if (probing) return true', 'if (false) return true'),
    (AP, 'M7 charge-on-enqueue', 'ghost requests eat the rate budget',
     'if (!(await result.sent)) {', 'if (false) {'),
    (AP, 'M8 sweep-retries-failed', 'infinite retry of rejected bodies',
     "if (store.getEntry(id).status !== 'idle') continue", 'if (false) continue'),
    (AP, 'M9 sweep-ignores-gates', 'per-tick log churn while auto is off',
     'if (!ctx.autoTranslate || !ctx.active) return', 'if (false) return'),
]

FAST = [f'{ROOT}/visibilityObserver.test.js', f'{ROOT}/autoPolicy.test.js']
SLOW = [f'{ROOT}/autoTranslate.integration.test.js', f'{ROOT}/stress.integration.test.js']

def run(files):
    r = subprocess.run(['npx', 'vitest', 'run', *files],
                       capture_output=True, text=True, timeout=300)
    return r.returncode == 0  # True = suite passed = mutant SURVIVED this tier

results = []
for path, name, bug, old, new in MUTANTS:
    src = open(path).read()
    if old not in src:
        results.append((name, 'PATCH-MISS'))
        continue
    shutil.copy(path, path + '.bak')
    try:
        open(path, 'w').write(src.replace(old, new, 1))
        if not run(FAST):
            results.append((name, 'KILLED (unit)'))
        elif not run(SLOW):
            results.append((name, 'KILLED (integration/chaos)'))
        else:
            results.append((name, 'SURVIVED'))
    finally:
        shutil.move(path + '.bak', path)

print('\n=== MUTATION RESULTS ===')
for name, verdict in results:
    print(f'{verdict:28s} {name}')
survived = [n for n, v in results if v in ('SURVIVED', 'PATCH-MISS')]
print(f'\nkilled {len(results) - len(survived)}/{len(results)}')
sys.exit(1 if survived else 0)
```
