# Phase A — 換掉 `visibilityTracker.ts`

**耦合最低、回報最高。** 一次修掉 `00-assessment.md` 的 B1/B2/B3 三個決定性
缺陷。動三個檔案:`visibilityTracker.ts` 整檔替換、`autoPolicy.ts` 的 `reset`
呼叫、`store.ts` 三行排序,外加元件層兩個 effect 的拆分(§A.4)。不碰快取、
不碰佇列語意、不碰 policy 邏輯。

做完之後**先上線量測再往下走**。這是整個計畫裡唯一能單獨回答「根因是不是在
觀察器」的一步。

---

## A.1 完整替換:`visibilityTracker.ts`

整檔覆蓋。下面就是要貼進去的內容,不要參考後重寫 —— 每一段註解對應一個實際
發生過的缺陷。

```ts
/**
 * Which messages is the user actually reading?
 *
 * Three pieces of state, deliberately not merged:
 *
 *   elements    — the registry. observe()/unobserve() own it. Membership
 *                 means "this message is mounted", nothing about visibility.
 *   visibleIds  — the visible set. ONLY the IntersectionObserver callback
 *                 writes to it. Registering an element must never put it
 *                 here, or the dwell filter is bypassed for every rendered
 *                 message and the module merely looks like it works.
 *   dwellTimers — pending candidates. A timer that fires means the user
 *                 stayed with the message rather than scrolling past it.
 *
 * Element identity comes from the observe() call and lives in a WeakMap.
 * Reading it back off a data-* attribute makes the module silently skip any
 * element the renderer forgot to annotate — a failure that presents as
 * "translation just doesn't happen".
 */
import { DWELL_MS, PREFETCH_MARGIN_PX } from './constants';

export interface VisibilityObserverConfig {
  dwellMs: number;
  prefetchMarginPx: number;
}

export interface VisibilityObserverApi {
  readonly config: VisibilityObserverConfig;
  /** Live set — the IntersectionObserver callback is its only writer. */
  readonly visibleIds: ReadonlySet<string>;
  /** Mounted message ids. Paired with visibleIds, this is what makes
   *  "visible but no longer mounted" checkable from outside. */
  registeredIds(): string[];
  observe(id: string, element: Element): void;
  unobserve(id: string): void;
  /** Tear the observer down and rebuild it over the SAME registry. For a
   *  scroll-container change, or a backgrounded tab coming back. */
  rebuild(): void;
  setRoot(next: Element | null): void;
  setViewportCentre(value: number | null): void;
  byDistanceFromCentre(ids: Iterable<string>): string[];
  /** Drop everything, including the registry. ONLY for the whole chat surface
   *  unmounting, or logout — never for a room switch or the feature toggle. */
  destroy(): void;
}

export function createVisibilityObserver({
  onCandidate,
  root = null,
  onEvent,
  ...options
}: {
  onCandidate?: (id: string) => void;
  root?: Element | null;
  /** Phase B wires the decision log in here. Until then it stays undefined. */
  onEvent?: (kind: string, id: string, fields?: Record<string, unknown>) => void;
} & Partial<VisibilityObserverConfig> = {}): VisibilityObserverApi {
  const config: VisibilityObserverConfig = {
    dwellMs: DWELL_MS,
    prefetchMarginPx: PREFETCH_MARGIN_PX,
    ...options,
  };

  const elements = new Map<string, Element>();
  const elementIds = new WeakMap<Element, string>();
  const visibleIds = new Set<string>();
  const dwellTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const centres = new Map<string, number>();

  let currentRoot: Element | null = root;
  let observer: IntersectionObserver | null = null;
  let viewportCentre: number | null = null;

  const emit = (kind: string, id: string, fields?: Record<string, unknown>) =>
    onEvent?.(kind, id, fields);

  function rootMargin(): string {
    // Positive only. A negative margin shrinks the intersection box, and on a
    // typical viewport that drives the effective height below zero, so
    // nothing ever intersects.
    const margin = Math.max(0, config.prefetchMarginPx);
    return `${margin}px 0px ${margin}px 0px`;
  }

  function handleEntries(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      const id = elementIds.get(entry.target);
      if (id === undefined) continue;

      if (entry.isIntersecting) {
        const rect = entry.boundingClientRect;
        if (rect) centres.set(id, rect.top + rect.height / 2);
        markVisible(id);
      } else {
        markHidden(id);
      }
    }
  }

  function ensureObserver(): IntersectionObserver {
    if (observer) return observer;
    observer = new IntersectionObserver(handleEntries, {
      root: currentRoot,
      rootMargin: rootMargin(),
      threshold: 0,
    });
    return observer;
  }

  function markVisible(id: string) {
    if (visibleIds.has(id)) return;
    visibleIds.add(id);
    emit('visible', id, { visible: visibleIds.size });

    if (config.dwellMs <= 0) {
      emit('dwell', id, { dwellMs: 0 });
      onCandidate?.(id);
      return;
    }
    const timer = setTimeout(() => {
      dwellTimers.delete(id);
      emit('dwell', id, { dwellMs: config.dwellMs });
      onCandidate?.(id);
    }, config.dwellMs);
    dwellTimers.set(id, timer);
  }

  function cancelDwell(id: string) {
    const timer = dwellTimers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    dwellTimers.delete(id);
  }

  function markHidden(id: string) {
    const wasVisible = visibleIds.delete(id);
    centres.delete(id);
    // Whether a dwell was pending is the interesting half: it separates "the
    // user scrolled past too fast" from "the message was already a candidate".
    const hadPendingDwell = dwellTimers.has(id);
    cancelDwell(id);
    if (wasVisible) {
      emit('hidden', id, { cancelledDwell: hadPendingDwell, visible: visibleIds.size });
    }
  }

  function observe(id: string, element: Element) {
    if (!element) return;
    // Idempotent: a re-render that re-registers the same element must not
    // restart a dwell the user has already partly served. Keyed on element
    // identity, NOT on whether a timer is pending — a genuine element swap
    // still has to re-register.
    if (elements.get(id) === element) {
      ensureObserver().observe(element);
      return;
    }
    if (elements.has(id)) unobserve(id);

    elements.set(id, element);
    elementIds.set(element, id);
    ensureObserver().observe(element);
  }

  function unobserve(id: string) {
    const element = elements.get(id);
    if (!element) return;
    // Detach from the observer BEFORE dropping the registry entry, or the
    // observer keeps a strong reference to a node that is already gone.
    observer?.unobserve(element);
    elementIds.delete(element);
    elements.delete(id);
    markHidden(id);
  }

  function rebuild() {
    for (const id of [...dwellTimers.keys()]) cancelDwell(id);
    visibleIds.clear();
    centres.clear();

    observer?.disconnect();
    observer = null;

    if (elements.size === 0) return;
    const next = ensureObserver();
    for (const element of elements.values()) next.observe(element);
  }

  function setRoot(nextRoot: Element | null) {
    if (currentRoot === nextRoot) return;
    currentRoot = nextRoot;
    rebuild();
  }

  function setViewportCentre(value: number | null) {
    viewportCentre = value;
  }

  function centreOfViewport(): number {
    if (viewportCentre !== null) return viewportCentre;
    const rect = currentRoot?.getBoundingClientRect?.();
    if (rect) return rect.top + rect.height / 2;
    return (globalThis.innerHeight ?? 0) / 2;
  }

  /**
   * Where a row is right now.
   *
   * Measured live rather than read from `centres`, because the cache is only
   * written when an element CROSSES the threshold: a row that entered at the
   * bottom edge and has since scrolled to the middle delivers no further
   * entries, so its cached position is wherever it came in. Ranking on that
   * means ranking on arrival order, not on what the user is looking at.
   *
   * Called at pick time — once per queue drain, not per scroll event.
   */
  function centreOf(id: string): number | undefined {
    const rect = elements.get(id)?.getBoundingClientRect?.();
    // An all-zero box means no layout: a detached element, or jsdom. The
    // crossing position is then the best answer available.
    if (rect && (rect.height > 0 || rect.top !== 0)) return rect.top + rect.height / 2;
    return centres.get(id);
  }

  /** Rank ids by how close they are to the middle of what the user is looking
   *  at. Unsigned: a message just above the centre is as relevant as one just
   *  below it. */
  function byDistanceFromCentre(ids: Iterable<string>): string[] {
    const centre = centreOfViewport();
    // Measured once per call rather than inside the comparator: a sort makes
    // O(n log n) comparisons, and reading layout in each of them would turn
    // one flush into hundreds.
    const distances = new Map(
      [...ids].map((id) => [id, Math.abs((centreOf(id) ?? Infinity) - centre)]),
    );
    return [...ids].sort((a, b) => distances.get(a)! - distances.get(b)!);
  }

  function destroy() {
    for (const id of [...dwellTimers.keys()]) cancelDwell(id);
    observer?.disconnect();
    observer = null;
    elements.clear();
    visibleIds.clear();
    centres.clear();
  }

  return {
    config,
    visibleIds,
    registeredIds: () => [...elements.keys()],
    observe,
    unobserve,
    rebuild,
    setRoot,
    setViewportCentre,
    byDistanceFromCentre,
    destroy,
  };
}
```

---

## A.2 相容包裝層(同檔追加)

現有呼叫端(`autoPolicy.ts`、`store.ts` 的 pump、訊息元件的 ref callback)
import 的是模組單例 `visibilityObserver`。包裝層讓那些 import **一行都不用改**。

```ts
/* ------------------------------------------------------------------ *
 * Module singleton + the surface the existing call sites already use.
 * Phase D replaces the subscriber list with direct injection; until then
 * this keeps the blast radius of Phase A at two files.
 * ------------------------------------------------------------------ */

const candidateFns: Array<(id: string) => void> = [];

const impl = createVisibilityObserver({
  onCandidate: (id) => {
    // Copied before iterating: a subscriber that unsubscribes itself while
    // being notified would otherwise skip the next one.
    for (const fn of [...candidateFns]) fn(id);
  },
});

export const visibilityObserver = {
  get visibleIds(): ReadonlySet<string> {
    return impl.visibleIds;
  },
  registeredIds: () => impl.registeredIds(),

  onCandidate(fn: (id: string) => void): () => void {
    candidateFns.push(fn);
    return () => {
      const idx = candidateFns.indexOf(fn);
      if (idx !== -1) candidateFns.splice(idx, 1);
    };
  },

  observe: (id: string, el: Element) => impl.observe(id, el),

  /** The second argument is accepted and ignored: the registry knows which
   *  element belongs to this id, and trusting the caller's copy is how a
   *  stale element ends up un-observed while the live one keeps firing. */
  unobserve: (id: string, _element?: Element) => impl.unobserve(id),

  /**
   * ⚠️ SEMANTICS CHANGED FROM THE OLD MODULE — read before wiring.
   *
   * The old reset() meant "forget everything" and was called on room switch
   * and from startAutoPolicy(). It disconnected the observer and cleared the
   * registry with nothing to re-observe, which is why turning auto-translate
   * on blinded the observer to every already-mounted message (defect B2).
   *
   * Here the two meanings are separate:
   *   destroy() — forget everything, including the registry. ONLY for the
   *               whole chat surface unmounting, or logout. Not for a room
   *               switch and not for the feature toggle — see A.4.
   *   rebuild() — keep the registry, rebuild the observer over it. Scroll
   *               container change, tab returning to the foreground.
   *
   * `reset` is deliberately NOT exported. Every old call site has to pick
   * one, and a compiler error at each of them is the point.
   */
  destroy: () => impl.destroy(),
  rebuild: () => impl.rebuild(),
  setRoot: (el: Element | null) => impl.setRoot(el),
  setViewportCentre: (v: number | null) => impl.setViewportCentre(v),
  byDistanceFromCentre: (ids: Iterable<string>) => impl.byDistanceFromCentre(ids),
};
```

> **沒有 `distanceToCenter`,這是刻意的。** 舊的 per-id 述詞被 pump 放在
> comparator 裡呼叫,所以它每次比較都讀一次 layout —— 50 個工作約 300 次比較
> 就是 600 次強制 layout。`byDistanceFromCentre` 一次算完整批,理由寫在它自己
> 的註解裡。保留一個相容 shim 會把那個成本原封不動留著,而且 Phase C 還要再
> 回來刪一次。pump 的改法見 A.3,三行。

---

## A.3 pump 的排序(三行)

`store.ts` 的 pump 目前:

```ts
autoJobs.sort((a, b) => distanceToCenter(a.messageId) - distanceToCenter(b.messageId));
```

改成:

```ts
// Ranked in one pass: the comparator runs O(n log n) times and reading layout
// inside it turns one flush into hundreds. Unsigned distance from the centre
// of what the user is looking at — the old signed version ordered "topmost
// first", which is arrival order, not attention order.
const order = visibilityObserver.byDistanceFromCentre(autoJobs.map((j) => j.messageId));
const rank = new Map(order.map((id, i) => [id, i]));
autoJobs.sort((a, b) => rank.get(a.messageId)! - rank.get(b.messageId)!);
```

這讓 Phase A 從兩個檔案變成三個,值得:它比現況**更便宜**(一次 layout 而不是
每次比較一次),而且它就是 Phase C 的 `takeNext` 最終會寫的東西 —— 現在做等於
先付了 C 的一部分,不是額外的工。

**這不影響 A8 的可歸因性。** A8 量的三個數字(佇列峰值、`result=idle` 比例、
捲回的訊息會不會被翻譯)沒有一個和排序有關 —— 排序決定的是**先翻哪一則**,
不是翻幾則或翻不翻。

---

## A.4 呼叫點改動

`reset` 不再存在,編譯器會在每個舊呼叫點報錯。逐一決定它要的是哪一個:

| 檔案 | 舊呼叫 | 改成 | 理由 |
|---|---|---|---|
| `autoPolicy.ts` `startAutoPolicy()` | `visibilityObserver.reset()` | **整行刪掉** | 打開自動翻譯不該讓觀察器忘記已掛載的訊息。這正是 B2 |
| `autoPolicy.ts` `resetAutoPolicy()` | `visibilityObserver.reset()` | `visibilityObserver.destroy()` | 真的要清空 |
| 換房間的地方(`setAutoPolicyRoom` 或元件層) | `visibilityObserver.reset()` | **整行刪掉** | 見下方 ⚠️ —— 註冊表歸元件所有 |
| 尚不存在 | — | `visibilityObserver.rebuild()` | **新增**:接到 `visibilitychange` 回前景時 |

### 元件層:房間與開關要分成兩個 effect

一個 effect 同時吃 `[roomId, autoTranslate]`,關開關就會跑到 cleanup,而 cleanup
裡的 `resetAutoPolicy()` 會 `destroy()` 掉註冊表 —— 開關再打開時面對的是空的
註冊表,而訊息元件不會因此重新註冊。這是 B2 換一條路徑重演。

```ts
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

`resetAutoPolicy()`(唯一會 `destroy()` 的入口)只在**整個聊天介面卸載或登出**
時呼叫,不要放在這兩個 effect 的 cleanup 裡。

---

`visibilitychange` 的新接線(放在既有 `setAutoPolicyHidden` 的同一處):

```ts
document.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';
  setAutoPolicyHidden(hidden);
  // A tab that was backgrounded delivers no intersection entries while away.
  // Coming back, the whole viewport has to be re-evaluated — otherwise every
  // message that was already on screen stays un-offered until it moves.
  if (!hidden) visibilityObserver.rebuild();
});
```

> 如果現有的 hidden 監聽寫在 React effect 裡,`rebuild()` 加在同一個 handler
> 即可,不要另外新增一個 listener。

> ⚠️ **`destroy()` 只在整個聊天介面卸載或登出時呼叫 —— 換房間和開關切換都不要。**
>
> 註冊表的擁有者是**掛載中的訊息元件**:它們在 ref callback 附加時 `observe`、
> 收到 `null` 時 `unobserve`。從父層的 `useEffect` 呼叫 `destroy()` 是在跟子元件
> 的註冊搶時序,而且搶輸:
>
> ```
> mutation phase  → 舊 ref 收到 null(unobserve)
> layout phase    → 新 ref 附加 —— 新訊息在這裡 observe()
> passive effects → 子元件先、父元件後 —— 父層的 useEffect 在這裡才跑
>                   → destroy() 把剛剛註冊好的全部清掉
> ```
>
> 換房間時每次都會發生,而且和 B2 是同一個失效:註冊表空了,只能靠 re-render
> 意外恢復。**元件自己會 `unobserve`,父層不需要幫它清。**
>
> 同理,關閉自動翻譯開關時要呼叫 `stopAutoPolicy()`(非破壞性),不是
> `resetAutoPolicy()`。訊息還掛在畫面上,註冊表不該被清 —— 下游一律由
> `getContext().autoTranslate` 擋住。開關再打開時才不會對著空的註冊表發呆。

> ⚠️ **「元件擁有註冊表」有一個前提:ref 必須跨 re-render 保持同一個函式身分。**
>
> 上面整套模型假設 ref callback 只在真正 mount / unmount 時觸發。React 的規則是
> **ref prop 換了新身分就先用 `null` 呼叫舊的、再用元素呼叫新的** —— 所以只要
> 每次 render 產生新的 ref 函式,每一次父層 re-render 都會變成一輪
> `unobserve` → `observe`。
>
> 這正好繞過觀察器的冪等保護。`observe()` 的 `elements.get(id) === element`
> 早退只擋得住「連續 observe 兩次」;`unobserve()` 已經把註冊表項目刪掉了,
> 所以接著的 `observe()` 是全新註冊 —— **dwell 從零重新計時**。
>
> 在一則新訊息就會讓父層 re-render 的聊天室裡,只要 re-render 比 `dwellMs`
> (預設 400ms)還密,**沒有任何訊息能跑完 dwell**,自動翻譯完全不動作,而
> log 上只會看到 `visible → hidden(cancelledDwell=true)→ visible …` 無限循環。
>
> 所以 ref 這條鏈上的**每一環**都要穩定:產生 ref 的那個函式、把兩個 ref 併起來
> 的 `mergedRef`、以及 `visibilityRef` 本身。`useCallback(fn, [])` **不夠** ——
> 被 memo 的是產生器,不是它每次回傳的那個新閉包。要用 id 為鍵的快取。

> ⚠️ **`rebuild()` 會帶來一個 Phase A 還沒有修復路徑的窗口。** 它同步清空
> `visibleIds`,而 IO 的新 entry 是非同步送達的。這中間如果 `pump()` 跑了,
> G5 會把當下佇列裡的工作全部判定為不可見而丟掉。
>
> 在完整系統裡這由 sweep(`recheckVisible`)修復,**但 sweep 是 Phase D**。
> Phase A 只能靠觀察器自己補:entry 一到就重新 `markVisible` → 起新 dwell →
> 400ms 後重新發候選。所以結果是**一輪 churn,不是遺失** —— 但你會在 log 裡
> 看到一批訊息同時 `queued → idle → queued`,那是預期的,不是 bug。
>
> 觸發時機只有「分頁回前景」,一次前景一輪。如果你在**純捲動**測試中看到這個
> 形狀,先數 `rebuild()` 被呼叫幾次 —— 若不是 0,表示有別的地方在呼叫它,
> 最可能是 `setRoot()`(它內部會 `rebuild()`)。Phase A **沒有**要求接
> `setRoot`,如果接了而且傳入每次 render 都變的元素,就會反覆重建。
>
> 覺得這輪 churn 干擾 A8 的量測,可以先不做 A5,把它挪到 Phase D 的 D4 之後
> —— 代價是「背景分頁回前景」這個情境要晚幾相才修好。

---

## A.5 Phase A 不做的事

- **pump 只改 A.3 那三行排序。** G5 仍讀 `visibilityObserver.visibleIds`,
  語意不變(而且現在是對的 —— 這個集合終於只由 IO callback 寫入);並行閘門、
  斷路器、佇列上限一律不動,那些是 Phase C。
- **不改 `autoPolicy.ts` 的邏輯**,只改上表那兩行 reset。
- **不動 F7/F8 的 guard。** 它們補的是另一層的問題,Phase C 才會讓它們變成
  多餘。現在拿掉會同時改變兩個變因。
- **不加 sweep、不加佇列上限。** 那是 Phase D。

---

## A.6 驗收

見 `06-verification.md` §A。摘要:

1. `visibilityObserver.test.ts` 20 個測試全綠(測試碼在參考實作 §9.3,
   把 `.js` 改成 `.ts`、import 路徑對齊即可)。
2. 突變 M1–M4 全殺。
3. 瀏覽器:捲到房間頂端再捲回來,**先前捲過的訊息要能被翻譯**(B1 的直接
   驗證 —— 這在 Phase A 之前是必定失敗的)。
4. 打開自動翻譯開關時,**當下畫面上的訊息要開始翻**,不需要先捲動一下
   (B2 的直接驗證)。
5. 量測佇列峰值:應從 80–150 掉到「可視訊息數量」的量級。
