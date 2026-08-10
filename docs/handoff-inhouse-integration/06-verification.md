# 06 — 驗證

每個 Phase 結束時讀對應的一節。

## 測試環境注意事項

1. **不要用 `vi.useFakeTimers()` 跑整合類測試。** fake timers 會餓死
   fake-indexeddb 的真實 task queue,測試會掛在等 IDB。整合測試用**真 timer
   + 縮小的時間常數**(dwell 6~20ms)。
2. **jsdom 沒有 layout。** `getBoundingClientRect` 預設回傳全零,所以 `centreOf`
   會全部走 fallback,**活測那條路徑根本沒被執行** —— 量出來的排序數字是假的。
   模擬時要給每一列一個會隨捲動更新的 `getBoundingClientRect`。
3. 測試檔與原始碼同層,`Foo.ts` → `Foo.test.ts`。

---

## §A — Phase A 驗證

**單元:** `visibilityObserver.test.ts`(參考實作 §9.3,20 個)

**突變:** M1–M4

**瀏覽器冒煙**(每一項在 Phase A 之前都會失敗):

| # | 步驟 | 期望 |
|---|---|---|
| A-1 | 捲到房間頂端,再捲回底部 | 途中經過的訊息**會**被翻譯 |
| A-2 | 關閉自動翻譯 → 重新打開 | 當下畫面上的訊息開始翻譯,不需先捲動 |
| A-3 | 分頁切背景 10s → 切回 | 畫面上未翻譯的訊息開始翻譯 |
| A-4 | 快速捲動 100 則 | 佇列峰值降到可視訊息數量的量級 |

**要記錄的數字:** 佇列峰值、`result=idle` 比例。這兩個數字是後面兩相的基準。

---

## §B — Phase B 驗證

**單元:** `decisionLog.test.ts`(參考實作 §9.6,15 個)

其中這一條**不可刪、不可放寬**:

```ts
test('never prints message content', () => {
  const log = createDecisionLog({ printing: false });
  const record = log.emit('settle', 'm1', {
    text: 'SECRET-BODY',
    translatedText: 'SECRET-TRANSLATION',
    ok: true,
  });
  const line = formatRecord(record);
  expect(line).not.toContain('SECRET-BODY');
  expect(line).not.toContain('SECRET-TRANSLATION');
  expect(line).toContain('ok=true');
});
```

**行為驗證:** Phase B 是零行為變更。佇列深度、翻譯結果、時序都必須與 A8
量到的數字相同。有差異就是接線接錯了。

---

## §C — Phase C 驗證

**單元:** `store.test.ts`(參考實作 §9.2,55 個)

**突變:** M13、M14

**逐列走查** —— 對著 `03-phase-C-store.md` §C.3 那張八列的表,逐條在程式碼裡
確認 `markSent` 與 `settle` 各被呼叫恰好一次。這一項用讀的,不要靠測試涵蓋率,
因為漏掉的路徑通常就是測試也沒想到的那條。

**瀏覽器冒煙:**

| # | 步驟 | 期望 |
|---|---|---|
| C-1 | 對排隊中的訊息按「查看原文」 | 它**不會**在稍後被翻譯 |
| C-2 | 手動翻譯 → 查看原文 → 再手動翻譯 | 與整合前完全一致 |
| C-3 | 讓一則入隊後立刻捲走 | `timeline(id)` 出現 `drop reason=left-viewport` |
| C-4 | DevTools 把 IndexedDB 配額設到極小,觸發翻譯 | 訊息仍顯示**已翻譯**;`timeline` 出現 `violation reason=cache-write-failed` |

C-4 是缺陷 #15 的直接驗證,也是最容易被跳過的一項。

---

## §D — Phase D 驗證

**單元:** `autoPolicy.test.ts`(參考實作 §9.4,43 個)
**整合:** `autoTranslate.integration.test.ts`(§9.8,16 個)
**混沌:** `stress.integration.test.ts`(§9.9,種子 11/47/83,各 220 步)
**突變:** M5–M12

**瀏覽器冒煙:**

| # | 步驟 | 期望 |
|---|---|---|
| D-1 | 捲動後停下 | 畫面上 12 則在約 5s 內全部翻完(首則 ~1.1s) |
| D-2 | 快速捲動 100 則 | 佇列深度不超過 50;停下後畫面上全部翻完 |
| D-3 | 斷開後端,持續看著畫面 | 5 次失敗後停止發送;`log.records()` **不會**每秒增加十幾筆 |
| D-4 | 上一步之後恢復後端,等 30s | 自動翻譯恢復 |
| D-5 | 背景分頁 | 完全不發請求 |

D-3 是缺陷 #16、D-4 是缺陷 #14 的直接驗證。D-4 失敗代表 probe token 洩漏了 ——
**這正是整合前必須修好參考實作的原因**,它的失效形狀與 Phase A 之前的症狀
無法區分。

---

## 突變清單(14 個)

把以下 bug 逐一植入,**你的套件必須每一個都變紅**;活下來的突變 = 假覆蓋。

| # | 檔案 | 突變 | 重現的缺陷 |
|---|---|---|---|
| M1 | observer | `markHidden` 不 `cancelDwell` | 捲過去照樣翻 |
| M2 | observer | `markVisible` 不查 `visibleIds.has` | re-render 重啟已服完的 dwell |
| M3 | observer | rootMargin 不夾 `Math.max(0,·)` | 負 margin 全域無交集 |
| M4 | observer | `centreOf` 永遠走快取 fallback | 排序退化成到場順序 |
| M5 | policy | `recordFailure` 不豁免 `bad_request` | 一則壞訊息關掉整個功能 |
| M6 | policy | `circuitBlocks` 不查 `probing` | 恢復瞬間全體 probe 踩踏 |
| M7 | policy | 不等 `result.sent` 直接計費 | 幽靈請求吃光 RPM 預算 |
| M8 | policy | sweep 不查 `status !== 'idle'` | 無限重試 rejected body |
| M9 | policy | sweep 不過 auto/active 靜默 gate | 每秒 log churn |
| M10 | policy | probe token 在述詞裡佔用 | **缺陷 14** — 一次被拒的 probe 永久卡住斷路器 |
| M11 | policy | `onCandidate` catch 不歸還 token | **缺陷 14**(丟例外那條) |
| M12 | policy | sweep 不過 circuit/rate 靜默 gate | **缺陷 16** |
| M13 | store | 快取寫入失敗往外丟 | **缺陷 15** |
| M14 | store | dedupe 路徑不呼叫 `onSent` | **缺陷 17** |

前九個釘住「這個判斷有沒有被做」,後五個釘住「做完之後有沒有收乾淨」。

> **這個分野本身就是教訓。** 參考實作原本只有前九個,而缺陷 14 存在時
> **9/9 照樣全殺、完成清單照樣全綠** —— M6 驗證的是 `probing` 有被檢查,
> 沒有任何突變驗證它在所有路徑上被歸還。新增一個判斷時,一併問「它持有的
> 東西誰負責放掉」。

腳本見參考實作 §9.11(已含 14 個)。實作要點:對原始檔做字串替換 → 跑套件 →
斷言紅 → **用備份檔還原,不要用 `git checkout`**(會吃掉未提交變更)。

---

## 完成清單

- [ ] A8 / C13 / D10 三個量測點的數字都有記錄
- [ ] 突變 14/14 全殺
- [ ] 混沌測試三種子全綠(三連跑穩定)
- [ ] 捲動停下後畫面上 12 則約 5s 內全部翻完
- [ ] 斷路器打開期間決策 log 不churn;恢復後 30s 內自動翻譯回來
- [ ] 佇列峰值 ≤ `MAX_QUEUE_LENGTH`
- [ ] `result=idle` 歸零
- [ ] 手動翻譯與「查看原文」行為與整合前完全一致
- [ ] 背景分頁不發請求
- [ ] `__translate.timeline(id)` 能解釋任一則訊息的完整決策路徑

---

## 卡住的時候

`__translate.timeline('<messageId>')` 是唯一的起點。它會列出那一則從
`observe` 到 `settle` 的每一步與相對毫秒數。

常見形狀:

| timeline 停在 | 意思 | 看哪裡 |
|---|---|---|
| 沒有任何記錄 | 元素從未註冊 | ref callback / `observe()` 呼叫點 |
| 停在 `observe` | IO 從未回報交集 | `rootMargin`、`root` 設錯,或元素高度為 0 |
| 停在 `visible` | dwell 被取消 | 使用者捲太快,或 re-render 打斷(A1 應已修好) |
| 停在 `dwell` | policy 擋掉了 | 下一筆 `skip` 的 `reason` |
| `skip reason=circuit-open` 反覆出現 | 斷路器沒關回去 | probe token 洩漏(M10/M11) |
| 停在 `enqueue` | 佇列裡等不到 | 之後應有 `drop` 或 `send`;都沒有代表 job 被靜默丟棄 |
| `settle ok=false` 但後端正常 | 本地故障被誤判 | 快取寫入(M13) |
