# 05 — 子任務

開工前讀一次,之後每完成一項回來勾。每項都寫了**驗收條件** —— 沒達成就不算完成,
不要往下走。

## 相依圖

```
Phase A ─────────────────────────────────────────────┐
 A1 ──► A2 ──┬──► A2b                                │
             ├──► A3                                 │
             ├──► A4 ──► A5                          │
             └──► A6 ──► A7 ──► A8 ★ 量測點           │
                                                     ▼
Phase B                                        (A8 之後才開始)
 B1 ──┬──► B2
      ├──► B3
      ├──► B4
      └──► B5
                                                     │
Phase C ◄────────────────────────────────────────────┘
 C1 ──┐
 C2 ──┼──► C3 ──► C4 ──► C5 ──► C6 ──► C7 ──► C8 ──┬──► C9
      │                                            ├──► C10
      │                                            └──► C11
      └──────────────────────────────────► C12 ──► C13 ★ 上線點
                                                     │
Phase D ◄────────────────────────────────────────────┘
 D1 ──┬──► D2 ──► D3 ──► D4 ──┬──► D5
      │                       └──► D6
      └──► D7 ──► D8 ──► D9 ──► D10 ★ 完成
```

★ = 必須停下來量測/上線的節點。

---

## Phase A — 觀察器

### A1 — 整檔替換 `visibilityTracker.ts` 的實作
貼上 `01-phase-A-observer.md` §A.1 的 `createVisibilityObserver`。逐字採用。
**驗收:** `npm run typecheck` 通過。舊的 `elements` / `elementToId` 雙 Map、
`lookupId` / `lookupEl` / `onEnter` / `onLeave` 全部不再存在。

### A2 — 加上相容包裝層
貼上 §A.2。保留模組單例 export `visibilityObserver`。
**驗收:** `autoPolicy.ts` 與 `store.ts` 對 `visibilityObserver` 的 import 一行
未改仍能編譯,除了 `reset` 與 `distanceToCenter` 的呼叫點報錯(這是預期的,
A2b/A4 處理)。包裝層**不得**有 `distanceToCenter` —— 見 §A.2 的說明。

### A2b — pump 的排序改用 `byDistanceFromCentre`
`01-phase-A-observer.md` §A.3,三行。
**驗收:** 全域搜尋 `distanceToCenter` 為零結果。排序只讀一次 layout,不在
comparator 裡讀。

### A3 — 刪掉 `startAutoPolicy()` 裡的 `visibilityObserver.reset()`
整行刪除,不要換成別的。
**驗收:** 打開自動翻譯開關時,當下畫面上的訊息會開始翻譯,不需要先捲一下。

### A4 — 其餘 `reset()` 呼叫點改為 `destroy()`
`resetAutoPolicy()` 與換房間處。逐一確認要的是「清空註冊表」而不是「重建」。
**驗收:** 換房間後,舊房間的訊息 id 不再出現在 `registeredIds()`。

### A5 — 新增 `visibilitychange` → `rebuild()`
接在既有的 hidden 監聽同一個 handler,不要新增第二個 listener。
**先讀 §A.4 那則 ⚠️** —— `rebuild()` 在 Phase A 會帶來一輪 churn(sweep 要到
Phase D 才存在)。可接受,但要知道它會出現在 A8 的 log 裡。**不要**為了消除它
去加抑制集合,理由見 `00-assessment.md` §7 對開放問題 2 的答覆。
**驗收:** 分頁切到背景 10 秒再切回,畫面上的未翻譯訊息會開始翻譯。純捲動
(不切分頁)時 `rebuild()` 的呼叫次數為 **0** —— 不是 0 就表示有別處在呼叫它,
查 `setRoot()`。

### A6 — 移植 `visibilityObserver.test.ts`
參考實作 §9.3,`.js` → `.ts`,import 路徑對齊。
**驗收:** 20 個測試全綠。

### A7 — 突變 M1–M4
見 `06-verification.md` §突變清單。
**驗收:** 4/4 全殺。任何一個存活代表對應的測試是假覆蓋,補測試而不是跳過。

### A8 ★ — 上線並量測
**驗收(三項都要記錄數字):**
1. 佇列峰值:預期從 80–150 掉到「可視訊息數量」的量級。
2. 捲到房間頂端再捲回來,先前捲過的訊息**會**被翻譯(B1 的直接驗證,
   這在 A 之前是必定失敗的)。
3. `result=idle` 的比例。

> 如果 A8 之後症狀就消失大半,根因確認在觀察器。若沒有明顯改善,**停下來
> 回報**,不要直接進 Phase B —— 那代表 `00-assessment.md` 的判斷有缺口。

---

## Phase B — 決策軌跡

### B1 — 新增 `decisionLog.ts`
貼上 `02-phase-B-decisionlog.md` §B.1。逐字採用。
**驗收:** typecheck 通過。

### B2 — 觀察器接上 `onEvent`
**驗收:** 捲動時 `decisionLog.records()` 會出現 `visible` / `hidden` / `dwell`。

### B3 — store 的 log 換裝 + 補三個丟棄點
三行 console.log → `emit`,並補上 `left-viewport` / `circuit-open` / `deduped`
三個目前完全靜默的路徑。
**驗收:** 讓一則訊息入隊後立刻捲走,`timeline(id)` 看得到 drop 記錄。

### B4 — `__translate` 開發者入口
只在非 production bundle。
**驗收:** console 執行 `__translate.timeline('<id>')` 有輸出。

### B5 — 移植 `decisionLog.test.ts`
參考實作 §9.6。
**驗收:** 15 個測試全綠,**含 `NEVER_PRINTED` 那條**。那條測試不可刪、不可
放寬 —— 它是「決策 log 不會印出訊息內文」的唯一保證。

---

## Phase C — store 邊界

### C1 — 快取 adapter
`03-phase-C-store.md` §C.1。注意 `srcVersion` / `identical` 兩個新欄位是
**非索引欄位**,Dexie 不需要 version bump。
**驗收:** 既有的 intent 記錄(使用者按過的「查看原文」)讀得到、行為不變。
舊的 content 記錄(無 `srcVersion`)被當成 miss,不會顯示過期譯文。

### C2 — `QueueItem` 新形狀
加入 `text` / `srcVersion` / `reqSeq` / `enqueuedAt` / `markSent` / `settle`。
**驗收:** typecheck 通過。

### C3 — `invalidate()` 加上佇列 purge
§C.3 的程式碼。
**驗收:** 對一則排隊中的訊息按「查看原文」,它**不會**在稍後被翻譯。

### C4 — `run()` 三處改動
快取寫入隔離、`maxAttempts` 依 origin 分流、刪掉 `probeInFlight = false`。
**驗收:** 快取寫入失敗時訊息仍顯示為已翻譯(見 C12 的測試)。

### C5 — `takeNext()` + pump 改寫
含刪除 `consecutiveAutoFailures` / `breakerOpenUntil` / `probeInFlight` 三個
變數與讀它們的分支,以及排序改用 `byDistanceFromCentre`。
**驗收:** 全域搜尋 `probeInFlight` / `breakerOpenUntil` 應為零結果。

### C6 — `hasQueueRoom` + `MAX_QUEUE_LENGTH = 0`
程式碼寫好,值先設 `0`(關閉)。
**驗收:** 常數存在且為 0。**這一步設成 50 會造成訊息永久擱淺**,sweep 要到
D4 才上線。

### C7 — `ensureForView`
§C.7 逐字採用。
**驗收:** typecheck 通過,並從 store export。

### C8 — `enqueue`(原 `translate`)+ dedupe 補 `onSent`
**驗收:** §C.3 表格八條路徑逐一確認 `markSent` 與 `settle` 都被呼叫恰好一次。
這一條建議直接對著表格逐列走程式碼,不要靠印象。

### C9 — `useEnsureTranslationForView` 改接 `ensureForView`
hook 對外簽名不變,內部不再自己讀 IDB、不再直接呼叫 `translate()`。
**驗收:** 全域搜尋確認 hook 內沒有 `translationCache` 的直接呼叫。

### C10 — 手動翻譯按鈕改接
**驗收:** 手動翻譯行為完全不變(含「查看原文」的往返)。

### C11 — 刪除 F7 / F8 兩道 guard
連同 `applySkipRules` 裡的 IDB 讀取與 `hydrateEntry` 分支。
**驗收:** `autoPolicy.ts` 的 `onCandidate` 不再有任何 `await`ted IDB 呼叫。

### C12 — 移植 `store.test.ts`
參考實作 §9.2,55 個測試。
**驗收:** 全綠。特別確認這兩組存在且通過:
- `a local fault is not a backend failure`(快取寫入失敗仍算成功)
- `every path out of translateMessage settles \`sent\``

### C13 ★ — 突變 M13 / M14 + 上線
**驗收:** 2/2 全殺;手動翻譯線上行為無回歸;`timeline(id)` 能解釋任一則的
決策路徑。

---

## Phase D — policy

### D1 — 整檔替換 `autoPolicy.ts`
`04-phase-D-policy.md` §D.1 逐字採用,只改標註 `ADAPTED` 的兩處欄位對應
(`isMe`、`message`)與 `sysMsgData` 的實際欄位名。
**驗收:** typecheck 通過。

### D2 — `createMessageIndex`
§D.2。同步、O(1)。
**驗收:** `getMessage` 沒有 `async`、沒有 `await`、沒有動態 `import()`。

### D3 — `getContext` + 五個 export 改寫
§D.3、§D.4。對外簽名不變。
**驗收:** `startAutoPolicy` / `stopAutoPolicy` / `setAutoPolicyRoom` /
`setAutoPolicyHidden` / `resetAutoPolicy` / `getAutoPolicyAutoEnabled` 的呼叫端
一行未改。

### D4 — sweep interval + 兩個 subscription
**驗收:** `recheckVisible` 每秒觸發;`stopAutoPolicy()` 之後它每秒只花一個
述詞就返回(不記 log、不呼叫 store)。

### D5 — `MAX_QUEUE_LENGTH = 50`
**與 D4 同一次上線。**
**驗收:** 快速捲動 100 則,佇列深度不超過 50;捲動停止後畫面上的訊息全部
被翻譯(sweep 修復了被上限擋掉的那些)。

### D6 — 刪除舊實作
`skipRules.ts`(除非 `hasUnicodeLetters` 另有使用者)、`applySkipRules`、
`hasAutoRequestsPerMinuteBudget`、`requestTimestamps`。
**驗收:** 全域搜尋 `requestTimestamps` 為零結果。

### D7 — 移植 `autoPolicy.test.ts`
參考實作 §9.4,43 個測試。
**驗收:** 全綠。特別確認 `probe token release` 與 `sweep log volume` 兩組
存在 —— 它們釘住的是最新修正的缺陷 14/16。

### D8 — 突變 M5–M12
**驗收:** 8/8 全殺。

### D9 — 整合測試 + 混沌測試
參考實作 §9.8(16 個)、§9.9(3 個種子)。
**驗收:** 全綠,混沌測試三連跑穩定。

### D10 ★ — 瀏覽器冒煙 + 上線
見 `06-verification.md` §完成清單。

---

## 全案完成條件

- [ ] A8 / C13 / D10 三個量測點的數字都有記錄
- [ ] 突變 14/14 全殺
- [ ] 混沌測試三種子全綠(三連跑)
- [ ] 捲動停下後,畫面上 12 則在約 5 秒內全部翻完
- [ ] 斷路器打開期間,決策 log 不會每秒增加十幾筆
- [ ] 佇列峰值 ≤ `MAX_QUEUE_LENGTH`
- [ ] `result=idle` 歸零
- [ ] 手動翻譯與「查看原文」行為與整合前完全一致
