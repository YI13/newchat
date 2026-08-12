# entry map 的無界成長

> 你們回報的五項答案讓這份文件的**前一半整個作廢**,剩下那一半的實作也要換寫法。
> 這是改寫後的版本 —— 直接用這份,舊的那份丟掉。

**一個發現,三處要改,約八十行。**

---

## 你們的答案改變了什麼

| 你回報的 | 結果 |
|---|---|
| **沒有週期性稽核**(只有 `recheckVisible` 的修復掃描) | **「稽核成本」整個發現撤回。** 原本的 F1(queued 索引)、F2(閒置閘)都不需要了 |
| entry map 只增不減,只在刪訊息 / 登出時清 | 發現成立 |
| **`translatedText` 存在 entry 裡** | 這是貴的那一種 —— 留下的是譯文全文,不是一堆小物件 |
| **列表沒有虛擬化** | 不會殺死這個修法,但**決定了上限要設多少**(見下) |
| 有掛載註冊表(`visibilityObserver.registeredIds()`) | 正好是需要的東西,不用另外建 |

那個「沒有稽核」的答案值得說一句:**你們沒有移植它是對的取捨**,那東西在參考實作裡
每兩秒複製一次整張表,而它需要的資訊只有佇列長度那麼多。你們少掉的是一個成本與收益
不成比例的東西。

我上一版說「沒有虛擬化的話這個修法會安靜地幾乎不生效」—— **那個判斷是錯的**,理由在
下一節。

---

## 發現:entry map 只增不減

`byId: Record<string, TranslationEntry>` 只在兩處被清:訊息被刪除、登出。
**換房間不清,捲走不清。**

貴的原因是 entry 裡帶著 `translatedText`。所以留下來的不是「一堆狀態小物件」,而是
**這次 session 每一則被翻譯過的訊息的完整譯文**,常駐到使用者登出或關掉分頁為止。
長時間開著的分頁,這是單向成長。

### 為什麼沒有虛擬化不會毀掉這個修法

我上一版擔心的是:淘汰條件要求「未掛載」,而沒有虛擬化的話整個房間都掛載著,所以
淘汰擠不動。

**這個擔心搞錯了成長的來源。** 累積是**跨房間**的:

- **目前房間**的訊息掛載著 → 保留(本來就該保留,畫面正在讀它們)
- **先前逛過的每一個房間** → 早就卸載了 → 全部可淘汰

而後者才是成長的來源。所以淘汰不但有效,回收的正好是該回收的那一批。

真正被沒有虛擬化影響的是**上限要設多少**:上限必須明顯高於「單一房間同時渲染的訊息
數」,否則淘汰永遠擠不到上限以下,而它**不會報錯,只會安靜地什麼都不做**。F1 就是
在處理這件事。

> 順帶一提:沒有虛擬化的情況下,一個 2000 則的房間會同時存在 2000 個 DOM 節點和
> 2000 筆 entry,而且它們全都「掛載中」、全都不可淘汰。這個修法把成長從「整個 session」
> 收斂到「最大的單一房間」,那是實質的改善,但**上界仍然由房間大小決定**。要再往下
> 壓就得談虛擬化,那是另一件事,不在這裡。

---

## 修正

### F1 — 先量出上限要設多少

**這一步不要跳過。** 上限設得比單一房間的渲染量還低,整段淘汰就是死碼。

在你們**最大的**房間裡,一路往上捲到不能再捲(把該載入的都載入),然後:

```js
visibilityObserver.registeredIds().length
```

那是同時掛載的峰值。上限取它的 **3 倍左右**,並且不小於 1000:

```ts
const MAX_ENTRIES = Math.max(1000, peakMounted * 3)
```

留 3 倍是為了讓「目前房間 + 剛離開的一兩個房間」都還在,切回去時直接命中記憶體、
不必重新還原。

**回報一下你量到的峰值和最後選的數字。** 如果峰值本身就上千,這個修法的收益會比
預期小,那我們得談別的做法。

### F2 — 自己維護淘汰順序,不要靠 Record 的鍵序

你們用的是 `Record`,不是 `Map`。**物件的鍵順序不是可靠的 LRU 依據** —— 規格上整數形
字串鍵會被排到最前面,和插入順序無關。訊息 id 是 base62,實務上幾乎不會整串都是數字,
但把淘汰順序建立在「幾乎不會」上面是不必要的風險,而且讀的人無從得知這段程式碼依賴
了鍵序。

用一個明確的順序表。`Set` 保留插入序,而且 delete + add 就是「移到最後」:

```ts
// 模組層級,不放進 Zustand state:這是簿記,沒有任何東西算繪它。放進 state 會讓
// 每一次 entry 寫入都變成一次對不在乎它的訂閱者的狀態變更。
const touchOrder = new Set<string>()

function touch(id: string) {
  touchOrder.delete(id)   // 移到最後
  touchOrder.add(id)
}
```

在寫入 entry 的地方呼叫 `touch(id)`,在刪除的地方呼叫 `touchOrder.delete(id)`,
登出清空的地方呼叫 `touchOrder.clear()`。

### F3 — 批次淘汰,而且要有遲滯

**Zustand 的 Record 不能原地改。** 刪一筆就要重建整個物件,是 O(n)。如果每次
`setEntry` 超過上限就淘汰一筆,那是**每一次寫入都 O(n) 重建** —— 比原本的問題還糟。

所以:超過上限一段緩衝之後才動,一次清一批,只重建一次。

```ts
const MAX_ENTRIES = /* F1 量出來的 */
// 只在超出 25% 之後才動手。沒有這個緩衝,一旦達到上限就會每次寫入都重建整個 Record。
const EVICT_AT = Math.ceil(MAX_ENTRIES * 1.25)

const TERMINAL = new Set(['translated', 'failed', 'idle'])

/** 回傳新的 byId(有淘汰)或原本那個(沒有)。呼叫端據此決定要不要寫回 state。 */
function evictIfNeeded(
  byId: Record<string, TranslationEntry>,
  isRetained: (id: string) => boolean,
): Record<string, TranslationEntry> {
  if (touchOrder.size <= EVICT_AT) return byId

  const doomed = new Set<string>()
  let over = touchOrder.size - MAX_ENTRIES

  for (const id of touchOrder) {          // Set 依插入序 = 由舊到新
    if (over <= 0) break
    const entry = byId[id]
    if (!entry) {                          // 順序表和 byId 不同步,順手清掉
      touchOrder.delete(id)
      continue
    }
    if (!TERMINAL.has(entry.status)) continue   // 背後還有工作在跑
    if (isRetained(id)) continue                // 畫面上正在用
    doomed.add(id)
    over -= 1
  }

  if (doomed.size === 0) return byId

  for (const id of doomed) touchOrder.delete(id)
  // 整批一次重建。刻意不保證降到上限以下:如果剩下的全都掛載中或都在進行中,
  // 那不是需要修剪的狀況,而是畫面上真的有那麼多東西。硬淘汰會弄壞正在顯示的列。
  return Object.fromEntries(Object.entries(byId).filter(([id]) => !doomed.has(id)))
}
```

接在寫入的尾巴:

```ts
set((state) => {
  const byId = { ...state.byId, [messageId]: nextEntry }
  touch(messageId)
  // 註冊表歸掛載中的訊息元件所有,store 只被動詢問。
  return { byId: evictIfNeeded(byId, (id) => visibilityObserver.registeredIds().includes(id)) }
})
```

> `registeredIds()` 回傳陣列,`includes` 是 O(n),而淘汰迴圈會對每個候選呼叫一次 ——
> 那是 O(n²)。**淘汰前把它轉成 Set 一次**:
>
> ```ts
> const mounted = new Set(visibilityObserver.registeredIds())
> return { byId: evictIfNeeded(byId, (id) => mounted.has(id)) }
> ```
>
> 或者更好:在觀察器上加一個 `isRegistered(id)`,直接查它內部的 `elements` Map,
> 連陣列都不用建。

---

## 一個必須你們決定的取捨

被淘汰的訊息**捲回來、或切回那個房間時會怎樣?**

譯文還在 IndexedDB 內容快取裡,所以下一次它成為候選時會**從快取還原、不發網路請求**。
自動翻譯開著的話,使用者幾乎看不出來。

**但自動翻譯關著的時候不會還原** —— policy 的第一道閘就是 `auto-disabled`,還原路徑
走不到。於是:關閉自動翻譯 → 手動翻譯一則 → 換房間再換回來 → **回到原文**。

這個缺口在淘汰之前就存在(重新整理一樣會發生),淘汰只是讓它**不需要重新整理就會出現**。

**建議把 `MAX_ENTRIES` 設寬一點(F1 的 3 倍就是為此),讓這個缺口在實務上幾乎遇不到,
然後把「關閉自動翻譯時手動翻譯要不要跨房間存活」留成一個獨立的決定。** 不要讓一個
記憶體修正夾帶一個使用者看得見的行為變化。

---

## 不要做的事

1. **不要靠 `Object.keys` 的順序當 LRU。** 見 F2。就算實務上會動,下一個讀這段程式碼
   的人也無從得知它依賴了鍵序。

2. **不要每次寫入就淘汰一筆。** Record 每次刪除都要重建整個物件,那會把 O(n) 加到
   每一次 entry 寫入上。要有遲滯,而且整批一次做。

3. **不要在換房間時清空整個 entry map。** 看起來是最直覺的修剪點,但它會丟掉跨房間
   仍在進行的工作,而且使用者切回上一個房間時整片跳回原文 —— 那正是「未掛載 + 終態」
   這個條件在避免的事。

4. **不要淘汰還在 `queued` / `loading` 的 entry**,即使它沒有掛載。背後的 job 仍會
   settle,而 settle 會寫回一個已經被刪掉的 entry —— 那一列之後掛載回來會顯示過期狀態。

5. **不要把 `MAX_ENTRIES` 設得接近單一房間的渲染量。** 淘汰會擠不動,而且**不會報錯**,
   只會安靜地什麼都不做。F1 就是為了避免這件事。

6. **不要把 `touchOrder` 放進 Zustand state。** 沒有任何東西算繪它,放進去只會讓每次
   entry 寫入都通知一批不在乎的訂閱者。

---

## 要補的測試

前三條在修正前是紅的。後三條在修正前後都綠 —— 它們擋的是「淘汰寫得太積極」,那類錯誤
的後果是畫面當場跳回原文,比沒淘汰嚴重得多。

```ts
describe('entry 淘汰', () => {
  test('超過門檻時丟掉最舊的終態 entry', () => {
    const store = makeStore({ maxEntries: 2, evictAt: 2, isRetained: () => false })
    settleTranslated('m1')
    settleTranslated('m2')
    settleTranslated('m3')

    expect(store.getEntry('m1').status).toBe('idle')      // 淘汰後回到預設
    expect(store.getEntry('m3').status).toBe('translated')
  })

  test('讀取會把 entry 移到順序尾端', () => {
    // 沒有這個,順序表就只是插入序,不是 LRU —— 使用者一直在看的訊息會先被丟掉。
    const store = makeStore({ maxEntries: 2, evictAt: 2, isRetained: () => false })
    settleTranslated('m1')
    settleTranslated('m2')
    touch('m1')                                            // m1 又被用到
    settleTranslated('m3')

    expect(store.getEntry('m1').status).toBe('translated')
    expect(store.getEntry('m2').status).toBe('idle')       // 換成 m2 被丟
  })

  test('遲滯:剛好到上限時不重建', () => {
    // 沒有遲滯的話,到達上限之後每一次寫入都會重建整個 Record。
    const store = makeStore({ maxEntries: 10, evictAt: 13, isRetained: () => false })
    for (let i = 0; i < 11; i += 1) settleTranslated(`m${i}`)

    expect(Object.keys(store.getState().byId)).toHaveLength(11)
  })

  test('不丟掉畫面上正在用的', () => {
    const mounted = new Set(['m1'])
    const store = makeStore({ maxEntries: 1, evictAt: 1, isRetained: (id) => mounted.has(id) })
    settleTranslated('m1')
    settleTranslated('m2')

    expect(store.getEntry('m1').status).toBe('translated')
  })

  test('不丟掉還有工作在跑的', () => {
    const store = makeStore({ maxEntries: 1, evictAt: 1, isRetained: () => false })
    store.translate('m1', job())        // 停在 queued
    settleTranslated('m2')

    expect(store.getEntry('m1').status).toBe('queued')
  })

  test('全部都掛載時不硬淘汰', () => {
    // 上限低於單一房間渲染量的情形。正確行為是超出上限,不是弄壞畫面。
    const store = makeStore({ maxEntries: 1, evictAt: 1, isRetained: () => true })
    settleTranslated('m1')
    settleTranslated('m2')
    settleTranslated('m3')

    expect(Object.keys(store.getState().byId)).toHaveLength(3)
  })
})
```

第二條(移到尾端)是唯一測 LRU 語義的,不要省。少了 `touch`,順序表就只是插入序,
於是**使用者從頭讀到現在都在看的那一則,會比他三分鐘前掃過一眼的訊息更早被丟掉**。

---

## 驗收

這個發現沒有畫面上的症狀,所以驗收全部是量出來的。**修正前先量一次基準。**

| # | 怎麼量 | 期望 |
|---|---|---|
| 1 | 最大的房間捲到頂,`visibilityObserver.registeredIds().length` | 記下峰值;`MAX_ENTRIES` 應該是它的 3 倍左右 |
| 2 | 逛 10 個房間各捲一輪,`Object.keys(byId).length` | 修正前:隨房間數持續上升。修正後:停在 `EVICT_AT` 附近 |
| 3 | DevTools → Memory,同樣操作後拍 heap snapshot | 修正後 entry 的 retained size 應該貼近上限,而不是看過的訊息總數 |
| 4 | **自動翻譯開著**,切到別的房間再切回來 | 譯文仍然顯示(從內容快取還原),**不應該**有新的網路請求 |
| 5 | 目前房間停在畫面上,持續觸發淘汰 | 畫面上的訊息**沒有任何一則**跳回原文 |
| 6 | 淘汰觸發時看 Performance | 不應該出現每次 entry 寫入都有的尖峰 —— 遲滯生效的話,重建是偶發的 |

**第 5 項是這件事唯一真正會弄壞使用者體驗的地方。** 如果有訊息在你眼前跳回原文,
`isRetained` 沒有正確接上註冊表。

---

## 完成清單

- [ ] **修正前**量過驗收第 1、2、3 項的基準值,並回報第 1 項的峰值
- [ ] `MAX_ENTRIES` 明顯高於單一房間的渲染峰值(建議 3 倍,不小於 1000)
- [ ] `touchOrder` 是自己維護的 `Set`,**沒有**依賴 `Object.keys` 的順序
- [ ] `touchOrder` 在寫入、刪除、登出三處都有維護,且**不在** Zustand state 裡
- [ ] 淘汰有遲滯(`EVICT_AT > MAX_ENTRIES`),整批一次重建
- [ ] `isRetained` 查的是 Set 或觀察器的內部 Map,**不是**對陣列做 `includes`
- [ ] 淘汰同時檢查「終態」與「未掛載」兩個條件
- [ ] 已決定是否接受「關閉自動翻譯時、換房間回來會跳回原文」這個缺口
- [ ] 六條測試齊全,前三條在修正前是紅的
- [ ] 驗收六項通過,**特別是第 5 項**
