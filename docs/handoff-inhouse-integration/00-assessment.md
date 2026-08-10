# 00 — 現況評估與症狀對應

開工前讀一次。這份回答的是「為什麼是這個順序」,不含程式碼。

---

## 1. 回報的四個症狀

1. 佇列長到 80–150 筆。
2. 同一批 messageId 反覆出現在 `queued` log(重複入隊)。
3. 大量工作以 `result=idle` 結束(G1 因 `reqSeq` 被 bump 而丟棄結果)。
4. 佇列排空之後,可視訊息仍未全數翻譯。

現有分析把重心放在 `onCandidate` 的併發競態(F7/F8 兩道同步 guard)。那條路徑
確實有競態,但它**不是**這四個症狀的根因。

---

## 2. 三個決定性缺陷(與時序無關)

全部在 `visibilityTracker.ts`。它們不是 race —— 是每次都會發生的邏輯錯誤。

### B1. `onLeave` 解除元素映射,卻沒有停止觀察它

```ts
function onLeave(id) {
  visibleIds.delete(id);
  const el = elements.get(id);
  ...
  elements.delete(id);
  if (el) elementToId.delete(el);   // ← 解除映射
}
```

而 IO callback 的第一件事是:

```ts
const target = lookupId(entry.target);   // elementToId.get(el)
if (!target) continue;                   // ← 從此永遠 continue
```

元素仍在 `observer.observe()` 名單上,但 id 映射沒了。**該訊息之後再捲回畫面,
IO callback 查不到 id 而直接 `continue` —— 永遠不會再成為候選。**

唯一復原途徑:React 重新 render 讓 ref callback 再呼叫一次 `observe()`。

> **→ 症狀 4 的直接成因。** 與佇列、與 `reqSeq` 都無關。

### B2. `reset()` 拆掉觀察器但不重建

```ts
reset() { ...; elements.clear(); elementToId.clear(); observer.disconnect(); }
```

`disconnect()` 之後沒有任何 re-observe。而 `startAutoPolicy()` 的第一件事就是
呼叫 `reset()`:

> 使用者打開自動翻譯 → 觀察器對「當下已經掛載的所有訊息」全部失明 →
> 只有之後才掛載的訊息才進得了流程。

同樣只能靠 re-render 復原。

> **→ 症狀 4 的第二個成因。**

### B3. `observe()` 無條件呼叫 `onEnter`,不問元素在不在畫面上

`onEnter` 直接 `visibleIds.add(id)` 並起 400ms dwell。任何**剛掛載但在畫面外**
的訊息,在那一瞬間都被記成「可見」並開始倒數。

正常情況下 IO 的 initial callback(`isIntersecting: false`)會在幾毫秒內把它
`onLeave` 掉,dwell 來不及燒完。**但在負載下 IO callback 會批次延遲**:捲動
歷史一次掛 100 則、主執行緒忙,callback 晚於 400ms 送達 →

1. dwell 先燒完 → `fireCandidate`
2. → `onCandidate`,狀態確實是 idle,通過所有 guard
3. → `translate()` 入隊
4. → pump 的 G5 檢查 `visibilityObserver.visibleIds.has()`
5. → **`visibleIds` 正是被 `onEnter` 汙染的那個集合,回 true** → 送出

> **→ 症狀 1 的成因,而且是負載相依的**,所以日誌會呈現「第一批 12 則乾淨、
> 之後的波次漲到 80+」這種形狀。

### 共同根因

`elements` 同時被當成**註冊表**和**可見集合**用,系統裡缺少「已註冊但不可見」
這個狀態。三個缺陷都是這一件事的不同表現。

參考實作的觀察器把它拆成三份,並在檔頭把理由寫死:

> `visibleIds` — ONLY the IntersectionObserver callback writes to it.
> Registering an element must never put it here, or the dwell filter is
> bypassed for every rendered message and **the module merely looks like it works**.

### B4(附帶)pump 的 probe token 兩頭壞

```ts
if (consecutiveAutoFailures >= BREAKER_THRESHOLD) {
  if (probeInFlight) { setState(...idle); continue; }
  probeInFlight = true;          // ← 佔用
}
if (!visibilityObserver.visibleIds.has(job.messageId)) { ...; continue; }   // ← 洩漏
if (countAutoInFlight() >= MAX_CONCURRENT_AUTO) { queue.unshift(job); break; } // ← 洩漏
...
finally { ...; probeInFlight = false; }   // ← 任何 job 完成都清掉,包含 manual
```

佔用之後有兩條路徑不 `run()` 就離開(斷路器永久卡死),而 `finally` 又對非 probe
的 job 誤清(恢復瞬間全體踩踏)。Phase C 會整個刪掉這段。

---

## 3. 第二個獨立成因:RPM 在 enqueue 計費

```ts
requestTimestamps.push(Date.now());
MessageTranslationStore.getState().translate(messageId, ..., { origin: 'auto' });
```

計費發生在入隊時,但 pump 之後可能因 G5 或斷路器把這個 job 丟掉。日誌顯示佇列
會漲到 80–150,而 `MAX_REQUESTS_PER_MINUTE = 60` ——

> **一次大捲動就把整分鐘的額度花在從未送出的請求上**,之後整整一分鐘所有候選
> 被靜默 rate-limit。

參考實作對這件事有量測數字:一次 100 則捲動,**60 個被接受、14 個真的送出、
接下來 36 個被 rate-limit**。

> **→ 症狀 4 的第三個成因**,與 B1/B2 疊加。

---

## 4. 症狀 → 缺陷對照

| 症狀 | 主要成因 | 次要 |
|---|---|---|
| 1. 佇列 80–150 | B3(畫面外訊息被記成可見) | 第二條入隊路徑 |
| 2. 重複入隊 | B1/B2 的 re-render 復原機制 | `observe()` 重設 dwell |
| 3. `result=idle` | 症狀 2 的下游結果 | — |
| 4. 排空後仍未全翻 | B1、B2、RPM 在 enqueue 計費 | 佇列上限無修復路徑 |

F1–F8 那八輪修正全部作用在 `onCandidate` 與 pump,**沒有一個碰到 B1/B2/B3**。
這解釋了為什麼每次修完都「減少但沒有消除」。

---

## 5. 介面落差:參考實作需要什麼,現況給不出什麼

| 參考實作 autoPolicy 依賴 | 現況 | 落差 |
|---|---|---|
| `store.ensureForView(id, {...}) → {outcome, sent, done}` | `translate(...) → void` | 🔴 **最大**。RPM 計費、斷路器判定、probe 歸還全靠 `sent`/`done` |
| `getMessage(id)` **同步** | `await import('../messages/store')` 後全室掃描 | 🔴 非同步 + 每候選 O(全室訊息+全 thread) |
| 快取讀取在 **store 內** | 快取讀取在 **policy 內**(`applySkipRules` 兩次 IDB) | 🔴 F7/F8 要補的 race 就從這來 |
| 斷路器在 **policy** | 斷路器在 **pump** | 🔴 直接照搬會有兩個斷路器 |
| 唯一入口 `ensureForView` | 三個入口:policy / `useEnsureTranslationForView` / 手動鍵 | 🔴 重複入隊的結構性來源 |
| RPM 計在**真正送出**時 | 計在 **enqueue** 時 | 🟡 見上節 |
| `getVisibleIds()` + `recheckVisible` sweep | 無 sweep | 🟡 沒有修復路徑 |
| `byDistanceFromCentre(ids)`(無號) | `distanceToCenter(id)`(有號) | 🟡 排序語意不同 |
| 工廠 + 注入 | 模組單例 | 🟢 可用薄包裝吸收 |
| `unobserve(id)` | `unobserve(id, el?)` | 🟢 相容 |
| `visibleIds` live Set | 同 | 🟢 pump 的 G5 不用改 |

**關鍵觀察:** F7/F8 兩道 guard 補的 race 之所以存在,是因為 policy 在呼叫 store
**之前**做了非同步 IDB 工作。參考實作把快取讀取移進 `ensureForView`,那個視窗
根本不存在。所以 Phase C 之後 F7/F8 是**不需要**,而不是「補得更好」。

---

## 6. 為什麼順序是 A → B → C → D

- **A 先**,因為它耦合最低(兩個檔案,介面幾乎相同)且回報最高(三個決定性
  缺陷一次修掉)。做完就能量測,而且能回答「根因是不是在觀察器」。
- **B 次之**,因為 C/D 之後絕大多數決策都是 skip,現在的三行 `console.log`
  (queued / start / done)看不出「為什麼**沒**送」。沒有它,C/D 無法驗證。
- **C 必須在 D 之前**,因為 D 的 policy 依賴 `sent`/`done` 才能正確計費與
  判定斷路器。合約不先建立,D 只能寫成猜測。
- **D 不可拆**,理由見 `README.md`「不要做的事」第 1、2 點。

---

## 7. 現有開放問題的答覆

**Q1 `observe()` 重設 dwell** — 對,但用 `dwellTimers.has(id)` 當守衛是錯的
方向。正解是讓 `observe` 對**同一個元素**冪等(`elements.get(id) === element`)。
用 timer 當守衛的話,元素真的被替換時反而不會重新註冊。

**Q2 `firedIds` 一次性集合** — **不要做。** 這個方向會把現在的間歇失敗變成
永久失敗。需要被修復的情境恰恰是「job 被丟掉了、訊息還在畫面上、而且它不動
所以不會再有 intersection entry」;一個抑制集合只會讓這種訊息**永遠**停在原文。
正確答案是相反的機制:週期性重新提供(`recheckVisible`,只收 `idle`)。
參考實作刻意用輪詢而不是「容量釋放」事件驅動 —— 要修的故障就是「沒有事件會來」,
一個自己也在等事件的修復路徑會繼承同樣的盲點。

**Q3 佇列深度上限** — 要,`maxQueueLength: 50`,但綁定 Q2 的 sweep。

**Q4 每候選兩次 IDB 讀** — 移進 `ensureForView` 之後,同步的 `getEntry` 快檢
會先擋掉絕大多數。不過更貴的其實不是 IDB,是 `applySkipRules` 裡那次
`[...room.messages, ...threads.flatMap()]` 再 `find()` —— 80 個候選就是 80 次
全室掃描,而且在 await 邊界後面。這個要換成查表,見 `04-phase-D-policy.md`。

**Q5 `result=idle` 完成** — 是重複入隊的**症狀**,不是獨立問題。B1/B2 修掉、
第二條入隊路徑合併掉之後應該歸零。若 Phase A + C 之後仍可見,才需要另查。
