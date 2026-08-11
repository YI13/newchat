# 自動翻譯關閉時暫停可見度追蹤

> 關閉自動翻譯時,可見度追蹤仍在運作,而它產生的候選全部被丟棄。要把這份工作停掉。
> 停掉本身只有幾行,但**在停之前有兩個問題必須先回答**,答錯其中一個會弄壞別的功能,
> 或是讓自動翻譯在重新打開後再也不會啟動。

**兩個先決問題,四處要改,約五十行。**

---

## 先量一下:實際省下的是什麼

先把預期擺正,免得做完覺得沒感覺。關閉狀態下真正在跑的只有三件事:

| 在跑的 | 頻率 | 成本 |
|---|---|---|
| IntersectionObserver 的 callback | 每次捲動,對每個被觀察的元素 | 瀏覽器原生,低但不是零 |
| dwell 計時器 | 每則訊息進入畫面一個 `setTimeout` | 低 |
| **每次可見度轉換寫一筆 skip 進決策 log** | 每則訊息每次進出畫面 | **這才是真正有感的** |

**CPU 上省下的不多。** 真正的收穫是決策 log 不再被沖淡 —— 那個環狀緩衝區是你診斷
「為什麼這則沒被翻譯」的唯一工具,捲一輪長房間就寫進幾十筆毫無資訊量的
`auto-disabled`,把真正需要看的歷史擠出去。

如果你們是為了 CPU 才做這件事,先用 Performance 面板量一次再決定值不值得。
如果是為了 log 品質,那很值得。

**順帶確認一件事:你們的定期重掃(參考實作叫 `recheckVisible`,每秒一次)有沒有
在第一行就檢查開關?**

```ts
const ctx = getContext()
if (!ctx.autoTranslate || !ctx.active) return    // ← 必須在 per-message 迴圈之前
```

如果沒有,那才是關閉狀態下最大的浪費 —— 每秒對每則可見訊息寫一筆 skip。**先修這個**,
它比本文其他所有內容加起來更有效,而且只有一行。

---

## 先決問題 1:還有誰在讀這個 tracker?

**這是最重要的一題,答錯會弄壞別的功能。**

可見度追蹤在聊天介面裡通常不只服務一個功能。已讀回條、未讀分隔線、「捲到最新」的
判斷、訊息曝光統計 —— 這些都可能讀同一份 `visibleIds`。

暫停 tracker 會讓 `visibleIds` **永久為空**。任何依賴它的功能都會一起停掉,而且是
靜默的。

動手前先查:

```bash
grep -rn "visibleIds\|visibilityTracker\|isVisible" src/ | grep -v translat | grep -v node_modules
```

### 有其他消費者 → 走路線 B

**不要暫停共用的 tracker。** 改成只切斷翻譯這一側 —— 不掛 dwell 計時器、不發候選。
IntersectionObserver 繼續跑(已讀回條需要它),但省掉的正好是成本最高的那兩項
(dwell 計時器 + log 寫入)。見下面「路線 B」。

### 只有翻譯在用 → 走路線 A

整個 tracker 暫停,連 IntersectionObserver 都不建。見下面「路線 A」。

---

## 先決問題 2:policy 的第一道閘是不是 `auto-disabled`?

打開你們的 policy,看 `onCandidate` 的閘門順序:

```ts
const ctx = getContext()
if (!ctx.autoTranslate) return skip(SKIP.AutoDisabled)   // ← 這一行在最前面嗎?
if (!ctx.active) return skip(SKIP.Inactive)
// ... 規則、斷路器、限流、probe token
```

**如果它在最前面**(參考實作就是),那關閉狀態下沒有任何 store 呼叫、沒有網路、
沒有預算被消耗 —— 本文要省的只有上面那張表的三項。

**如果它不在最前面**,例如排在斷路器或限流之後,那關閉狀態下你還在消耗那些全域
狀態。先把它移到最前面,那是獨立的一行修正,和暫停與否無關。

---

## 陷阱:暫停不是銷毀

在寫任何程式碼之前先把這條記住,它是本文存在的主要理由。

**註冊表歸掛載中的訊息元件所有。** 它們從自己的 ref 呼叫 `observe`/`unobserve`。
而**切換設定不會讓任何一列重新掛載** —— React 只會重繪讀了那個設定的元件,訊息列
的 ref 不會重跑。

所以:

```ts
// ⛔ 錯的:恢復後 tracker 活著,但註冊表是空的
function setEnabled(next) {
  if (next) { /* ... */ } else { tracker.destroy() }   // destroy 清掉 elements
}
```

打開開關 → tracker 重建 → 註冊表空的 → 一個候選都不會產生 → **自動翻譯要等到
使用者換房間或重新整理才恢復**。沒有錯誤,沒有失敗計數,log 一片安靜。

這和「在房間切換時呼叫 `destroy()`」是同一個失效形狀。如果你們踩過那個,這就是它
的第二次。

**正解:暫停只切斷「觀看」,絕不碰註冊表。** 恢復時對現有註冊表重新 observe 一輪。

---

## 路線 A — tracker 是翻譯專屬的

### F1 — 加上 `setEnabled`

**檔案:** 可見度追蹤模組

先加一個模組層級的旗標,初始值來自設定 —— 這樣一個「開著頁面時開關本來就是關的」
的 session,從頭到尾不會建立任何 IntersectionObserver:

```ts
// 暫停的是「觀看」,永遠不是註冊表。elements 由掛載中的訊息元件透過各自的 ref
// 寫入,這裡不得代替它們清空 —— 恢復必須重新觀察「現在掛載的那些」,而切換設定
// 不會讓它們任何一個重新掛載。
let enabled = config.enabled !== false
```

註冊改成「一律記錄,視情況觀看」:

```ts
/** 註冊是無條件的,觀看不是。暫停期間元素被記錄但不觀察,所以之後恢復時看到的是
 *  真正掛載中的那一組,而不是只有恢復之後才掛載的。 */
function watch(element: Element) {
  if (enabled) ensureObserver().observe(element)
}

function observe(id: string, element: Element | null) {
  if (!element) return
  if (elements.get(id) === element) {
    watch(element)                    // ← 原本是 ensureObserver().observe(element)
    return
  }
  if (elements.has(id)) unobserve(id)

  elements.set(id, element)
  elementIds.set(element, id)
  watch(element)                      // ← 同上
}
```

你們應該已經有一個「重建」函式(切換捲動容器、分頁回到前景時用的)。讓它認得旗標:

```ts
function rebuild() {
  for (const id of [...dwellTimers.keys()]) cancelDwell(id)
  visibleIds.clear()
  centres.clear()

  observer?.disconnect()
  observer = null

  if (!enabled || elements.size === 0) return    // ← 加上 !enabled
  const next = ensureObserver()
  for (const element of elements.values()) next.observe(element)
}
```

`setEnabled` 就變成一行轉發:

```ts
/** 暫停或恢復觀看。暫停會丟掉所有觀察、待決 dwell 與可見標記;恢復則對註冊表重建,
 *  這正是它能安全地由一個「什麼都不重繪」的設定切換來驅動的原因。
 *  刻意不是 destroy():destroy 會清掉註冊表,之後恢復會回來觀察一個空集合。 */
function setEnabled(next: boolean) {
  if (enabled === next) return
  enabled = next
  rebuild()
  log.emit(DECISION.Tracker, null, {
    state: enabled ? 'resumed' : 'suspended',
    registered: elements.size,
  })
}
```

匯出 `setEnabled` 和一個 `isEnabled()`(診斷要用,見 F3)。

**如果你們沒有 `rebuild()` 這個函式**,`setEnabled` 要自己做完整套:取消所有 dwell、
清空 `visibleIds` 與位置快取、`disconnect()`、把 observer 設成 null;恢復時再對
`elements` 的每個元素 observe 一輪。**唯一不能碰的是 `elements` 本身。**

### F2 — 接到設定上

在持有翻譯設定的地方(你們是 zustand,所以是一個 selector + effect):

```ts
useEffect(() => {
  tracker.setEnabled(autoTranslate)
}, [tracker, autoTranslate])
```

建立 tracker 時也把初始值傳進去,避免「掛載瞬間觀察了一輪、下一個 tick 又關掉」:

```ts
createVisibilityTracker({
  dwellMs: ...,
  enabled: autoTranslate,      // ← 初始狀態
  ...
})
```

---

## 路線 B — tracker 是共用的

已讀回條之類的功能需要 `visibleIds` 繼續正確,所以 IntersectionObserver 必須留著。
切斷的是翻譯那一側:**不掛 dwell 計時器、不發候選**。

在 tracker 裡把旗標的作用範圍縮小到 dwell:

```ts
function markVisible(id: string) {
  if (visibleIds.has(id)) return
  visibleIds.add(id)                       // ← 照常,已讀回條需要
  log.emit(DECISION.Visible, id, { visible: visibleIds.size })

  // 候選只服務自動翻譯。開關關閉時連計時器都不掛 —— 掛了也只是為了在 400ms 後
  // 產生一個必定被丟棄的候選,外加一筆沒有資訊量的 log。
  if (!candidatesEnabled) return

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
```

`setCandidatesEnabled(next)` 在關閉時只需取消所有待決 dwell,**不要動 observer、
不要清 `visibleIds`**:

```ts
function setCandidatesEnabled(next: boolean) {
  if (candidatesEnabled === next) return
  candidatesEnabled = next
  if (!candidatesEnabled) {
    for (const id of [...dwellTimers.keys()]) cancelDwell(id)
  }
  log.emit(DECISION.Tracker, null, { state: next ? 'resumed' : 'suspended' })
}
```

恢復時**不需要**做任何重新觀察 —— observer 從來沒斷過,`visibleIds` 一直是對的。
下一次可見度轉換自然會掛上 dwell。

> 但這帶來一個路線 A 沒有的問題:恢復當下已經在畫面上、而且不會再移動的訊息,
> 不會產生新的可見度轉換,所以不會有候選。**這正是定期重掃(`recheckVisible`)
> 存在的理由** —— 確認你們有它,而且它會重新提出目前可見的訊息。沒有的話,打開
> 開關後要捲動一下才會開始翻譯。

接線與 F2 相同,只是換成 `setCandidatesEnabled`。

---

## F3 — 兩個讓它可診斷的標記(兩條路線都要)

暫停會讓所有候選同時消失。沒有標記的話,log 就只是「安靜下來」,而那和**註冊表
瞎掉**長得一模一樣 —— 你之後會為了分辨這兩者浪費一個下午。

1. **記錄狀態轉換。** 新增一個決策類型(參考實作叫 `tracker`,不帶 message id):

   ```ts
   Tracker: 'tracker',   // 非訊息層級,messageId 為 null
   ```

2. **快照要報告狀態。** `visibleIds` 空的、`registeredIds` 滿的,可能是「暫停中」
   也可能是「壞了」,這兩者不該長得一樣:

   ```ts
   const snapshot = () => ({
     ...store.inspect(),
     trackerEnabled: tracker.isEnabled(),
     visibleIds: [...tracker.visibleIds],
     registeredIds: tracker.registeredIds(),
   })
   ```

---

## 要補的測試

**第四條是這件事唯一真正會壞的地方。** 前三條在修正前是紅的,第四條如果你實作成
`destroy()` 也會是紅的 —— 那正是它存在的意義。

```ts
describe('setEnabled', () => {
  test('停止觀看但不忘記掛載了什麼', () => {
    const { tracker } = make()
    tracker.observe('m1', el('m1'))
    tracker.observe('m2', el('m2'))
    const io = latest()

    tracker.setEnabled(false)

    expect(io.disconnected).toBe(true)
    expect(tracker.registeredIds()).toEqual(['m1', 'm2'])   // ← 註冊表完好
  })

  test('暫停期間完全不建立 observer', () => {
    const { tracker } = make()
    tracker.setEnabled(false)

    tracker.observe('m1', el('m1'))

    // 從側門把 observer 復活就失去意義了。
    expect(instances).toHaveLength(0)
    expect(tracker.registeredIds()).toEqual(['m1'])
  })

  test('丟掉已經在倒數的 dwell', () => {
    const { tracker, onCandidate } = make()
    const e = el('m1')
    tracker.observe('m1', e)
    show(e)
    vi.advanceTimersByTime(200)          // dwell 400,走到一半

    tracker.setEnabled(false)
    vi.advanceTimersByTime(10_000)

    expect(onCandidate).not.toHaveBeenCalled()
    expect([...tracker.visibleIds]).toEqual([])
  })

  test('恢復時接上仍然掛載的列,不需要重新掛載', () => {
    // 這條就是重點。打開開關不會重繪任何一列,所以恢復若沒有對既有註冊表重新
    // observe,tracker 會回來觀察一個空集合,自動翻譯持續是死的。
    const { tracker, onCandidate } = make()
    const e = el('m1')
    tracker.observe('m1', e)
    tracker.setEnabled(false)

    tracker.setEnabled(true)
    expect(latest().observed.has(e)).toBe(true)    // ← 直接斷言重新觀察了

    show(e)
    vi.advanceTimersByTime(500)
    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('暫停期間掛載的列,恢復時會被接上', () => {
    const { tracker, onCandidate } = make()
    tracker.setEnabled(false)
    const e = el('m1')
    tracker.observe('m1', e)             // 關閉期間捲進來的訊息

    tracker.setEnabled(true)
    show(e)
    vi.advanceTimersByTime(500)

    expect(onCandidate).toHaveBeenCalledWith('m1')
  })

  test('暫停期間卸載的列,恢復時不會被復活', () => {
    const { tracker } = make()
    tracker.observe('m1', el('m1'))
    tracker.setEnabled(false)
    tracker.unobserve('m1')              // 使用者捲走了

    tracker.setEnabled(true)

    expect(tracker.registeredIds()).toEqual([])
  })

  test('重複設定同一個狀態不做任何事', () => {
    const { tracker } = make()
    tracker.observe('m1', el('m1'))
    const io = latest()

    tracker.setEnabled(true)             // 已經是 true

    expect(latest()).toBe(io)            // 沒有重建
  })
})
```

再加一條穿過接線層的:

```ts
test('開關打開時接上已經在畫面上的列', async () => {
  setAutoTranslate(false)
  renderChatWithRows(['m1'])

  clickAutoTranslateToggle()

  // 瀏覽器會為新觀察的元素送出一筆初始 entry;假的 observer 要自己補。
  show('m1')
  await settle()

  expect(translate).toHaveBeenCalledTimes(1)
})
```

最後那句註解是真的:**瀏覽器在 `observe()` 之後會主動送一次 entry**,所以真實環境
中恢復不需要使用者捲動。測試裡的假 observer 不會,要手動觸發。

---

## 驗收

| # | 步驟 | 期望 |
|---|---|---|
| 1 | 開關**關閉**的狀態下重新整理,捲動一輪長房間 | 決策 log 裡沒有任何 `auto-disabled`(路線 A 連 `visible`/`hidden` 都沒有) |
| 2 | 同上,檢查有沒有建立 IntersectionObserver | 路線 A:一個都沒有。路線 B:有,而且已讀回條照常運作 |
| 3 | **關閉狀態下停在畫面不動,然後打開開關** | 畫面上的訊息**立刻**開始翻譯,不需要捲動或換房間 |
| 4 | 打開狀態下停在畫面不動,然後關閉開關 | 翻譯停止;已在途中的請求照常完成(不必中止) |
| 5 | 關閉 → 捲動幾則新訊息進畫面 → 打開 | 那幾則也會被翻譯(它們是暫停期間註冊的) |
| 6 | 關閉狀態下手動按某則的「翻譯」 | 照常運作 —— 手動路徑不經過 tracker |
| 7 | 路線 B 專屬:關閉狀態下捲動 | 已讀回條 / 未讀分隔線行為完全不變 |

**第 3 項是唯一真正會失敗的那一項。** 如果它需要捲動一下才開始,你的恢復沒有對
既有註冊表重新 observe —— 回頭看「陷阱」那一節。

---

## 完成清單

- [ ] `grep` 過還有誰在讀 tracker,已選定路線 A 或 B
- [ ] 定期重掃在第一行就檢查開關(這一行本身可能就解決了大半浪費)
- [ ] policy 的 `auto-disabled` 是第一道閘
- [ ] 暫停**沒有**清空註冊表 —— 沒有用 `destroy()`
- [ ] 暫停期間 `observe()` 記錄元素但不觀察
- [ ] 恢復對既有註冊表重新 observe(路線 A)/ 定期重掃能重新提出可見訊息(路線 B)
- [ ] 狀態轉換有寫進決策 log
- [ ] 快照有回報 tracker 狀態
- [ ] 七條單元測試齊全,第四條在改成 `destroy()` 的實作下必須是紅的
- [ ] 驗收七項通過,**特別是第 3 項**

---

## 一件順帶發現、和本文無關的事

查這件事時撞到另一個問題,先講一聲,要不要處理是產品決定:

`ensureForView` 的合約寫著「intent 'manual' → 不受全域開關影響」,store 層也確實
照做(有綠的測試)。但**唯一的呼叫者 policy 在那之前就 return 了** —— `auto-disabled`
是第一道閘,而且它呼叫 `ensureForView` 時硬傳 `autoTranslate: true`。

實際後果:**關閉自動翻譯 → 手動翻譯一則 → 重新整理 → 回到原文**,即使 intent 和
譯文都好好躺在 IndexedDB 裡。同一段路徑在開關**打開**時是正常的(policy 會往下走、
命中內容快取)。

本文的暫停改動不會讓它更糟(那條路徑本來就到不了),但你們如果決定要保留手動翻譯
跨重新整理的結果,那是另一項工作,而且**必須在暫停之上額外設計** —— 因為 tracker
暫停後連候選都沒有,不能指望它去觸發還原。
