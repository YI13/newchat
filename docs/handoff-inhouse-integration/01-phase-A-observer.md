# Phase A — 換掉 `visibilityTracker.ts`

**耦合最低、回報最高。** 一次修掉 `00-assessment.md` 的 B1/B2/B3 三個決定性
缺陷。動兩個檔案,不碰 store、不碰 policy、不碰快取。

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
  /** Drop everything, including the registry. For room switch and logout. */
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
   *   destroy() — forget everything, including the registry. Room switch,
   *               logout, resetAutoPolicy().
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

  /**
   * @deprecated Signed distance, kept only so pump() still compiles during
   * Phase A. Its ordering is "topmost first", not "what the user is looking
   * at first". Phase C switches pump to byDistanceFromCentre and this goes.
   */
  distanceToCenter(id: string): number {
    const ranked = impl.byDistanceFromCentre([id]);
    if (ranked.length === 0) return Infinity;
    const el = (impl as unknown as { registeredIds(): string[] }).registeredIds();
    return el.includes(id) ? 0 : Infinity;
  },
};
```

> `distanceToCenter` 的暫時實作**故意是退化的**(只分「有註冊」與「沒註冊」)。
> Phase A 不該同時改動排序行為 —— 那是 Phase C 的 T14。如果你發現 Phase A
> 之後排序變差,那是預期的,C 會修回來且更好。
>
> 如果你想在 Phase A 就保住排序品質,可以把 pump 的 sort 改成一行:
> `const ordered = visibilityObserver.byDistanceFromCentre(autoJobs.map(j => j.messageId))`
> 然後照 ordered 重排 `autoJobs`。這是安全的,但要一起改 pump,不再是「只動兩檔」。

---

## A.3 呼叫點改動

`reset` 不再存在,編譯器會在每個舊呼叫點報錯。逐一決定它要的是哪一個:

| 檔案 | 舊呼叫 | 改成 | 理由 |
|---|---|---|---|
| `autoPolicy.ts` `startAutoPolicy()` | `visibilityObserver.reset()` | **整行刪掉** | 打開自動翻譯不該讓觀察器忘記已掛載的訊息。這正是 B2 |
| `autoPolicy.ts` `resetAutoPolicy()` | `visibilityObserver.reset()` | `visibilityObserver.destroy()` | 真的要清空 |
| 換房間的地方(`setAutoPolicyRoom` 或元件層) | `visibilityObserver.reset()` | `visibilityObserver.destroy()` | 舊房間的訊息必須離開註冊表 |
| 尚不存在 | — | `visibilityObserver.rebuild()` | **新增**:接到 `visibilitychange` 回前景時 |

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

---

## A.4 Phase A 不做的事

- **不改 pump。** G5 仍讀 `visibilityObserver.visibleIds`,語意不變(而且現在
  是對的 —— 這個集合終於只由 IO callback 寫入)。
- **不改 `autoPolicy.ts` 的邏輯**,只改上表那兩行 reset。
- **不動 F7/F8 的 guard。** 它們補的是另一層的問題,Phase C 才會讓它們變成
  多餘。現在拿掉會同時改變兩個變因。
- **不加 sweep、不加佇列上限。** 那是 Phase D。

---

## A.5 驗收

見 `06-verification.md` §A。摘要:

1. `visibilityObserver.test.ts` 20 個測試全綠(測試碼在參考實作 §9.3,
   把 `.js` 改成 `.ts`、import 路徑對齊即可)。
2. 突變 M1–M4 全殺。
3. 瀏覽器:捲到房間頂端再捲回來,**先前捲過的訊息要能被翻譯**(B1 的直接
   驗證 —— 這在 Phase A 之前是必定失敗的)。
4. 打開自動翻譯開關時,**當下畫面上的訊息要開始翻**,不需要先捲動一下
   (B2 的直接驗證)。
5. 量測佇列峰值:應從 80–150 掉到「可視訊息數量」的量級。
