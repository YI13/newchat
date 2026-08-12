# 修復掃描:不要重問已經有答案的問題

> 這份是對你們那份提案的**修訂**,不是另一個設計。骨架照用 —— 記憶化 Set、
> `recheckVisible` 加閘、清除方法 —— 但有**兩處必改**,其中一處會讓功能靜默壞掉,
> 另一處會讓你們自己寫的測試紅掉。另外你們漏掉了一個比 log 噪音貴得多的東西。

**一個發現,三處要改,約六十行。**

---

## 先說結論

| 你們提案的 | 結果 |
|---|---|
| 診斷:修復掃描每秒重問一次永遠不會變的答案 | **正確,而且參考實作有同一個 bug** |
| 記憶化 Set 放在 policy 工廠內部、不進 state | 對,照做 |
| `unknown-message` 不記憶化 | **對,而且理由正確** —— 索引會重建 |
| `own-message` 可記憶化 | 對 |
| `non-textual` 可記憶化,「內容不會改變」 | **錯 —— 訊息可以被編輯**(必改 1) |
| memo 閘放在 `getEntry` 之後 | **和你們自己的測試矛盾**(必改 2) |
| `intent = 'off'` 不記憶化,因為使用者可以反悔 | 理由對,結論讓一個更貴的問題留著(見下) |

---

## 你們漏掉的那個:每秒一次 IndexedDB 讀取

這一節值得單獨看,因為它比 log 噪音貴,而且**它不會出現在 console 裡** ——
你們正是靠 console 才發現原本那個問題的。

### 發生什麼事

一則使用者按過「查看原文」的訊息:

- 它是別人發的、有文字內容 → **規則全部通過**
- 斷路器沒開、沒有限流 → **閘門全部通過**
- 於是掃描每一次都走到 `ensureForView`

而 `ensureForView` 的第一件事是:

```ts
const intent = await cache.intent.get(messageId)   // ← IndexedDB
if (intent === 'off') { log.emit(DECISION.Suppressed, ...); return { outcome: 'suppressed' } }
```

`revert()` 把 entry 設回 `idle`,所以掃描的 `status !== 'idle'` 閘擋不住它。
結果:**畫面上每有一則「查看原文」的訊息,就是每秒一次 IndexedDB 交易。**

### 為什麼這比 log 噪音貴

log 噪音是往一個環狀緩衝區推一個字串 —— 主執行緒、微秒級、記憶體有上限。

IndexedDB 的 `.get()` 不是 Map 查詢,它是**一次交易**:開一個 readonly transaction、
做一次 key 查找、把結果做結構化複製反序列化送回來、關閉交易。每一次都要:

- 喚醒瀏覽器的儲存層(在手機上這會擋住儲存子系統進入待機,是實打實的耗電)
- 配置 + 反序列化
- 在 microtask queue 上排一個完成回呼,以及一整條 promise 鏈

而且它的**頻率取決於畫面上有什麼,不取決於有沒有事情在發生**。使用者停在畫面上讀
訊息、什麼都沒做,五則 reverted 訊息就是每秒五次交易,無限期。

### 最糟的部分是它不會自己講話

`skip non-textual` 至少會在 console 印出來,所以你們發現了。這條路徑產生的是
`Suppressed` 決策,**不會**印成 skip,在噪音裡混在一起,沒有人會單獨注意到它。
你們的提案把它明確排除掉,理由是「使用者可以反悔」—— 於是最貴的那一項會原封不動
留下來。

> 順帶更正我先前在討論裡說的一句:我提過這條路徑還會「取放一次 probe token」。
> **那是錯的** —— `claimProbe()` 在斷路器關閉時第一行就 return false,什麼都沒做。
> IndexedDB 讀取和那筆 log 是真的,probe 不是。

### 正確的原則

不是「會變的就不要記憶化」,而是:

**記憶化,然後由會改變答案的那個事件去讓它失效。**

| 記憶化的原因 | 由什麼讓它失效 |
|---|---|
| `non-textual` | 訊息被編輯 → 用修訂版本當鍵(必改 1) |
| `own-message` | 不會變(session 內) |
| `system-message` | 不會變 |
| `intent = 'off'` | 使用者按下翻譯 / 查看原文 → `forget(id)` |
| `unknown-message` | **不記憶化** —— 索引重建沒有事件可掛 |

`intent` 的失效點很明確:就是 `translate()` 和 `revert()` 這兩個函式本身。

---

## 必改 1 — 鍵要帶訊息的修訂版本

你們寫「訊息本體無 Unicode 字母,內容不會改變」。**訊息可以被編輯。**

使用者把一則只有 😀 的訊息編輯成「😀 早安」,`HAS_LETTER` 的結果就翻面了。
`non-textual` 不是 message id 的性質,是 `(id, 修訂版本)` 的性質。

而且這不是邊緣情境。編輯的處理路徑做的第一件事就是:

```ts
async function onMessageEdited(messageId) {
  const reqSeq = invalidate(messageId)
  setEntry(messageId, { status: 'idle', reqSeq })   // ← 故意設回 idle
  await cache.content.clear(messageId)
}
```

**把 entry 設回 `idle` 就是為了讓修復掃描重新接手它。** 以 id 為鍵的 memo 會把這個
機制對「非文字被編輯成有文字」這一類訊息整個廢掉 —— 而那正好是最需要它的一類。

失效形狀:編輯後永遠不會被翻譯,直到那一列卸載為止。沒有錯誤、沒有 log、
測試不會紅。

**修法:記住答案是在哪個修訂版本給出的,查詢時比對。**

---

## 必改 2 — 閘門在 `getEntry` 之前,不是之後

你們的實作:

```ts
if (store.getEntry(id).status !== 'idle') continue;
if (permanentlySkipped.has(id)) continue;     // ← 在 getEntry 之後
```

你們的測試:

```ts
// getEntry must not be called again for m1 on the second sweep.
expect(getEntry.mock.calls.length).toBe(callsAfterFirst);
```

**前兩條測試會紅**,因為 `getEntry(id)` 在 memo 閘之前就跑了,每次掃描對每個可見 id
都會呼叫一次。

**修的方向是移動閘門,不是放寬測試。** memo 查詢是一次 Map 查找,比讀 store 便宜,
本來就該在前面 —— 而且「掃描對這些 id 不再碰任何東西」正是這次修正的全部意義,
那條斷言是唯一能驗證它的東西。看到紅了去改測試,等於把驗證拿掉只留下感覺。

---

## 修正

### F1 — policy 工廠內部:記憶表與判定

**檔案:** `autoPolicy.ts`,和 `recentRequests` 那幾行放在一起

```ts
/**
 * 掃描已經有答案的訊息,id -> 給出答案時的修訂版本。
 *
 * 修復掃描每秒重新提出每一則 idle 的可見訊息,那是它修復「被滿佇列擋掉」的方式。
 * 但對一則永遠不會被翻譯的訊息,答案每次都一樣,而重新推導它要付出一次 store
 * 讀取、整條規則鏈、一筆 log —— 每則、每秒,只要它還在畫面上。被 revert 過的
 * 訊息還要再加一次 IndexedDB 讀取。
 *
 * 以修訂版本為鍵,不是只用 id:編輯會改變答案。一則貼圖被編輯成有文字就變成
 * 可翻譯,而 store 會把它的 entry 設回 idle 正是為了讓掃描重新接手 —— 只用 id
 * 的 memo 會把那個機制吞掉,那則訊息在卸載之前永遠不會被翻譯。
 */
const answered = new Map<string, number>();

/** 只有這些能單靠訊息本身定案。`unknown-message` 絕不可加入:訊息在列表還在
 *  填充時可能短暫不存在,記憶化那個會讓它擱淺。 */
const PERMANENT_SKIPS = new Set([SKIP.NonTextual, SKIP.OwnMessage, SKIP.SystemMessage]);

const revisionOf = (message?: PolicyMessage) => message?.editedAt ?? 0;

function remember(messageId: string, message?: PolicyMessage) {
  if (message) answered.set(messageId, revisionOf(message));
}

function isAnswered(messageId: string): boolean {
  const at = answered.get(messageId);
  if (at === undefined) return false;
  const message = getMessage(messageId);
  // 從索引消失,或之後被編輯過:兩種情況舊答案都不再適用,重新走一次閘門。
  if (!message || revisionOf(message) !== at) {
    answered.delete(messageId);
    return false;
  }
  return true;
}
```

`isAnswered` 順手處理掉「訊息暫時離開索引」的情況 —— 不需要為它另外寫一條路。

### F2 — `recheckVisible`:閘門放最前面

```ts
for (const id of ids) {
  // 在 store 讀取之前,不是之後:辨認一個閘門已經定案的 id 只是一次 Map 查找,
  // 而「這個迴圈對那些訊息不再碰任何東西」正是 memo 的全部意義。
  if (isAnswered(id)) continue;
  if (store.getEntry(id).status !== 'idle') continue;
  void onCandidate(id);
}
```

### F3 — `offerCandidate`:兩個寫入點

**不要**寫在 `skip()` 輔助函式裡。那個函式在 `getMessage` 之前就定義了,拿不到
message 物件,也就算不出修訂版本;而且從那裡寫會把 `unknown-message` 一起記進去。

寫在規則迴圈上:

```ts
const message = getMessage(messageId);
for (const rule of rules) {
  const reason = rule(message, ctx);
  if (reason) {
    if (PERMANENT_SKIPS.has(reason)) remember(messageId, message);
    return skip(reason);
  }
}
```

以及 `ensureForView` 回來之後:

```ts
if (result?.outcome !== 'queued') {
  probing = false;
  // 這裡的 'suppressed' 一定是 intent === 'off' —— auto-off 那條分支到不了,
  // 因為 offerCandidate 在開關關閉時早就 return 了。走到這裡代表付出了一次
  // IndexedDB 讀取,而這個答案只在使用者按下翻譯或查看原文時改變,兩者都會
  // 呼叫 forget()。
  if (result?.outcome === 'suppressed') remember(messageId, message);
  return result ?? {};
}
```

### F4 — 暴露 `forget`,並接上三個失效點

```ts
return {
  config: cfg,
  onCandidate,
  recheckVisible,
  resetCircuitBreaker,
  /** 丟掉一個記憶化的答案。使用者改變它時呼叫(翻譯 / 查看原文),以及那一列
   *  卸載時 —— 後者順便把這張表的大小限制在「畫面上有什麼」,而不是
   *  「這個 session 看過什麼」。 */
  forget: (messageId: string) => answered.delete(messageId),
  gatesManualRequests: false,
  stats: () => ({ ... }),
};
```

三個呼叫點:

| 呼叫點 | 為什麼 |
|---|---|
| 手動「翻譯」按鈕 | 使用者要覆蓋掉 `off` 意圖 |
| 「查看原文」按鈕 | 使用者剛建立一個 `off` 意圖 |
| 訊息元件卸載(`unobserve` 那一路) | 記憶已經沒用了,順便讓表不會無限長大 |

> **你們提案裡的 `setAutoPolicyRoom` / `resetAutoPolicy` 清空可以保留**,無害。
> 但如果卸載那個呼叫點接上了,換房間其實已經自動清乾淨了 —— 換房間會卸載所有
> 訊息列。兩個都做也行,清空是冪等的。

---

## 要補的測試

**前五條在修正前是紅的。後三條在修正前後都綠** —— 它們擋的是「記憶化寫得太積極」,
那類錯誤的後果是訊息永遠不被翻譯,比原本的噪音嚴重得多。

```ts
describe('掃描不再重問已有答案的問題', () => {
  async function sweepTwice(h) {
    h.visible.add('m1');
    await h.policy.recheckVisible();
    await h.policy.recheckVisible();
  }

  test.each([
    ['non-textual', message({ content: '😀🎉' })],
    ['own message', message({ sender: { account: 'alice' } })],   // alice 是目前使用者
    ['system message', message({ sysMsgData: { type: 'join' } })],
  ])('永久性的 %s 只評估一次,不是每次掃描一次', async (_name, msg) => {
    const h = makePolicy({ messages: [msg] });
    const reads = jest.spyOn(h.store, 'getEntry');

    await sweepTwice(h);

    // 只有第一次掃描那一次 store 讀取。第二次在碰任何東西之前就認出這個 id。
    expect(reads).toHaveBeenCalledTimes(1);
  });

  test('被 revert 的訊息只花一次 intent 讀取,不是每次掃描一次', async () => {
    // 'suppressed' 是 ensureForView 回報 intent === 'off' 的方式。走到那裡就是
    // 一次 IndexedDB 交易,而答案只在使用者按下按鈕時改變。
    const h = makePolicy();
    h.ensureForView.mockResolvedValue({ outcome: 'suppressed' });

    await sweepTwice(h);

    expect(h.ensureForView).toHaveBeenCalledTimes(1);
  });

  test('編輯訊息會重新開放它', async () => {
    // memo 不能只用 id 當鍵的全部理由:一則貼圖被編輯成有文字就變成可翻譯,
    // 而 store 把 entry 設回 idle 正是為了讓掃描重新接手。
    const h = makePolicy({ messages: [message({ content: '😀', editedAt: 0 })] });
    h.visible.add('m1');
    await h.policy.recheckVisible();

    h.messages.set('m1', message({ content: '😀 早安', editedAt: 7 }));
    await h.policy.recheckVisible();

    expect(h.ensureForView).toHaveBeenCalledTimes(1);
  });

  test('forget 會重新開放它', async () => {
    // 手動翻譯 / 查看原文 兩個按鈕呼叫的東西:使用者剛改變了 memo held 的答案。
    const h = makePolicy();
    h.ensureForView.mockResolvedValue({ outcome: 'suppressed' });
    await sweepTwice(h);

    h.policy.forget('m1');
    await h.policy.recheckVisible();

    expect(h.ensureForView).toHaveBeenCalledTimes(2);
  });

  test('未知的訊息永遠不記憶化', async () => {
    // 訊息在列表還在填充時可能短暫不存在。記憶化那個會讓它擱淺,
    // 而且只要它還在畫面上就一直擱淺。
    const h = makePolicy({ messages: [] });
    h.visible.add('m1');
    await h.policy.recheckVisible();

    h.messages.set('m1', message());
    await h.policy.recheckVisible();

    expect(h.ensureForView).toHaveBeenCalledTimes(1);
  });

  test('可翻譯的訊息仍然每次掃描都重新提出', async () => {
    // 修復路徑本身。一則被滿佇列擋下而停在 idle 的訊息必須一直回來 ——
    // 記憶化它等於把掃描靜默關掉。
    const h = makePolicy();
    h.ensureForView.mockResolvedValue({ outcome: 'dropped', sent: Promise.resolve(false) });

    await sweepTwice(h);

    expect(h.ensureForView).toHaveBeenCalledTimes(2);
  });
});
```

「編輯訊息會重新開放它」和「未知的訊息永遠不記憶化」這兩條在修正前是綠的 ——
它們測的是「不要做錯的事」。**但它們在你們原本的提案下會紅**,那正是它們存在的理由:
它們是必改 1 和 `unknown-message` 判斷的守門員。

---

## 驗收

| # | 步驟 | 期望 |
|---|---|---|
| 1 | 開啟一個有貼圖 / 附件的房間,啟用自動翻譯 | console 只印出**一次** `non-textual`,之後安靜 |
| 2 | 等 10 秒 | 沒有任何重複行 |
| 3 | 對一則訊息按「查看原文」,然後停著不動 | **DevTools → Application → IndexedDB 不再有每秒一次的讀取**;`Suppressed` 也只出現一次 |
| 4 | **編輯那則貼圖訊息,加上文字** | 兩秒內自動被翻譯 |
| 5 | 對第 3 項那則訊息按「翻譯」 | 立刻翻譯,不需要等待或捲動 |
| 6 | 手動把一則 `translated` 的 entry 改回 `idle`(DevTools) | 兩秒內自動重新翻譯 —— 修復掃描仍然活著 |
| 7 | 換房間再換回來 | 行為與第 1 項相同(各一次,不是無限) |

**第 4 項是必改 1 的驗收,第 6 項是「沒有把掃描修死」的驗收。** 這兩項最重要,
其餘是確認接線。

第 3 項的 IndexedDB 觀察方式:DevTools → Application → IndexedDB,或在
Performance 錄一段看有沒有規律的 storage 活動。

---

## 完成清單

- [ ] `answered` 是 `Map<string, number>`(id → 修訂版本),**不是** `Set<string>`
- [ ] `isAnswered` 會在訊息消失或修訂版本改變時刪掉該筆並回傳 false
- [ ] `recheckVisible` 的 memo 閘在 `getEntry` **之前**
- [ ] 記憶化寫在規則迴圈與 `ensureForView` 之後,**不在** `skip()` 輔助函式裡
- [ ] `PERMANENT_SKIPS` 不含 `unknown-message`
- [ ] `outcome === 'suppressed'` 也會記憶化
- [ ] `forget()` 接上三個呼叫點:手動翻譯、查看原文、訊息列卸載
- [ ] 六條測試齊全,前四條在修正前是紅的
- [ ] 驗收七項通過,**特別是第 4 和第 6 項**
