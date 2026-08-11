# 翻譯失敗的使用者提示 — 兩個 error code

> 手動翻譯在後端限流或不可用時,要告訴使用者「稍後再試」。自動翻譯不做任何提示。
> 看起來是加兩行文案,實際上有一個先決條件和一個對應鍵的選擇會決定它到底會不會生效。

**一項功能,兩個 code,四處要改,約六十行。**

---

## 要做的事

| `code` | 使用者看到 |
|---|---|
| `too_many_requests` | Translation service is busy, retry later |
| `unavailable` | Translation service is unavailable, retry later |

**只有手動翻譯**。自動翻譯不出任何提示。

---

## 先決條件:你們的 store 大概不會 reject

這是最容易讓整件事靜靜不生效的一點,先確認再動手。

參考實作的 store 在翻譯失敗時**不丟例外**,而是 resolve 一個結果描述:

```ts
// runJob 的 finally
item.settle(outcome)   // { ok: false, error } — resolve,不是 reject
```

理由寫在原始碼註解裡:失敗的翻譯是一個 UI 狀態(訊息旁顯示錯誤),不是呼叫端要
去 catch 的例外。

**後果:`.catch()` 永遠不會執行。** 如果照直覺寫成

```ts
try {
  await store.translate(id, { ... })
} catch (err) {
  showToast(...)          // ← 這裡永遠到不了
}
```

程式不會報錯,測試如果也用同一個假設寫就會一起綠,而使用者永遠看不到提示。

先跑這個確認你們是哪一種:

```ts
const outcome = await store.translate('m1', { /* 會失敗的參數 */ })
console.log('settled with', outcome)   // 有印出來 → resolve 型,往下照做
                                        // 沒印出來、跳到 catch → 你們改成 throw 了
```

**如果是 resolve 型**(參考實作的行為),往下照做。
**如果你們移植時改成 throw**,下面 F3 的接法改成 `try/catch`,其餘不變 —— 但要注意
`aborted` 的判斷仍然必須保留,理由見 F3。

---

## 對應鍵:用 `code`,不要用 `reason`

後端這兩個失敗會帶這樣的信封:

```json
{ "code": "too_many_requests", "reason": "rate_limited",        "error": "translation rate limited" }
{ "code": "unavailable",       "reason": "upstream_unavailable", "error": "translation upstream unavailable" }
```

直覺會想把 `reason` 加進既有的全域文案表(參考實作裡叫 `REASON_COPY`,你們可能有
同等的一張)。**不要。** 兩個獨立的理由:

### 1. `upstream_unavailable` 不是翻譯專屬的

這個 reason 在共用的錯誤目錄裡已經有其他服務在發:

- auth-service —— 連不到 botplatform 驗證 session token
- portal-service —— 連不到 home-site 的 botplatform
- user-service —— 這個站台沒有設定 SSO

那張表是**全域、以 reason 為鍵**的。加一筆
`upstream_unavailable → "Translation service is unavailable"` 進去,上面三個情境
的使用者也會看到「翻譯服務無法使用」—— 一個和他們遇到的事情完全無關的句子。

動手前先自己查一次:

```bash
grep -rn "upstream_unavailable\|rate_limited" src/
```

有任何一筆落在翻譯以外的地方,這條就成立。

### 2. `reason` 會被細分,`code` 不會

同一份錯誤目錄裡,bot-platform 的 429 用的是
`rate_limited_caller` / `rate_limited_global` 兩個值,不是單一的 `rate_limited`。
翻譯後端之後很可能走同一條路。

以 reason 為鍵的話,那天到來時文案會**靜靜地消失**(查表落空 → 退回顯示原始英文
訊息),沒有任何東西會失敗。以 `code` 為鍵則不受影響。

**結論:文案表放在翻譯自己的模組裡,以 `code` 為鍵。** 後端 reason 叫什麼都不影響。

---

## 修正

### F1 — 翻譯專屬的文案表

**新檔案:** 翻譯模組底下(與 store / policy 同層)

```ts
// 以 errcode 的 `code` 為鍵,不是 `reason`。理由有二:這兩個失敗帶的 reason
// (rate_limited / upstream_unavailable)不是翻譯專屬 —— upstream_unavailable
// 在共用目錄裡已經被 auth-service 和 portal-service 使用,那裡顯示「翻譯服務
// 無法使用」是錯的;而後端隨時可能把 rate_limited 細分成 rate_limited_caller,
// 以 reason 為鍵會讓文案靜靜消失。code 是信封裡穩定的那一半。
//
// 刻意不加進全域的 reason 文案表:那張表是全域的,一筆就會改寫其他服務的錯誤。

const COPY: Record<string, string> = {
  too_many_requests: 'Translation service is busy, retry later',
  unavailable: 'Translation service is unavailable, retry later',
}

/**
 * 翻譯失敗時要給使用者的提示,不需要提示時回傳 null。
 *
 * null 涵蓋的比看起來多。`internal` 和 `bad_request` 使用者無從應對;`timeout`
 * 是 store 自己的期限到期,不是後端說自己不可用 —— 把兩者混為一談,等於在使用者
 * 連線卡住時告訴他「服務掛了」。這些情況仍然顯示訊息旁的錯誤標記,提示只留給
 * 使用者「等一下再按一次」真的有用的那兩種。
 */
export function translationErrorToast(err: unknown): string | null {
  const code = (err as { code?: string } | null)?.code
  if (!code) return null
  return COPY[code] ?? null
}
```

`!code` 這一行同時吃掉 abort(`AbortError` 沒有 `code`)和任何非信封的例外。

### F2 — 提示的顯示機制

先確認你們有沒有。參考實作原本**沒有** —— 唯一的「提示」是一處 `window.alert`。

```bash
grep -rniE "toast|snackbar|notification" src/ | grep -v node_modules | head
```

**已經有的話**,直接用你們的,跳到 F3。

**沒有的話**,下面是一個夠用的最小版本。重點在**訊息文字即身分**:同一句提示還在
畫面上時再次觸發,是刷新它的計時器而不是疊出第二個。後端還沒恢復時使用者會連按
幾次,那是同一件事,應該讀起來也是同一件事。

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

export const TOAST_DURATION_MS = 5000

const NOOP = () => {}

// 預設值而不是丟例外的守衛:在 provider 外算繪的畫面(測試、獨立預覽)應該安靜
// 地不顯示,而不是整個掛掉。
const ToastContext = createContext<{ show: (m: string) => void; dismiss: (m: string) => void }>({
  show: NOOP,
  dismiss: NOOP,
})

export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<string[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((message: string) => {
    const timer = timers.current.get(message)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.current.delete(message)
    }
    setMessages((prev) => prev.filter((m) => m !== message))
  }, [])

  const show = useCallback(
    (message: string) => {
      if (!message) return
      const running = timers.current.get(message)
      if (running !== undefined) clearTimeout(running)
      timers.current.set(message, setTimeout(() => dismiss(message), TOAST_DURATION_MS))
      setMessages((prev) => (prev.includes(message) ? prev : [...prev, message]))
    },
    [dismiss],
  )

  // 計時器活得比 React state 久,卸載時不清會讓它們對著已死的 setter 觸發。
  const pending = timers.current
  useEffect(
    () => () => {
      pending.forEach(clearTimeout)
      pending.clear()
    },
    [pending],
  )

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {messages.length > 0 && (
        <div className="toast-host">
          {messages.map((message) => (
            <div key={message} className="toast" role="status">
              <span className="toast-message">{message}</span>
              <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(message)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}
```

樣式自理,`.toast-host` 用 `position: fixed` + `pointer-events: none`,`.toast` 本身
`pointer-events: auto`,否則它會擋住底下的點擊。

> **注意:狀態用 React state 是可以的,提示不是熱路徑。** 這一項不適用「狀態留在
> zustand」那條約束 —— 那條是為了避免一個房間上百則訊息在佇列每次吐出時全部重繪。
> 提示一次最多一兩則、幾秒一次,沒有那個問題。真要放進 zustand 也行,行為要求相同。

### F3 — 只在手動路徑觸發

**檔案:** 使用者按「翻譯」時實際呼叫 store 的那一處

```ts
const { show } = useToast()

const translate = useCallback(
  (message, roomId) => {
    if (!store) return Promise.resolve()
    return store
      .translate(message.id, {
        roomId,
        text: message.content ?? '',
        targetLang,
        srcVersion: message.editedAt ?? 0,
        origin: 'manual',
      })
      .then((outcome) => {
        // store 是 settle 不是 throw,所以這裡是結果唯一可見的地方 —— 而且刻意
        // 是手動的那一處。自動失敗保持安靜:沒有人要求它,而且一個後端掛掉會
        // 讓畫面上每一則訊息各發一次提示。abort 是使用者自己造成的(按了查看
        // 原文、或新的請求取代了這一個),它不代表服務有任何問題。
        if (outcome && !outcome.ok && !outcome.aborted) {
          show(translationErrorToast(outcome.error))
        }
        return outcome
      })
  },
  [store, targetLang, show],
)
```

三個守衛都是必要的,少一個就會在錯的時機發提示:

| 守衛 | 沒有它會怎樣 |
|---|---|
| `outcome &&` | store 不存在時(provider 外)`.then` 拿到 undefined |
| `!outcome.ok` | 成功也發提示 |
| `!outcome.aborted` | 使用者按「查看原文」取消掉自己的請求,卻收到「服務無法使用」 |

`show(null)` 是安全的 —— F2 的 `show` 第一行就擋掉空值,所以不需要在這裡再判一次。

**如果你們的 store 改成 throw 了**,接法換成:

```ts
try {
  return await store.translate(...)
} catch (err) {
  if (err?.name !== 'AbortError') show(translationErrorToast(err))
  throw err
}
```

`AbortError` 的判斷不能省 —— 理由和上表第三列一樣。

### F4 — 掛上 provider

如果 F2 是新加的,把 `ToastProvider` 掛在夠高的地方,至少要包住聊天介面。掛在
連線 / 登入判斷的**外面**,提示才不會因為連線狀態變動而消失。

---

## 不要做的事

1. **不要把這兩句加進全域的 reason 文案表。** 理由見上面「對應鍵」一節 ——
   `upstream_unavailable` 已經被其他服務使用。

2. **不要讓自動路徑發提示。** 一個後端掛掉,畫面上有幾則訊息就會發幾次。這也是
   需求明講不要處理的部分。

3. **不要為了「讓使用者知道」而把 `timeout` 也接上「服務無法使用」。**
   那是 store 自己的期限(參考實作 15 秒)到期,最常見的成因是使用者自己的連線,
   不是後端。訊息旁的錯誤標記已經傳達了「這一則沒翻成功」。

4. **不要因為要顯示提示就把 429 加進可重試的集合。** 目前只有 `unavailable` 可重試。
   對著限流重試只會讓限流延長,而且手動路徑跑的是完整的重試階梯,使用者會先等完
   退避才看到提示。

5. **不要用 `error` 訊息字串來判斷。** 那是給人看的,措辭隨時會變。只認 `code`。

---

## 要補的測試

前兩條在修正前必須是紅的。第三、四條在修正前後都綠 —— 它們存在是為了擋住之後
有人「順手」把提示接到所有失敗上,或接到自動路徑上。

```ts
describe('translationErrorToast', () => {
  test.each([
    ['too_many_requests', 'Translation service is busy, retry later'],
    ['unavailable', 'Translation service is unavailable, retry later'],
  ])('%s 給出可以行動的提示', (code, copy) => {
    expect(translationErrorToast(envelope(code))).toBe(copy)
  })

  test('由 code 決定,不是 reason', () => {
    // 後端可以把 rate_limited 細分,或整個不帶 reason,文案都必須還在。
    expect(translationErrorToast(envelope('too_many_requests', 'rate_limited_caller')))
      .toBe('Translation service is busy, retry later')
    expect(translationErrorToast(envelope('too_many_requests')))
      .toBe('Translation service is busy, retry later')
  })

  test.each([['internal'], ['bad_request'], ['timeout'], ['not_found']])(
    '%s 不發提示',
    (code) => {
      expect(translationErrorToast(envelope(code))).toBeNull()
    },
  )
})

describe('提示的觸發時機', () => {
  test('手動失敗會提示', async () => {
    renderManual(async () => { throw envelope('too_many_requests') })
    await clickTranslate()
    expect(screen.getByRole('status')).toHaveTextContent('busy, retry later')
  })

  test('手動成功不提示', async () => {
    renderManual(async () => ({ translatedText: 'x', targetLang: 'ja' }))
    await clickTranslate()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('自動失敗保持安靜', async () => {
    // 同一個 outage,手動會提示、自動不會 —— 這才是這條測的東西。
    const translate = vi.fn(async () => { throw envelope('unavailable') })
    renderAutoRow(translate)
    await showAndDwell('m1')

    expect(translate).toHaveBeenCalled()          // 確認它真的跑了
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('取消不提示', async () => {
    // 使用者按「查看原文」中止自己的請求,不該被告知服務有問題。
    renderManual(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e })
    await clickTranslate()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
```

「自動失敗保持安靜」那條裡的 `expect(translate).toHaveBeenCalled()` 不要省。沒有它,
一個根本沒送出請求的 bug 也會讓這條測試通過,而它宣稱測的是「送了、失敗了、但沒提示」。

如果你們用 React state 做提示,注意 settle 之後的 setState 落在 React 批次之外,
測試要把整趟包進 `act(async () => { ... })`,否則會噴 act 警告。

---

## 驗收

| # | 步驟 | 期望 |
|---|---|---|
| 1 | 讓後端回 429(或用假的注入),手動按一則訊息的「翻譯」 | 出現 busy 提示;訊息旁也有錯誤標記 |
| 2 | 讓後端不可用,手動按「翻譯」 | 出現 unavailable 提示 |
| 3 | 同一狀態下連按三次 | **只有一則**提示,計時器重新開始,不是疊三則 |
| 4 | 同一狀態下開著自動翻譯捲過十則訊息 | **完全沒有提示**;訊息旁有錯誤標記 |
| 5 | 送一則空訊息或不支援的語言(`bad_request`) | 沒有提示,只有訊息旁的錯誤標記 |
| 6 | 手動按下後立刻按「查看原文」 | 沒有提示 |

第 3、4、6 項是這件事真正會出錯的地方,前兩項只是確認接線。

---

## 完成清單

- [ ] 已確認 store 是 settle 型還是 throw 型,並選了對應的 F3 接法
- [ ] `grep -rn "upstream_unavailable\|rate_limited" src/` 跑過,確認全域文案表沒有被污染
- [ ] F1 的文案表以 `code` 為鍵,且**不在**全域 reason 表裡
- [ ] F2:沿用既有提示機制,或加了新的且具備「相同訊息刷新而非疊加」
- [ ] F3 的三個守衛都在(`outcome &&`、`!ok`、`!aborted`)
- [ ] 自動路徑沒有任何提示程式碼
- [ ] `isRetryable` 沒有被改動 —— 429 仍然不可重試
- [ ] 前兩條測試在修正前是紅的;後四條在修正前後都綠
- [ ] 上表六項瀏覽器冒煙通過,特別是第 3、4、6 項

---

## 一件要回報給後端的事

共用的錯誤目錄文件裡目前**沒有翻譯 RPC 的章節** —— 整份文件搜不到這個 subject。
這兩個 code 上線時要補一節,否則 reason 目錄和實際發出的內容會持續對不上,下一個
接這塊的人會像這次一樣需要自己反推。

順帶問一句(前幾輪問過還沒有答案):**你們現在跑的是 stub 還是真後端?**
如果是 stub,上面第 1、2 項驗收要先確認 stub 有沒有這兩個模式 —— 參考實作的 stub
只有 `unavailable` 和 `internal`,沒有 429,需要自己補一個模式才驗得到。
