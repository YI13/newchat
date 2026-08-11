# 自動翻譯管線 — 內外整合交接包

把 `docs/handoff-translation-pipeline-v2.md`(以下稱**參考實作**)整合進現有
的自動翻譯程式碼。本包不是那份文件的替代品,而是它的**移植路線圖**:參考實作
講「這段程式碼為什麼長這樣」,本包講「在你們的架構裡要換掉什麼、換的順序、
以及換完怎麼確認」。

## 命名約束(不可放寬)

任何檔案、commit message、程式註解、issue 留言中,一律使用中性名稱
**「翻譯服務 / Translation API」**。不得出現公司內部的產品代號、系統代號、
內部網域或內部工具名。這條先於本包其他所有指示。

## 怎麼讀

一次只讀你正在做的那一份。每份都是自足的 —— 不需要把整包載進 context。

| 檔案 | 什麼時候讀 | 內容 |
|---|---|---|
| `00-assessment.md` | **開工前讀一次** | 現況三個決定性缺陷、症狀對應、介面落差表。回答「為什麼要照這個順序做」 |
| `01-phase-A-observer.md` | 做 Phase A 時 | `visibilityTracker.ts` 完整替換碼 + 相容包裝層 + 呼叫點改動 |
| `02-phase-B-decisionlog.md` | 做 Phase B 時 | `decisionLog.ts` 完整程式碼 + 接線點 |
| `03-phase-C-store.md` | 做 Phase C 時 | `ensureForView` 合約、`sent`/`done` 接線、pump 改動、刪除 pump 斷路器 |
| `04-phase-D-policy.md` | 做 Phase D 時 | `autoPolicy.ts` 完整替換碼 + 四個 adapter |
| `05-subtasks.md` | **開工前讀一次,之後每完成一項回來勾** | A1–D10 子任務、相依圖、每項的驗收條件 |
| `06-verification.md` | 每個 Phase 結束時 | 該 Phase 的測試、突變清單、瀏覽器冒煙步驟 |
| `07-fix-registry-ownership.md` | **Phase A 已完成、發現註冊表失明時** | 修正包:`destroy()` 的歸屬。兩個缺陷、三步修正、三條測試,全含程式碼 |

## 相位總覽

```
Phase A ──► Phase B ──► Phase C ──► Phase D
 觀察器      決策 log     store 邊界    policy
 (3 檔)      (1 檔)      (1 檔)       (3 檔)

A 和 B 之間沒有真相依,但 B 先做完會讓 C/D 可驗證。
C 必須在 D 之前。D 不可拆成兩次上線。
```

每個 Phase 都能單獨上線、單獨觀察。**順序不可調換**,理由寫在各檔開頭。

## 為什麼分四次而不是一次重寫

Phase A 只換觀察器。如果症狀在 A 之後就消失大半,你就知道根因在觀察器,
不在你們花了八輪修的那些競態。如果一次全換,無論成功或失敗你都拿不到這個
答案 —— 成功了不知道是哪一項生效,失敗了要在三千行的 diff 裡找。

已經在錯的層修了八輪之後,**可歸因性本身就有價值**。

## 不要做的事

1. **不要只採用 `maxQueueLength` 而不採用 `recheckVisible`。** 被上限擋掉的
   訊息不會移動,觀察器一個可見週期只發一次候選,所以它永遠不會有第二次
   機會。參考實作量到的是 12 則裡只有 2 則被翻譯。兩個一起上,或都不上。
2. **不要讓兩個斷路器同時存在。** Phase C 沒刪掉 pump 裡的,就不要進 Phase D。
3. **不要把參考實作的 `TranslationContext.jsx` 當作狀態分發機制搬過來。**
   它用 React Context,你們用 zustand。Context 一變動會讓所有 consumer 重新
   render;一個房間 100 則訊息、佇列每次吐 2 則,這個差別是實打實的。搬它的
   **組裝順序**,狀態留在 zustand。
4. **不要清空 `idbTranslationCache`。** 裡面的 intent 記錄是使用者按過的
   「查看原文」,清掉就是丟使用者資料。改用 adapter,見 `03-phase-C-store.md`。
5. **不要在 `observe()` 裡用 `dwellTimers.has(id)` 當冪等守衛。** 正解是綁在
   元素身分上,理由見 `01-phase-A-observer.md`。
6. **`destroy()` 只在整個聊天介面卸載或登出時呼叫。** 換房間不行,切開關也不行 ——
   註冊表歸掛載中的訊息元件所有(它們自己 `observe`/`unobserve`),父層從
   `useEffect` 清它會 race 掉剛掛載的列:ref 在 layout phase 附加,父層 effect 在
   passive phase 才跑。已經照舊版做過的話,修正包在 `07-fix-registry-ownership.md`。

## 參考實作的四個缺陷已經修好

參考實作原本帶有四個缺陷(編號 14–17,見該文件 §3),失效形狀都是「自動翻譯
靜默停止」—— 與你們現在在查的症狀無法區分。**它們已經在同一份文件裡修好並
補上回歸測試**,突變集從 9 個增加到 14 個。你拿到的 `docs/handoff-translation-pipeline-v2.md`
是修正後的版本,逐字採用即可。

如果你手上的副本 §3 缺陷表只到 13 條、或 §8.2 寫「9 個突變」,那是舊版,
**停下來換成最新版再開始**。
