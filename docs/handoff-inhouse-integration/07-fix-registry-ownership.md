# 註冊表歸屬修正 — 自動翻譯 Phase A 補丁

> 可視性註冊表屬於掛載中的訊息元件,不屬於 policy。父層每呼叫一次 `destroy()`,
> 就在跟自己的子元件搶時序 —— 而且搶輸。

**兩個缺陷,一個根因。三個檔案,約二十行。**

---

## 先說清楚:PR #11 沒有修到你的程式碼

PR #11 是**我方交接檔的修正**,只動三個 `.md`。它把「換房間要呼叫 `destroy()`」這條
錯誤指示從交接檔裡拿掉 —— 但你的 `autoPolicy.ts` 和 `ChatRoom/index.tsx` 目前仍然
照舊版做,所以缺陷還在。

本文就是要交給你、用來實際修正程式碼的內容。

---

## 缺陷 1 — 你在 review 裡找到的那個

在同一個房間內把自動翻譯**關掉再打開**,觀察器對當下畫面上所有訊息失明。

成因:effect 的 cleanup 呼叫 `resetAutoPolicy()`,而它會 `destroy()` 掉註冊表。但訊息
元件**還掛在畫面上**,不會因為開關被切而重新呼叫 ref callback,所以沒有任何東西會
重新註冊它們。

> **一處更正**
>
> 你描述的順序是「cleanup 一次 `destroy()`,effect 重跑再一次」。實際上 off → on 只有
> **一次**:`if (!autoTranslate) return;` 回傳 `undefined`,React 不會註冊 cleanup,
> 所以「關閉」那一輪跑完之後沒有 cleanup 留著。結論不變。

---

## 缺陷 2 — 更嚴重,而且每次換房間都發生

`setAutoPolicyRoom()` 裡的 `destroy()` 會清掉**剛剛才註冊好**的新房間訊息。這不是競態
機率問題,是 React commit 階段的固定順序:

```
mutation phase  → 舊 DOM 移除,舊 ref 收到 null → 各自 unobserve
layout phase    → 新 ref 附加 → 新房間的訊息在這裡 observe()
passive phase   → 子先父後 → ChatRoom 的 useEffect → destroy() 把上一行剛註冊的全部清掉
                  ▲▲▲ 就是這裡
```

ref 在 **layout phase** 附加,父層的 `useEffect` 在 **passive phase** 才執行。子元件永遠
先註冊、然後被父層清掉 —— 換房間之後同樣要靠一次意外的 re-render 才會恢復。

這和缺陷 1 是同一件事:**父層不該擁有註冊表**。

---

## 為什麼 `rebuild()` 那個修法不會生效

你提的方案是房間沒變時改呼叫 `rebuild()`「re-register existing elements」。它做不到
這件事:

```js
function rebuild() {
  for (const id of [...dwellTimers.keys()]) cancelDwell(id)
  visibleIds.clear()
  centres.clear()

  observer?.disconnect()
  observer = null

  if (elements.size === 0) return          // ← 註冊表已經空了,直接返回
  const next = ensureObserver()
  for (const element of elements.values()) next.observe(element)
}
```

`rebuild()` 是「用**現有**註冊表重建觀察器」,不是「重新發現元素」。註冊表在 toggle-off
那一步就被 `destroy()` 清空了,toggle-on 時已經沒有東西可以 rebuild —— **它在唯一需要
它的情境下是 no-op。**

> **⛔ 不要做**
>
> 也不要加「已提供過」的抑制集合(`firedIds`)。那會把現在的間歇失敗變成永久失敗:
> 需要被修復的情境恰恰是「工作被丟掉了、訊息還在畫面上、而且它不動所以不會再有
> intersection entry」。正確方向是相反的機制 —— 週期性重新提供(`recheckVisible`),
> 那是 Phase D。

---

## 修正

三步,有先後。做完第一步程式會編不過(第二步補上),這是預期的。

### F1 — 移除 `setAutoPolicyRoom` 的 `destroy()`

**檔案:** `autoPolicy.ts`

```ts
export function setAutoPolicyRoom(roomId: string | null): void {
  activeRoomId = roomId;
  messageIndex.invalidate(roomId);
  clearAutoQueue();
  // No destroy(). The registry belongs to the mounted message rows: refs
  // attach in the layout phase, this effect runs in the passive phase, so
  // clearing here wipes the rows that just registered for the new room.
  // They unobserve themselves on unmount; nothing here has to help.
}
```

舊房間的訊息會在卸載時各自 `unobserve`,註冊表自然只剩新房間的列。父層不需要幫忙清。

### F2 — 把房間與開關拆成兩個 effect

**檔案:** `ChatRoom/index.tsx`

一個 effect 同時吃 `[roomId, autoTranslate]`,關開關就會跑到 cleanup。拆開之後,開關
這條路徑完全不碰註冊表。

```tsx
// Room lifecycle. The registry follows what is mounted.
useEffect(() => {
  setAutoPolicyRoom(roomId);
  return () => setAutoPolicyRoom(null);
}, [roomId]);

// Switch lifecycle. Non-destructive in both directions — the rows stay
// registered while the feature is off, and every candidate is gated by
// getContext().autoTranslate downstream.
useEffect(() => {
  if (autoTranslate) startAutoPolicy();
  else stopAutoPolicy();
}, [autoTranslate]);
```

關掉開關時訊息還在畫面上,註冊表不該被清。下游一律由 `getContext().autoTranslate`
擋住,候選會被記成 `skip:auto-disabled`,沒有其他副作用。

### F3 — 把 `resetAutoPolicy()` 收回到卸載/登出

**範圍:** 全域

`resetAutoPolicy()` 是唯一還會 `destroy()` 的入口,它只該在**整個聊天介面卸載或登出**
時呼叫。逐一檢查現有呼叫點,把放在 F2 那兩個 effect cleanup 裡的移除。

```bash
# 修完之後這個搜尋應該只有一個結果,在 resetAutoPolicy 裡
grep -rn "visibilityObserver.destroy()" src/
```

---

## 要補的測試

這兩條在修正前是紅的 —— **先確認它們真的失敗**,再套 F1/F2。套用之前就綠的測試代表
它沒有測到你以為的東西。

### 1. 開關切掉再打開,註冊表還在

```ts
test('toggling the switch off and on leaves the rows registered', () => {
  const el = document.createElement('div');
  visibilityObserver.observe('m1', el);

  startAutoPolicy();
  stopAutoPolicy();   // the switch — NOT resetAutoPolicy
  startAutoPolicy();

  expect(visibilityObserver.registeredIds()).toContain('m1');
});
```

### 2. 換房間不會清掉已經註冊的新列

```ts
test('changing room keeps rows that registered before the parent effect ran', () => {
  const el = document.createElement('div');
  // Reproduce the real order: the new room's rows attach their refs in the
  // layout phase, before ChatRoom's passive effect calls setAutoPolicyRoom.
  visibilityObserver.observe('m-new', el);
  setAutoPolicyRoom('room-2');

  expect(visibilityObserver.registeredIds()).toContain('m-new');
});
```

### 3.(選用)守住唯一的 `destroy()` 呼叫點

```ts
test('destroy() has exactly one caller', async () => {
  const src = await readFile(
    new URL('./autoPolicy.ts', import.meta.url), 'utf8',
  );
  expect(src.match(/visibilityObserver\.destroy\(\)/g) ?? []).toHaveLength(1);
});
```

這條會擋住「之後有人為了保險再加一個 `destroy()`」—— 這正是缺陷 2 的來源。

---

## 驗收

| # | 步驟 | 期望 |
|---|---|---|
| `A-2` | 關閉自動翻譯 → 重新打開(不捲動) | 當下畫面上的訊息開始翻譯 |
| `A-2b` | 切到別的房間再切回來 | 兩邊的訊息都開始翻譯,不需要先捲一下 |
| `A-1` | 捲到房間頂端再捲回底部 | 途中經過的訊息會被翻譯(回歸確認) |

`A-2` 本來就在冒煙清單裡。這次是 code review 抓到的,不是它抓到的 —— 所以請一併回報:
**當初 A-2 是沒跑,還是跑了但通過?**

> **為什麼要問**
>
> 如果**跑了而且通過**,那更值得查:代表某個 re-render 意外救了它。而那取決於
> `visibilityRef` 是不是穩定的 callback —— 穩定的話 React 不會在 re-render 時重新
> 呼叫 ref,就救不到。那會是一個間歇性、依賴渲染時序的 bug,比穩定失敗難查得多。

---

## 完成清單

- [ ] F1 / F2 / F3 三處都改完
- [ ] `grep -rn "visibilityObserver.destroy()" src/` 只有一個結果
- [ ] 兩條新測試在修正前是紅的、修正後是綠的
- [ ] `npm run typecheck` 通過,既有測試全綠
- [ ] A-2 / A-2b / A-1 三項瀏覽器冒煙通過
- [ ] 回報 A-2 當初的狀態(沒跑 / 跑了但通過)

---

交接檔的對應更新在 PR #11:`01-phase-A-observer.md` §A.4 的 ⚠️ 與「元件層」小節、
`04-phase-D-policy.md` 的 `setAutoPolicyRoom`、`05-subtasks.md` 的 A4 與新增的 A4b。

這兩個缺陷是照著我寫錯的交接檔做出來的,不是實作失誤。後面幾相如果覺得哪裡不對,
請照樣提 —— 上一次的 `distanceToCenter` shim 也是這樣抓到的。
