# 重試預算與 ref 穩定性 — 自動翻譯 Phase A 補丁

> 兩項修正。一項是你在 code review 提到、但實際要改的地方不在你標的位置;
> 另一項是你標成 "mild"、而它其實會讓整個功能在活躍房間裡完全不動作。

**兩個缺陷,四處要改,約四十行。**

---

## 這是兩項程式碼修正,不是文件更新

你這一輪 code review 提的兩點,機制判斷都正確。要調整的是**結論**:

| 你的判斷 | 實際 |
|---|---|
| #5「4 → 3 是 silent reduction,值得寫進 MR description」 | 3 是對的,不用改回去。但**自動路徑該傳 1**,那才是要動的地方 |
| #6「mild、不算回歸,順手修一下就好」 | 機制描述完全正確,但這是會讓自動翻譯**完全不動作**的一條路徑 |

---
---

# 第一項 — 自動路徑的請求預算

## 你的 #5:對的那一半,和要換掉的那一半

**對的:** `attempt < maxAttempts - 1` 確實讓總次數從 4 變成 3,算術沒有問題。

**要換的:** 這不是「悄悄減少」,而是把一個 off-by-one **修掉**了。原本的常數叫
`RETRY_MAX_ATTEMPTS = 3` 卻跑 4 次 —— 名字和行為不一致。改名成
`DEFAULT_MAX_ATTEMPTS` 之後跑 3 次,名字終於誠實了。**維持 3,不要改回 4。**

而「寫進 MR description」擋不住它再漂回去,擋得住的是測試。下面 T1 就是。

## 真正要改的:自動路徑不該跑重試階梯

重點不是 3 還是 4,是**自動翻譯的那條路徑到底傳幾**。

自動路徑上面已經有一個斷路器在管退避了。底下的傳輸層若再跑自己的重試階梯,
兩層會互相打架:

| | 每個 auto job 的代價 |
|---|---|
| 預算 3(現況) | 3 個真實請求 + 500ms + 1000ms backoff,全程佔住 auto slot |
| 預算 1(應有) | 1 個請求,失敗立刻歸還 slot,退避交給斷路器 |

後端故障時的實際差別:

- 斷路器要**連續 5 次失敗**才開。預算 3 的話,那是**最多 15 個真實請求**打在一個
  已經在失敗的後端上,才輪得到斷路器出手。預算 1 則是 5 個。
- auto slot 只有 **2 個**。每個 attempt 若吃滿 5s 的 wire timeout,整條階梯是
  `5 + 0.5 + 5 + 1 + 5 = 16.5s`,超過 store 自己的 15s timeout —— 於是兩個 auto
  slot 可以整整 15 秒都被佔著,期間一件事都沒完成,而且結果還是失敗。

**斷路器要擋的事情,被它底下的重試階梯先做了一遍。**

手動請求維持預設。使用者按下去的那一則沒有任何東西在替它退避,傳輸層的重試是它
唯一的保險。

## 修正

### F1 — 依 origin 決定請求預算

**檔案:** store(送出翻譯請求的那一處)

在呼叫翻譯服務的地方,把 `maxAttempts` 依 origin 帶進去:

```ts
const isAuto = item.origin === 'auto';

const result = await withTimeout(
  translate(
    nats,
    { text: item.text, targetLang: item.targetLang },
    // One attempt on the automatic path: its circuit breaker already owns
    // backoff, and a transport-level ladder underneath would spend three
    // requests per job against a backend that is already failing, holding
    // one of two auto slots for the length of the ladder. A manual request
    // has nothing watching it, so it keeps the default.
    { signal: controller.signal, ...(isAuto ? { maxAttempts: 1 } : {}) },
  ),
);
```

用展開而不是直接寫 `maxAttempts: isAuto ? 1 : DEFAULT_MAX_ATTEMPTS`,是為了讓手動
路徑繼續拿傳輸層的預設值 —— 預設值改動時不必記得同步這裡。

## 要補的測試

```ts
describe('request budget per origin', () => {
  test('an automatic job asks for exactly one attempt', async () => {
    const { store, translate } = makeStore();

    store.translate('m1', job({ origin: 'auto' }));
    await flush();

    expect(translate.calls[0].opts.maxAttempts).toBe(1);
  });

  test('a manual job keeps the default ladder', async () => {
    const { store, translate } = makeStore();

    store.translate('m1', job());
    await flush();

    expect(translate.calls[0].opts.maxAttempts).toBeUndefined();
  });
});
```

**T1(第一條)在修正前是紅的。** 第二條修正前後都綠 —— 它存在是為了擋住「乾脆
兩條路徑都傳 1」這個看起來很省事、但會讓手動翻譯在後端抖動時直接失敗的改法。

另外把總次數本身也釘住,這樣它就不會再漂:

```ts
test('gives up after the attempt budget and rethrows the last error', async () => {
  const request = vi.fn().mockRejectedValue(unavailableError());

  await expect(
    withFakeTimers(() => translateText(makeNats(request), { text: 'hello', targetLang: 'de' })),
  ).rejects.toMatchObject({ code: 'unavailable' });

  expect(request).toHaveBeenCalledTimes(3);   // ← 這一行才是 MR description 的替代品
});
```

---
---

# 第二項 — ref 身分穩定性

## 為什麼這不是 "mild"

> the old inline arrow had the same problem, so this isn't a regression

這句話是整段唯一要翻過來的地方。

在觀察器上線之前它確實無害 —— 那時**沒有任何東西依賴「元素持續被觀察」**。
把整條自動翻譯路徑架在註冊表上之後,同一個機制變成一條會讓功能完全不動作的路徑。
**既有的問題不等於無害的問題**,差別在於後來有沒有東西開始靠著它。

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

## 為什麼觀察器的冪等保護救不了

觀察器有一道冪等早退:

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
全新註冊那條路。**保護在這條路徑上不存在** —— 它從來就不是設計來擋這個的,這是 ref
那一端的責任,而交接檔沒有把這個前提寫出來,那是我方的疏漏。

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
為鍵」。** 下面 F2 就是把那句話寫成程式碼。

## 修正

### F2 — 以 id 為鍵快取 ref 閉包

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

### F3 — `mergedRef` 的相依陣列**不要動**

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
> 要修的是**輸入**(F2 與 F4)。相依陣列留著當絆線。

### F4 — `visibilityRef` 也要穩定

**檔案:** 產生 `visibilityRef` 的那個 hook / 元件

`mergedRef` 有兩個輸入,只修一個等於沒修 —— 任何一邊每次 render 換身分,整條鏈就
照樣 detach / re-attach。若 `visibilityRef` 是用 `useVisibilityRef(messageId)` 之類
的形式取得,它多半有和 F2 一模一樣的問題,修法也一樣:以 id 為鍵快取。

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

在活躍的房間裡待三十秒。有任何一行輸出,F4 就還沒做完。

## 要補的測試

第一條釘住機制,第二條釘住後果。**兩條在修正前都必須是紅的** —— 修正前就綠代表
它沒有測到你以為的東西。

### T3. 父層 re-render 不會動到註冊表

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

### T4. 訊息持續進來時,dwell 仍然跑得完

這條才是使用者實際遇到的那件事。用真 timer + 縮小的時間常數(不要用 fake timers,
它會餓死非同步佇列)。

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
---

## 驗收

| # | 步驟 | 期望 |
|---|---|---|
| 1 | 在**活躍**的房間(持續有新訊息進來)停住不捲 | 畫面上的訊息照常被翻譯 |
| 2 | 對其中一則跑 `__translate.timeline(id)` | `visible` 之後直接接 `dwell`,**沒有** `visible / hidden` 反覆成對 |
| 3 | 安靜的房間停住不捲 | 與修正前一致(回歸確認) |
| 4 | 斷開後端,看著畫面上約 10 則未翻譯的訊息 | 送出的請求總數約 5 個而非 15 個;斷路器打開後停止發送 |

第 1 項是 ref 缺陷的直接情境,而且**只在活躍的房間出現** —— 之前的冒煙如果是在
安靜的房間跑的,不會碰到它。第 4 項是請求預算的直接情境。

請一併回報:

1. **修正前**第 2 項的 timeline 長什麼樣子?如果 `visible` / `hidden` 真的成對反覆
   出現而始終沒有 `dwell`,那就確認了這條路徑在你們環境裡是活的,而不只是理論上成立。
2. **你們現在是跑在 stub 還是真後端上?**(對應的環境變數預設是開啟 stub。)這個
   問題問過幾次還沒有答案,而它會直接改變上一份 log 裡那段失敗要怎麼解讀 ——
   如果是 stub,那段失敗是模擬出來的,不代表後端有問題。

---

## 完成清單

- [ ] F1 已套用,且**沒有**把總次數改回 4
- [ ] T1 在修正前是紅的、修正後是綠的;T2 前後都綠
- [ ] 總次數的斷言測試存在(`toHaveBeenCalledTimes(3)`)
- [ ] F2 / F3(維持原樣)/ F4 三處都確認過
- [ ] F4 的身分探針在活躍房間跑三十秒沒有任何輸出,並已移除探針
- [ ] T3 / T4 在修正前是紅的、修正後是綠的
- [ ] `npm run typecheck` 通過,既有測試全綠
- [ ] 上表四項瀏覽器冒煙通過
- [ ] 回報修正前第 2 項的 timeline 形狀,以及 stub / 真後端

---

這兩項的成因都一樣:模組本身寫對了,但它**對呼叫端的要求沒有寫進交接檔** ——
自動路徑該傳什麼預算、ref 必須維持同一個函式身分,兩件事都只存在於實作者腦中。
你照著文件做不可能避開。後面覺得哪裡不對請照樣提。
