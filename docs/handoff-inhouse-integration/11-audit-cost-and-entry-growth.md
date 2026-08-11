# 週期性稽核的成本,與 entry map 的無界成長

> 兩個發現,一個是 CPU 一個是記憶體,但它們是同一件事的兩面:一張**整個 session 只增
> 不減**的表,被一個**每兩秒跑一次、永遠不停**的診斷完整走訪。
>
> 兩者都不會讓任何功能出錯,所以不會有人回報。它們只是一直在花錢。

**兩個發現,三處要改,約七十行。**

---

## 開工前:五個問題,請先回報

**這份文件裡的量級是從程式碼推導的,不是量出來的。** 推導本身是嚴謹的(下面「它實際
需要的資訊有多少」那一節會把證明攤開),但「這值不值得花工」取決於你們的真實數字,
而那個我沒有 —— 文中出現的任何「幾千筆」都是示意,不是任何人的實測。

所以請先花二十分鐘取得下面五項並回報。**其中第 1 和第 4 項的答案可能讓我直接撤掉或
重寫 F3**,那應該發生在你們動工之前,而不是之後。

| # | 問題 | 怎麼取得 | 答案會改變什麼 |
|---|---|---|---|
| 1 | 真實 session 後的 entry 數量與保留大小 | 正常用 30–60 分鐘,見下 | **少 → F3 整段撤掉** |
| 2 | 閒置時稽核的單次成本 | Performance 錄 30 秒 | 便宜 → 發現 1 是雜訊,我講得太重 |
| 3 | entry 裡存不存譯文 | 一行 grep | 不存 → 發現 2 只剩物件數量,很便宜 |
| 4 | 訊息列表有沒有虛擬化 | 看程式碼 | **沒有 → F3 的淘汰條件要換掉** |
| 5 | 你們有沒有週期性稽核 | 一行 grep | 沒有 → 發現 1 完全不適用 |

### 1. entry 數量與保留大小

正常使用 30–60 分鐘、逛過幾個房間之後:

```js
// 換成你們 store 的實際取用方式
const s = window.__translate?.store?.inspect?.() ?? useTranslationStore.getState()
console.log('entries:', s.entries?.length ?? Object.keys(s.entries ?? {}).length)
```

再換三個房間、捲一捲、回來敲第二次 —— **確認它只會往上、從不下降。**

然後 DevTools → Memory → 拍一張 heap snapshot,搜 entry 物件看 retained size。

**回報:** 兩次的筆數,以及 retained size。
**如果一小時後只有幾百筆、retained 只有幾 MB**,發現 2 不值得付出淘汰的複雜度和它帶來
的行為取捨 —— 我會建議只做發現 1,把 F3 整段撤掉。

### 2. 閒置時稽核的單次成本

不捲動、不打字,DevTools → Performance 錄 30 秒。

**回報:** 那個週期性 tick 每次花多少 ms,以及長 session 之後會不會變大。
**如果每次只有 0.3ms**,發現 1 就是雜訊,我把它講得太重了 —— 那就只做 F2 那道 O(1) 的
閘(它幾乎免費),F1 的索引可以不做。

### 3. entry 裡存不存譯文

```bash
grep -n "translatedText" <你們的 store>
```

**回報:** 譯文是存在 entry 裡,還是存在別處(zustand 的另一個 slice、或直接讀快取)。
**如果不在 entry 裡**,那留下來的只是一堆小物件,不是「整個 session 的譯文全文」——
發現 2 便宜得多,`maxEntries` 設大一點就結案,不需要 `isRetained` 那套。

### 4. 訊息列表有沒有虛擬化

**這一項會改變 F3 的設計本身,不只是嚴重度。**

F3 的淘汰條件是「終態 **且** 未掛載」。如果你們沒有虛擬化、一個房間的訊息全部渲染,
那「已掛載」會對幾百筆同時成立,**淘汰根本擠不到上限以下** —— 那段程式碼會安靜地
幾乎不生效,而且因為它刻意不保證降到上限以下(見 F3 的註解),不會有任何人發現。

**回報:** 有沒有 windowing(react-window / react-virtuoso / 自製),以及一個房間典型
同時掛載幾列。
**如果沒有虛擬化**,F3 要改成以房間為界的修剪,而不是以掛載為界 —— 那是不同的設計,
連帶的行為取捨也不一樣。**先問我,不要照現在的 F3 硬做。**

### 5. 你們有沒有週期性稽核

參考實作有一個週期性的不變量稽核 —— 每 2 秒把佇列狀態抓一份快照,檢查它是否違反自己
的保證(槽位漏掉、佇列不排空、可見但未註冊…)。

```bash
grep -rn "setInterval" src/ | grep -iE "invariant|audit|check|snapshot"
```

**如果你們沒有移植這一項,發現 1 直接跳過**,只看發現 2。

### 順帶一個不是數字的問題

**你們的使用者實際上會把分頁開多久?** 這兩個發現的前提都是「整個 session 只增不減」。
如果使用者每二十分鐘就重新整理一次,兩項都接近無關緊要;如果是那種開著一整天的內部
工具,那才是真問題。

---
---

# 發現 1 — 稽核每兩秒走過整個 session

## 為什麼它看不出來

這個稽核是為了抓「自動翻譯靜默停止」而寫的,那個目的完全正確 —— 這類故障不會拋錯,
唯一的症狀就是訊息安靜地不再被翻譯,所以直接檢查性質是對的做法。

問題在**它為此付出的代價與它需要的資訊完全不成比例**:

```
每 2 秒:
  inspect()          → [...entries.entries()].map(...)      配置 N 個物件
  checkInvariants()  → new Map(entries.map(...))            再配置 N 個
                     → for (const entry of entries)         迭代 N 次
```

`N` 是這次 session 在**所有房間**碰過的訊息總數(見發現 2)。而且這個 interval:

- 自動翻譯**關著**也跑
- 佇列**空著**也跑
- 分頁在**背景**也跑(瀏覽器只節流到 ≥1s,不會停)

一個逛過 20 個房間、每房 200 則的 session,就是每 2 秒配置約 8000 個物件、走訪 4000 次,
持續整場,只為了一個絕大多數時候什麼都找不到的檢查。

## 它實際需要的資訊有多少

把稽核裡每一處用到 `entries` 的地方列出來,只有兩個:

| 用途 | 需要哪些 entry |
|---|---|
| 「顯示為 queued 但沒有對應的 job」 | 只有 `status === 'queued'` 的 |
| 「job 在佇列裡但 entry 不是 queued」 | 只有 **messageId 在佇列裡**的 |

**兩者都被佇列長度界定,不是被 session 歷史界定。** 已經 `translated`、`failed`、`idle`
的 entry 對這個稽核**永遠不可能**產生違規 —— 它們被搬進來、複製一遍、比對一遍,然後
每一次都被丟掉。

其餘的檢查(槽位計數、in-flight 停滯、佇列不排空、可見但未註冊)看的是計數器、佇列、
in-flight 清單和觀察器集合,完全不碰 entry map。

所以下面的修正**沒有行為變化**:被移除的工作在定義上不會產生任何違規。

## 修正

### F1 — 維護一個 queued 索引,不要走全表

**檔案:** store

在寫入 entry 的那一處同步維護一個集合。O(1),而且它是唯一需要的索引:

```ts
const queuedIds = new Set<string>()

function setEntry(messageId: string, next: Entry) {
  const previous = entries.get(messageId)
  const since = previous && previous.status === next.status ? previous.since : now()
  entries.set(messageId, { ...next, since })

  // 稽核唯一需要從 entry map 拿的東西。在寫入點維護,而不是在稽核時掃出來 ——
  // 掃一次就是走全表,那正是要消除的。
  if (next.status === 'queued') queuedIds.add(messageId)
  else queuedIds.delete(messageId)

  emit()
}
```

記得在刪除 entry 的地方也清:`entries.delete(id)` 旁邊補 `queuedIds.delete(id)`,
`entries.clear()` 旁邊補 `queuedIds.clear()`。

`inspect()` 改成只投影稽核用得到的兩組:

```ts
inspect: () => {
  // 精確投影:status === 'queued' 的,加上 messageId 在佇列裡的。其餘 entry
  // 在定義上不可能產生違規(見上表),搬過來只是為了立刻丟掉。
  const needed = new Set(queuedIds)
  for (const item of queue) needed.add(item.messageId)

  return {
    config: cfg,
    activeCount,
    activeAutoCount,
    queue: queue.map(({ messageId, origin, enqueuedAt }) => ({ messageId, origin, enqueuedAt })),
    inflight: [...running].map((job) => ({
      messageId: job.messageId,
      origin: job.origin,
      sentAt: job.sentAt,
    })),
    entries: [...needed].map((id) => {
      const entry = entries.get(id)
      return { messageId: id, status: entry?.status ?? 'idle', since: entry?.since }
    }),
  }
},
```

現在 `entries` 的大小是 O(佇列長度),不是 O(session 歷史)。

> **注意一個細節:** 投影之後,「job 在佇列裡但 entry 不是 queued」這條違規的**詳情
> 文字**在 entry 不存在時會說 `idle`,而真實狀態可能是 `loading`。違規本身照樣正確
> 觸發 —— 觸發條件是「不是 queued」。上面的寫法保留了真實狀態,所以連文字也不變;
> 如果你們簡化成只投影 `queuedIds`,要接受詳情會少一點資訊。

### F2 — 閒置時整個跳過

即使投影之後,稽核仍然每 2 秒配置幾個陣列。而**絕大多數的 2 秒裡佇列是空的**,
那時它連一個可能的違規都沒有。

在稽核的第一行加一道 O(1) 的閘:

```ts
const timer = setInterval(() => {
  // 沒有排隊、沒有在途、沒有 entry 停在 queued —— 就沒有任何一條違規可能成立。
  // 三個都是 O(1) 讀取,不需要建立快照就能回答。
  if (store.isQuiet()) return

  const violations = checkInvariants(snapshot())
  // ...
}, INVARIANT_INTERVAL_MS)
```

store 這邊:

```ts
/** 稽核用的快速前置判斷。刻意不用 stats():那個是給顯示看的三個數字,
 *  這個是「值不值得建立快照」,兩者不該互相牽制。 */
isQuiet: () => queue.length === 0 && running.size === 0 && queuedIds.size === 0,
```

`running` 是持有槽位的 job 集合(不是 inflight map —— supersede 期間同一則訊息可能有
兩個請求同時在途,槽位帳本才是稽核比對的對象)。

這兩步之後,閒置時的成本是**每 2 秒三次整數比較**。

---
---

# 發現 2 — entry map 只增不減

## 現況

entry map 只在兩個地方被清理:

```
onMessagesDeleted → entries.delete(id)
onLogout          → entries.clear()
```

**換房間不清。捲走不清。** 換房間只清 IndexedDB 快取,而 `detach()` 只中止在途請求 ——
兩者都不動 entry map。

所以它累積這次 session 在所有房間看過的每一則訊息。

## 為什麼它比看起來貴

entry 裡存的不只是狀態,還有**譯文全文**:

```ts
setEntry(messageId, {
  status: 'translated',
  translatedText: identical ? item.text : result.translatedText,   // ← 整段譯文
  // ...
})
```

所以留下來的不是「4000 個小物件」,是**這次 session 每一則被翻譯過的訊息的完整譯文**,
全部常駐記憶體,直到使用者登出或關掉分頁。長時間開著的分頁,這是單向成長。

## 修正

### F3 — 有界淘汰

> **這一節是暫定的,前提是開工前問題 1 與 4 的答案。**
> 第 1 項若顯示只有幾百筆,整節撤掉,只做發現 1。
> 第 4 項若顯示沒有虛擬化,下面的「未掛載」條件對幾百筆同時成立,淘汰會安靜地
> 幾乎不生效 —— 那要換成以房間為界的修剪,**先問我再動手**。

**只淘汰同時滿足兩個條件的 entry:**

1. **狀態是終態**(`translated` / `failed` / `idle`)—— 還在 `queued` / `loading` 的
   背後有真實工作在跑,丟掉它就等於讓那一列永遠卡在載入中。
2. **目前沒有掛載** —— 掛載中的列正在讀這個 entry 來算繪,丟掉它畫面會當場跳回原文。

store 不知道什麼掛載著,那是註冊表的資訊。用注入的方式取得,和既有的
`isAutoEligible` 同一個模式:

```ts
createTranslationStore({
  // ...
  config: {
    // ...
    // 註冊表歸掛載中的訊息元件所有,store 只被動詢問。
    isRetained: (id) => registryRef.current.has(id),
    maxEntries: 500,
  },
})
```

淘汰在寫入後觸發,以插入序為近似的 LRU(`Map` 保證插入序):

```ts
function evictEntries() {
  if (!cfg.maxEntries || entries.size <= cfg.maxEntries) return

  let over = entries.size - cfg.maxEntries
  for (const [id, entry] of entries) {          // Map 依插入序,最舊的先看到
    if (over <= 0) break
    if (!TERMINAL.has(entry.status)) continue   // 還有工作在跑
    if (cfg.isRetained?.(id)) continue          // 畫面上正在用
    entries.delete(id)
    queuedIds.delete(id)
    over -= 1
  }
  // 刻意不保證一定降到上限以下:如果 500 筆全都掛載中或都在進行中,那不是
  // 需要修剪的狀況,而是畫面上真的有那麼多東西。硬淘汰會弄壞正在顯示的列。
}
```

在 `setEntry` 末端呼叫一次。

### 這裡有一個必須你們決定的取捨

被淘汰的訊息**捲回來時會怎樣**?

譯文還在 IndexedDB 內容快取裡,所以下一次它成為候選時會**從快取還原、不發網路請求**。
自動翻譯開著的話,使用者幾乎看不出來。

**但自動翻譯關著的時候不會還原** —— policy 的第一道閘就是 `auto-disabled`,還原路徑
走不到。於是:關閉自動翻譯 → 手動翻譯一則 → 捲很遠 → 捲回來 → **回到原文**。

這個缺口在修剪之前就存在(重新整理一樣會發生),修剪只是讓它**不需要重新整理就會出現**。
三個選項:

| 選項 | 後果 |
|---|---|
| 照上面做 | 缺口變得比較容易遇到。如果你們接受「關閉自動翻譯時,手動翻譯只在當下有效」,這是最簡單的 |
| 先修還原路徑 | 讓 `auto-disabled` 那道閘不要擋住有手動意圖的訊息,再做修剪。工作量較大,而且要想清楚斷路器與限流要不要管到還原 |
| 把 `maxEntries` 設大(例如 2000) | 缺口幾乎遇不到,記憶體仍然有界。折衷,而且改一個數字就能調 |

**我方的建議是第三個**:先把成長變成有界,把行為問題留成一個獨立的決定,不要讓一個
記憶體修正夾帶一個使用者看得見的變化。

---

## 不要做的事

1. **不要在稽核裡「先過濾再處理」。** `entries.filter(...)` 本身就是走全表 —— 那正是
   要消除的成本。索引必須在**寫入點**維護。

2. **不要在換房間時清空整個 entry map。** 看起來是最直覺的修剪點,但它會丟掉正在
   進行中的工作(跨房間的請求仍在途),而且使用者切回上一個房間時整片跳回原文。
   以「終態 + 未掛載」為條件的淘汰才是安全的。

3. **不要為了省事把稽核關掉。** 它是為了抓「靜默停止」而存在的,而那正是這條管線
   最主要的故障形態。要讓它變便宜,不是讓它消失。

4. **不要把 `isQuiet()` 併進既有的 `stats()`。** 那個是給顯示看的三個數字,這個是
   「值不值得建立快照」。合併之後,任何一邊要加欄位都會拖累另一邊。

5. **不要淘汰還在 `queued` / `loading` 的 entry**,即使它沒有掛載。背後的 job 仍會
   settle,而 settle 會寫回一個已經被刪掉的 entry —— 那一列之後掛載回來會顯示過期狀態。

---

## 要補的測試

前三條在修正前是紅的。後三條在修正前後都綠 —— 它們擋的是「淘汰寫得太積極」。

```ts
describe('稽核成本', () => {
  test('快照只帶佇列相關的 entry', () => {
    const { store } = makeStore()
    // 一則排隊中,一則早就翻完
    store.translate('m1', job())
    settleTranslated('m2')

    const { entries } = store.inspect()

    expect(entries.map((e) => e.messageId)).toEqual(['m1'])
  })

  test('已完成的 entry 再多也不影響快照大小', () => {
    const { store } = makeStore()
    for (let i = 0; i < 500; i += 1) settleTranslated(`m${i}`)

    expect(store.inspect().entries).toHaveLength(0)
  })

  test('閒置時 isQuiet 為真', () => {
    const { store } = makeStore()
    settleTranslated('m1')          // 有 entry,但沒有工作

    expect(store.isQuiet()).toBe(true)
  })

  test('有排隊時 isQuiet 為假', () => {
    const { store } = makeStore()
    store.translate('m1', job())

    expect(store.isQuiet()).toBe(false)
  })
})

describe('entry 淘汰', () => {
  test('超過上限時丟掉最舊的終態 entry', () => {
    const { store } = makeStore({ maxEntries: 2, isRetained: () => false })
    settleTranslated('m1')
    settleTranslated('m2')
    settleTranslated('m3')

    expect(store.getEntry('m1').status).toBe('idle')   // 淘汰後回到預設
    expect(store.getEntry('m3').status).toBe('translated')
  })

  test('不丟掉畫面上正在用的', () => {
    // 淘汰一個掛載中的 entry,那一列會當場跳回原文。
    const mounted = new Set(['m1'])
    const { store } = makeStore({ maxEntries: 1, isRetained: (id) => mounted.has(id) })
    settleTranslated('m1')
    settleTranslated('m2')

    expect(store.getEntry('m1').status).toBe('translated')
  })

  test('不丟掉還有工作在跑的', () => {
    // queued 的 entry 背後有 job,它 settle 時會寫回一個已被刪除的 entry。
    const { store } = makeStore({ maxEntries: 1, isRetained: () => false })
    store.translate('m1', job())      // 停在 queued
    settleTranslated('m2')

    expect(store.getEntry('m1').status).toBe('queued')
  })
})
```

---

## 驗收

這兩項沒有畫面上的症狀,所以驗收全部是量出來的。**修正前先各量一次**,否則你不會知道
有沒有效。

| # | 怎麼量 | 期望 |
|---|---|---|
| 1 | 逛 5 個房間各捲一輪,然後敲 `store.inspect().entries.length` | 修正前:隨房間數持續上升。修正後:等於目前佇列長度,閒置時為 0 |
| 2 | 同上之後看 entry map 本身的大小 | 修正前:單向成長。修正後:停在 `maxEntries` |
| 3 | DevTools → Performance,閒置錄 30 秒(不捲動、不打字) | 修正前:每 2 秒一根規律的小尖峰。修正後:那些尖峰消失 |
| 4 | DevTools → Memory,逛 10 個房間後拍一次 heap snapshot,搜 entry 物件 | 修正後保留數應該貼近 `maxEntries`,而不是看過的訊息總數 |
| 5 | 自動翻譯開著,捲到很遠再捲回來 | 譯文仍然顯示(從內容快取還原),**不應該**有新的網路請求 |
| 6 | 稽核仍然有效:人為製造一個違規(例如手動把一個 entry 設成 queued 卻不入佇列) | 稽核照樣在 2 秒內報出來 |

**第 6 項不要跳過。** 這整份修正的風險就是把稽核優化到再也抓不到東西,而那要等到下一次
靜默停止才會發現。

---

## 完成清單

- [ ] **開工前那五個問題已經回報,並收到回覆** —— 第 1、4 項可能讓 F3 整段撤掉或改設計
- [ ] 確認過你們有沒有週期性稽核;沒有的話只做發現 2
- [ ] **修正前**量過驗收第 1、2、3 項的基準值
- [ ] `queuedIds` 索引在 `setEntry`、`entries.delete`、`entries.clear` 三處都有維護
- [ ] `inspect()` 只投影 `queuedIds ∪ 佇列 id`,不再走全表
- [ ] 稽核第一行有 `isQuiet()` 前置判斷
- [ ] 淘汰同時檢查「終態」與「未掛載」兩個條件
- [ ] `isRetained` 由註冊表提供,store 不自己持有掛載資訊
- [ ] 已決定 `maxEntries` 要設多少,以及是否接受捲回來時的還原缺口
- [ ] 七條測試齊全,前三條在修正前是紅的
- [ ] 驗收六項通過,**特別是第 6 項**

---

## 這兩項的關係

發現 2 是發現 1 的燃料。只修 1,稽核變便宜了,但記憶體仍然單向成長。只修 2,記憶體
有界了,稽核仍然每 2 秒走一遍(只是走的東西變少)。

**先做 1,而且不必等我回覆。** F1 與 F2 沒有任何行為變化(投影掉的東西在定義上不可能
產生違規),也不受開工前那五個問題的答案影響 —— 唯一的例外是問題 5:你們根本沒有稽核
的話,這兩步無事可做。

**F3 要等。** 它是唯一有使用者可見後果的一步,也是唯一可能因為問題 1、4 的答案而被撤掉
或改設計的一步。先做完 1,發現 2 就從「效能問題」降級成單純的「記憶體上界」,你們也
就有時間好好決定那個取捨。
