# ref 穩定性修正 — 自動翻譯 Phase A 補丁

> 「訊息元件擁有註冊表」有一個沒有寫出來的前提:ref 必須跨 re-render 保持同一個
> 函式身分。前提不成立時,觀察器每一次父層 re-render 都被重置一輪。

**一個缺陷,三處要改,約三十行。**

---

## 這是一份程式碼修正,不是文件更新

你在 code review 把 `setMessageRef` 的閉包問題標為 "mild",而且註明「舊的 inline
arrow 也一樣,所以不算回歸」。**前半段的機制你判斷得完全正確,後半段的結論要翻過來。**

在 Phase A 之前它確實不痛 —— 那時沒有任何東西依賴「元素持續被觀察」。Phase A
把整條自動翻譯路徑架在註冊表上之後,同一個機制變成一條會讓功能完全不動作的路徑。

---

## 缺陷

`setMessageRef(message.id)` 每次 render 回傳**新的閉包**。ref prop 換了身分,React
的規則是**先用 `null` 呼叫舊的、再用元素呼叫新的**,於是每一次父層 re-render 都跑一輪:

```
父層 re-render
  → ref prop 身分改變
  → React 用 null 呼叫舊 ref → mergedRef(null) → visibilityObserver.unobserve(id)
  → React 用元素呼叫新 ref   → mergedRef(el)   → visibilityObserver.observe(id, el)
  → IO 送新 entry → markVisible → dwell 計時器從零重來
```

聊天室的父層每收到一則新訊息就 re-render。**只要 re-render 的間隔比 `dwellMs`
(預設 400ms)短,畫面上就沒有任何一則訊息跑得完 dwell** —— 候選永遠不會被提出,
自動翻譯完全不動作。

失效形狀最麻煩的地方在於它**看起來很忙**:log 一直在動,佇列是空的,沒有錯誤,
沒有失敗計數,斷路器不會開。安靜的房間裡測不出來,愈活躍的房間愈嚴重。

---

## 為什麼觀察器的冪等保護救不了

`observe()` 有一道冪等早退:

```js
function observe(id, element) {
  if (!element) return
  // 同一個元素重複註冊時,不重啟已經走了一半的 dwell
  if (elements.get(id) === element) {
    ensureObserver().observe(element)
    return
  }
  if (elements.has(id)) unobserve(id)
  elements.set(id, element)
  ...
}
```

它擋的是「**連續 `observe` 兩次**」。而這裡的順序是 `unobserve` → `observe`:

```js
function unobserve(id) {
  ...
  elements.delete(id)      // ← 註冊表項目沒了
  markHidden(id)           // ← visibleIds.delete + cancelDwell
}
```

等 `observe()` 跑到時 `elements.get(id)` 已經是 `undefined`,早退條件不成立,走的是
全新註冊那條路。**保護在這條路徑上不存在。** 它從來就不是設計來擋這個的 —— 這是
ref 那一端的責任,而交接檔沒有把這個前提寫出來,那是我方的疏漏。

---

## 為什麼你提的修法不會生效

```ts
const setMessageRef = useCallback(
  (id: string) => {
    const refFn = (element: HTMLDivElement | null) => {
      messagesRef.current[id] = element;
    };
    refFn.id = id;          // ← 這行沒有 memo 任何東西
    return refFn;
  },
  [messagesRef]
);
```

`refFn` 仍然是**每次呼叫**都新建。`useCallback` memo 的是 `setMessageRef` 這個產生器
本身(它本來就已經是了),不是它回傳的那個閉包;掛一個 `.id` 屬性上去只是替函式貼標籤,
不改變身分。`setMessageRef(message.id)` 照樣每次 render 給出不同的函式,React 照樣
detach / re-attach。

順帶一提 `[messagesRef]` 這個相依 —— ref 物件本身恆定,寫了沒有害處,但也沒有作用。

**你在後面那句順帶提的方案才是對的:「或用 `Map<string, (el) => void>` 以 message id
為鍵」。** 下面 F1 就是把那句話寫成程式碼。

---

## 修正

### F1 — 以 id 為鍵快取 ref 閉包

**檔案:** 訊息列表元件(持有 `setMessageRef` 的那一個)

```tsx
const refCache = useRef(new Map<string, (el: HTMLDivElement | null) => void>());

const setMessageRef = useCallback((id: string) => {
  const cache = refCache.current;
  const cached = cache.get(id);
  if (cached) return cached;

  const fn = (element: HTMLDivElement | null) => {
    if (element) {
      messagesRef.current[id] = element;
      return;
    }
    // Identity is stable now, so React only passes null on a genuine unmount.
    // That makes this the right place to drop both entries — without the
    // cache delete the map grows for the lifetime of the room.
    delete messagesRef.current[id];
    cache.delete(id);
  };

  cache.set(id, fn);
  return fn;
}, []);
```

身分穩定之後,`null` 只會在真正卸載時送達 —— 所以在那裡順手把兩張表的項目都刪掉,
Map 不會隨著捲動無限長大。列若之後重新掛載,再建一個新的即可。

### F2 — `mergedRef` 的相依陣列**不要動**

**檔案:** `OthersMessage`

```tsx
const mergedRef = useCallback((el: HTMLDivElement | null) => {
  if (typeof ref === 'function') ref(el);
  else if (ref) ref.current = el;
  visibilityRef(el);
}, [ref, visibilityRef]);
```

這段是對的,維持原樣。

> **⛔ 不要做**
>
> 不要為了「讓 `mergedRef` 不再重建」而把 `ref` / `visibilityRef` 塞進一個 `useRef`
> 然後把相依陣列改成 `[]`。那個相依陣列**沒有說謊** —— 它忠實反映了輸入真的在變。
> 改掉它只是把症狀藏起來:下一個有人接上來的不穩定 ref 就再也不會有任何跡象,
> 而且真正需要換掉消費者時,舊的那個永遠收不到 `null`。
>
> 要修的是**輸入**(F1 與 F3)。相依陣列留著當絆線。

### F3 — `visibilityRef` 也要穩定

**檔案:** 產生 `visibilityRef` 的那個 hook / 元件

`mergedRef` 有兩個輸入,只修一個等於沒修 —— 任何一邊每次 render 換身分,整條鏈就
照樣 detach / re-attach。若 `visibilityRef` 是用 `useVisibilityRef(messageId)` 之類
的形式取得,它多半有和 F1 一模一樣的問題,修法也一樣:以 id 為鍵快取。

驗證方式不必讀完實作,直接量:

```tsx
// 暫時加在 OthersMessage 裡,確認之後移除
const prev = useRef<unknown>(null);
useEffect(() => {
  if (prev.current && prev.current !== visibilityRef) {
    console.warn('visibilityRef changed identity', message.id);
  }
  prev.current = visibilityRef;
});
```

在活躍的房間裡待三十秒。有任何一行輸出,F3 就還沒做完。

---

## 要補的測試

第一條釘住機制,第二條釘住後果。**兩條在修正前都必須是紅的** —— 修正前就綠代表
它沒有測到你以為的東西。

### 1. 父層 re-render 不會動到註冊表

```ts
test('a parent re-render does not re-register the rows', () => {
  const unobserve = vi.spyOn(visibilityObserver, 'unobserve');
  const { rerender } = render(<MessageList messages={[m1, m2]} />);

  const before = visibilityObserver.registeredIds();
  rerender(<MessageList messages={[m1, m2, m3]} />);

  // m1 / m2 沒有被動到,只多了 m3
  expect(unobserve).not.toHaveBeenCalled();
  expect(visibilityObserver.registeredIds()).toEqual([...before, 'm3']);
});
```

### 2. 訊息持續進來時,dwell 仍然跑得完

這條才是使用者實際遇到的那件事。用真 timer + 縮小的時間常數。

```ts
test('a visible row still completes its dwell while messages keep arriving', async () => {
  const onCandidate = vi.fn();
  // dwellMs 20,每 8ms 送一則新訊息進來觸發父層 re-render
  const { rerender } = render(<MessageList messages={[m1]} />);
  markVisibleInTest('m1');

  for (let i = 0; i < 6; i += 1) {
    await sleep(8);
    rerender(<MessageList messages={[m1, ...extra.slice(0, i + 1)]} />);
  }
  await sleep(40);

  // 修正前:每輪 re-render 都取消 dwell,永遠是 0 次
  expect(onCandidate).toHaveBeenCalledWith('m1');
  expect(onCandidate.mock.calls.filter(([id]) => id === 'm1')).toHaveLength(1);
});
```

`toHaveLength(1)` 那行同時擋住反向的錯誤 —— 修完之後同一則不該被重複提出。

---

## 驗收

| # | 步驟 | 期望 |
|---|---|---|
| 1 | 在**活躍**的房間(持續有新訊息進來)停住不捲 | 畫面上的訊息照常被翻譯 |
| 2 | 對其中一則跑 `__translate.timeline(id)` | `visible` 之後直接接 `dwell`,**沒有** `visible / hidden` 反覆成對 |
| 3 | 安靜的房間停住不捲 | 與修正前一致(回歸確認) |

第 1 項是這個缺陷的直接情境,而且**只在活躍的房間出現** —— 之前的冒煙如果是在
安靜的房間跑的,不會碰到它。

請一併回報:**修正前第 2 項的 timeline 長什麼樣子?** 如果 `visible / hidden`
真的成對反覆出現,那就確認了這條路徑在你們環境裡是活的,而不只是理論上成立。

---

## 完成清單

- [ ] F1 / F2(維持原樣)/ F3 三處都確認過
- [ ] F3 的身分探針在活躍房間跑三十秒沒有任何輸出,並已移除探針
- [ ] 兩條新測試在修正前是紅的、修正後是綠的
- [ ] `npm run typecheck` 通過,既有測試全綠
- [ ] 上表三項瀏覽器冒煙通過
- [ ] 回報修正前第 2 項的 timeline 形狀

---

這個前提沒有寫進交接檔,是我方的疏漏 —— 你照著文件做不可能避開它。你把機制判斷對了,
只是嚴重度被「不算回歸」這句話蓋過去;既有的問題不等於無害的問題,差別在於後來有沒有
東西開始依賴它。
