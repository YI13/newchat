# Phase D — 換掉 `autoPolicy.ts`

Phase C 建立了合約,這一相幾乎是逐字移植。

> ⚠️ **不可拆成兩次上線。** `maxQueueLength` 與 `recheckVisible` 必須同時生效
> (理由見 `README.md`),而 pump 的斷路器必須已在 Phase C 刪除。

---

## D.1 完整替換:`autoPolicy.ts`

```ts
/**
 * The automatic-translation policy layer.
 *
 * It decides *whether* a message the user dwelled on should be translated.
 * It does not translate anything itself: it hands the message to the same
 * store action the Translate button uses, with `origin: 'auto'`. One request
 * path, one queue, one cache — the policy only adds gates in front.
 *
 * Gate order is deliberate and cheapest-first, because a language-detection
 * step is expected to land between dwell and the queue. Anything decidable
 * from the message object alone runs before anything that costs a lookup.
 */
import { DECISION, NOOP_DECISION_LOG, type DecisionLog } from './decisionLog';

export const AUTO_TRANSLATE_CONFIG = {
  dwellMs: 400,
  prefetchMarginPx: 0,
  maxConcurrent: 4,
  // Strictly below maxConcurrent so an explicit request always has somewhere
  // to run.
  maxConcurrentAuto: 2,
  // Safe only because recheckVisible re-offers what is still on screen. On its
  // own a ceiling strands whatever was visible when it bit: the observer
  // raises a candidate once per visibility transition, so a refused message
  // that does not move never gets a second chance.
  maxQueueLength: 50,
  // How often idle-but-visible messages are re-offered. This is a repair path,
  // so a second of latency costs nothing.
  recheckIntervalMs: 1000,
  // A runaway guard, not a capacity control. Sustained reading sits around
  // 1-2 requests a minute.
  maxRequestsPerMinute: 60,
  failureCircuitThreshold: 5,
  failureCircuitCooldownMs: 30_000,
  timeoutMs: 15_000,
  skipNonTextual: true,
};

export const SKIP = {
  AutoDisabled: 'auto-disabled',
  Inactive: 'inactive',
  UnknownMessage: 'unknown-message',
  OwnMessage: 'own-message',
  SystemMessage: 'system-message',
  NonTextual: 'non-textual',
  RateLimited: 'rate-limited',
  CircuitOpen: 'circuit-open',
  InternalError: 'internal-error',
} as const;

const HAS_LETTER = /\p{L}/u;
const RATE_WINDOW_MS = 60_000;

/** ADAPTED: the field carrying the body in this codebase is `message`. */
function bodyOf(message?: { message?: string }): string {
  return message?.message ?? '';
}

/**
 * The per-message gates, as an ordered list rather than an if-chain so a new
 * rule is an insertion rather than an edit. Local language detection belongs
 * at the end of this list: after dwell, before the queue. Placing it earlier
 * would run it for every message the user scrolls past, which is exactly the
 * cost dwell exists to avoid.
 */
export function createSkipRules(config: { skipNonTextual: boolean }) {
  return [
    (message?: PolicyMessage) => (message ? null : SKIP.UnknownMessage),
    // ADAPTED: this codebase carries `isMe` on the message rather than
    // comparing sender account against the current user.
    (message?: PolicyMessage) => (message!.isMe ? SKIP.OwnMessage : null),
    (message?: PolicyMessage) => (message!.sysMsgData != null ? SKIP.SystemMessage : null),
    (message?: PolicyMessage) =>
      config.skipNonTextual && !HAS_LETTER.test(bodyOf(message)) ? SKIP.NonTextual : null,
  ];
}

export interface PolicyMessage {
  id: string;
  message?: string;
  isMe?: boolean;
  sysMsgData?: unknown;
  editedAt?: number;
}

export interface PolicyContext {
  roomId: string | null;
  targetLang: string;
  autoTranslate: boolean;
  active: boolean;
}

export function createAutoPolicy({
  store,
  getMessage,
  getContext,
  getVisibleIds,
  config = {},
  log = NOOP_DECISION_LOG,
  now = () => Date.now(),
}: {
  store: {
    ensureForView(id: string, args: Record<string, unknown>): Promise<any>;
    getEntry(id: string): { status: string };
  };
  getMessage: (id: string) => PolicyMessage | undefined;
  getContext: () => PolicyContext;
  getVisibleIds: () => Iterable<string> | undefined;
  config?: Partial<typeof AUTO_TRANSLATE_CONFIG>;
  log?: DecisionLog;
  now?: () => number;
}) {
  const cfg = { ...AUTO_TRANSLATE_CONFIG, ...config };
  const rules = createSkipRules(cfg);

  let recentRequests: number[] = [];
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;
  let circuitCooldownMs = cfg.failureCircuitCooldownMs;
  let probing = false;

  /**
   * Pure predicate — deliberately. An earlier version claimed the probe token
   * here, in the same expression that tested for it. Every path that returned
   * between the test and the request then kept a token nothing would ever give
   * back: a rate-limited skip, or a throw from the store. `probing` stays
   * true, every later candidate reads it as "a probe is already out", and
   * automatic translation is off for the rest of the session with the backend
   * healthy. The token is claimed at the point of use instead.
   */
  function circuitBlocks(): boolean {
    if (consecutiveFailures < cfg.failureCircuitThreshold) return false;
    if (now() < circuitOpenUntil) return true;
    // Cooldown elapsed: let exactly one request through to test the water.
    return probing;
  }

  /** True when the breaker is open and this call is the one probe allowed
   *  through. Separate from circuitBlocks so the predicate can be called for
   *  its answer alone — the sweep does exactly that, every second. */
  function claimProbe(): boolean {
    if (consecutiveFailures < cfg.failureCircuitThreshold) return false;
    probing = true;
    return true;
  }

  function rateLimited(): boolean {
    const cutoff = now() - RATE_WINDOW_MS;
    recentRequests = recentRequests.filter((t) => t > cutoff);
    return recentRequests.length >= cfg.maxRequestsPerMinute;
  }

  function recordSuccess() {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    circuitCooldownMs = cfg.failureCircuitCooldownMs;
    probing = false;
  }

  function recordFailure(err?: { code?: string }) {
    probing = false;
    // A rejected input is our bug, not an outage. Counting it would let one
    // malformed message switch the feature off for the whole session.
    if (err?.code === 'bad_request') return;

    const wasOpen = consecutiveFailures >= cfg.failureCircuitThreshold;
    consecutiveFailures += 1;
    if (consecutiveFailures < cfg.failureCircuitThreshold) return;

    if (wasOpen) {
      // A probe just failed — widen the window rather than retry at the same
      // cadence against a backend that is still down.
      circuitCooldownMs *= 2;
    }
    circuitOpenUntil = now() + circuitCooldownMs;
  }

  /**
   * Never rejects. Both callers — the dwell timer and the sweep interval —
   * fire without a catch, so a rejection here (a broken IndexedDB rejecting
   * the first cache read, say) would surface as one unhandled rejection per
   * second, forever. An internal error becomes a logged skip and nothing
   * more: it says nothing about the backend, so it must not feed the circuit
   * breaker either.
   */
  async function onCandidate(messageId: string) {
    try {
      return await offerCandidate(messageId);
    } catch (err) {
      // The throw may have happened after the probe token was claimed, in
      // which case nothing downstream will settle and release it. Leaving the
      // token held would turn a local fault into a permanently open circuit.
      probing = false;
      log.emit(DECISION.Skip, messageId, { reason: SKIP.InternalError, error: err });
      return { skipped: SKIP.InternalError };
    }
  }

  async function offerCandidate(messageId: string) {
    const skip = (reason: string, fields?: Record<string, unknown>) => {
      log.emit(DECISION.Skip, messageId, { reason, ...fields });
      return { skipped: reason };
    };

    const ctx = getContext();
    if (!ctx.autoTranslate) return skip(SKIP.AutoDisabled);
    if (!ctx.active) return skip(SKIP.Inactive);

    const message = getMessage(messageId);
    for (const rule of rules) {
      const reason = rule(message);
      if (reason) return skip(reason);
    }

    if (circuitBlocks()) {
      return skip(SKIP.CircuitOpen, {
        failures: consecutiveFailures,
        reopensInMs: Math.max(0, circuitOpenUntil - now()),
      });
    }
    if (rateLimited()) return skip(SKIP.RateLimited, { inWindow: recentRequests.length });

    // Last gate passed: this call is going to the store, so it is now safe to
    // claim the probe token. Everything that can decline is behind us.
    claimProbe();

    const result = await store.ensureForView(messageId, {
      roomId: ctx.roomId,
      text: bodyOf(message),
      targetLang: ctx.targetLang,
      srcVersion: message!.editedAt ?? 0,
      autoTranslate: true,
    });

    // A cache hit or a suppressed message costs nothing, and charging for them
    // would throttle the cheapest paths hardest.
    if (result?.outcome !== 'queued') {
      probing = false;
      return result ?? {};
    }

    try {
      // Charged when the request actually goes out, not when the candidate is
      // accepted. Most automatic candidates never reach the backend: they sit
      // in the queue until their message scrolls away and are dropped at pick
      // time. Charging at enqueue lets one brisk scroll spend the whole
      // minute's budget on requests that were never made, after which every
      // further candidate is silently rate-limited.
      if (!(await result.sent)) {
        // It never ran, so it is neither a probe result nor a data point for
        // the breaker.
        probing = false;
        return result;
      }
      recentRequests.push(now());

      // The store settles rather than throws: a failed translation is a UI
      // state, not an exception. Reading only the rejection path is how a
      // circuit breaker ends up never tripping — every job looks successful.
      const settled = await result.done;
      if (settled?.ok === false && !settled.aborted && !settled.superseded) {
        recordFailure(settled.error);
      } else {
        recordSuccess();
      }
    } catch (err) {
      recordFailure(err as { code?: string });
    }
    return result;
  }

  /**
   * Re-offer messages that are on screen and have nothing happening to them.
   *
   * The visibility observer raises a candidate once per visibility transition.
   * Anything that ends a job without translating it — a full queue, a slot
   * lost to a scroll that came back — leaves the message idle, still on
   * screen, and with nothing left to re-trigger it: it is not moving, so no
   * further intersection entry is ever delivered.
   *
   * Swept rather than driven by a "capacity freed" event, deliberately. The
   * failure being repaired is precisely that no event arrives; a repair that
   * itself waits for one inherits the same blind spot.
   *
   * Only `idle` is re-offered. `failed` is left alone or a body the backend
   * will always reject becomes an unbounded retry loop — and a bad_request
   * never trips the circuit breaker, so nothing else would stop it.
   */
  async function recheckVisible() {
    const ids = getVisibleIds?.();
    if (!ids) return;

    // Checked here, silently, before any per-message work. The sweep fires
    // every second for as long as the page lives; while the switch is off or
    // the page is hidden, logging a skip per visible message per tick would
    // churn the decision log's whole buffer in minutes.
    const ctx = getContext();
    if (!ctx.autoTranslate || !ctx.active) return;

    // The circuit and the rate limit are global state, not per-message, so
    // they belong in the same pre-loop gate for the same reason. Safe only
    // because circuitBlocks is a pure predicate — calling it here once a
    // second must not claim the probe token.
    if (circuitBlocks() || rateLimited()) return;

    for (const id of ids) {
      if (store.getEntry(id).status !== 'idle') continue;
      // Fire-and-forget: onCandidate resolves when the translation SETTLES, so
      // awaiting it here would repair one message per tick instead of one
      // sweep. Deduplication is the store's status check above, not this
      // loop's ordering — and onCandidate never rejects.
      void onCandidate(id);
    }
  }

  return {
    config: cfg,
    onCandidate,
    recheckVisible,
    // The circuit governs background work only. Manual requests never reach
    // this module; the flag keeps that a stated contract.
    gatesManualRequests: false,
    stats: () => ({
      consecutiveFailures,
      circuitOpen: consecutiveFailures >= cfg.failureCircuitThreshold,
      circuitOpenUntil,
      requestsInWindow: recentRequests.length,
    }),
  };
}
```

---

## D.2 Adapter 1 — `getMessage` 必須同步且 O(1)

現況每個候選跑一次 `await import('../messages/store')` 再
`[...room.messages, ...threads.flatMap()].find()`。80 個候選就是 80 次全室掃描,
而且在 await 邊界後面。加上每秒一次 sweep,這會變成每秒 N 次全室掃描。

```ts
/**
 * A synchronous, O(1) message lookup for the active room.
 *
 * Rebuilt when the room's message list changes, not per candidate: the policy
 * asks once per dwell and once per swept message per second, and a linear scan
 * of the room at each of those is the single most expensive thing in this
 * path.
 */
function createMessageIndex() {
  let index = new Map<string, PolicyMessage>();
  let builtFor: { roomId: string | null; version: unknown } = { roomId: null, version: null };

  function rebuild(roomId: string) {
    const room = MessagesStore.getState().rooms[roomId];
    const next = new Map<string, PolicyMessage>();
    if (room) {
      for (const m of room.messages) next.set(m.id, m);
      for (const thread of Object.values(room.threads)) {
        for (const m of thread.messages) next.set(m.id, m);
      }
    }
    index = next;
  }

  return {
    get(id: string): PolicyMessage | undefined {
      return index.get(id);
    },
    /** Called from the MessagesStore subscription — see D.4. */
    invalidate(roomId: string | null) {
      if (!roomId) {
        index = new Map();
        builtFor = { roomId: null, version: null };
        return;
      }
      rebuild(roomId);
      builtFor = { roomId, version: null };
    },
  };
}
```

> 靜態 import `MessagesStore` 若造成循環相依,**不要**退回動態 import ——
> 改成由組裝點把 `getMessage` 當閉包注入(`createAutoPolicy({ getMessage })`
> 本來就是為此設計的)。動態 import 讓這個函式無法同步,整層合約就垮了。

---

## D.3 Adapter 2 — `getContext` 取代五個模組變數

現況的 `autoEnabled` / `activeRoomId` / `isHidden` 保留,只是改成由 `getContext`
讀出。**`startAutoPolicy` / `stopAutoPolicy` / `setAutoPolicyRoom` /
`setAutoPolicyHidden` / `resetAutoPolicy` 的對外簽名完全不變**,呼叫端不用動。

```ts
let autoEnabled = false;
let activeRoomId: string | null = null;
let isHidden = false;

const messageIndex = createMessageIndex();

const policy = createAutoPolicy({
  store: {
    ensureForView: (id, args) => MessageTranslationStore.getState().ensureForView(id, args),
    getEntry: (id) =>
      MessageTranslationStore.getState().byId[id] ?? { status: 'idle', reqSeq: 0 },
  },
  getMessage: (id) => messageIndex.get(id),
  getContext: () => ({
    roomId: activeRoomId,
    targetLang: getTargetLang(),
    autoTranslate: autoEnabled,
    // Read live, not snapshotted. A tab that loaded in the background has to
    // start translating the moment it is foregrounded, without waiting for a
    // re-render to refresh a captured value.
    active: !isHidden && document.visibilityState !== 'hidden' && activeRoomId !== null,
  }),
  getVisibleIds: () => visibilityObserver.visibleIds,
  log: decisionLog,
});
```

現況 `onCandidate(messageId, roomId)` 帶 roomId 並比對 `activeRoomId !== roomId`。
新版 roomId 只從 context 取,那道比對不再需要 —— 換房間時舊房間的訊息元件會
卸載並各自 `unobserve`,註冊表自然只剩新房間的列。**不要**在這裡呼叫
`destroy()` 幫忙清,理由見 `01-phase-A-observer.md` §A.4 的 ⚠️(會 race 掉
剛掛載的新訊息)。

---

## D.4 Adapter 3 — sweep 與索引的驅動

```ts
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeCandidate: (() => void) | null = null;
let unsubscribeMessages: (() => void) | null = null;

export function startAutoPolicy(): void {
  autoEnabled = true;

  if (!unsubscribeCandidate) {
    unsubscribeCandidate = visibilityObserver.onCandidate((id) => {
      void policy.onCandidate(id);
    });
  }

  if (!unsubscribeMessages) {
    unsubscribeMessages = MessagesStore.subscribe(() => messageIndex.invalidate(activeRoomId));
  }

  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      void policy.recheckVisible();
    }, policy.config.recheckIntervalMs);
  }

  // NOTE: no visibilityObserver.reset() here. The old code called it and that
  // is defect B2 — turning the feature on blinded the observer to every
  // already-mounted message. See 00-assessment.md.
}

export function stopAutoPolicy(): void {
  autoEnabled = false;
  // The interval is left running: recheckVisible's first gate is autoTranslate,
  // so it costs one predicate per second and the switch can come back on
  // without re-arming anything. Torn down in resetAutoPolicy.
}

export function setAutoPolicyRoom(roomId: string | null): void {
  activeRoomId = roomId;
  messageIndex.invalidate(roomId);
  // No destroy(). The registry belongs to the mounted messages: refs attach in
  // the layout phase, this effect runs in the passive phase, so clearing here
  // wipes the rows that just registered themselves for the new room. They
  // unobserve themselves on unmount; nothing here has to help.
}

export function setAutoPolicyHidden(hidden: boolean): void {
  isHidden = hidden;
  // A tab that was backgrounded delivered no intersection entries while away.
  if (!hidden) visibilityObserver.rebuild();
}

export function resetAutoPolicy(): void {
  autoEnabled = false;
  activeRoomId = null;
  isHidden = false;
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  unsubscribeCandidate?.(); unsubscribeCandidate = null;
  unsubscribeMessages?.(); unsubscribeMessages = null;
  messageIndex.invalidate(null);
  visibilityObserver.destroy();
  detachAllAuto();
}

export function getAutoPolicyAutoEnabled(): boolean {
  return autoEnabled;
}
```

> `MessagesStore.subscribe` 每次訊息變動都重建索引。若房間訊息量大到讓這件事
> 變成瓶頸,改成惰性:記一個 dirty flag,`getMessage` 讀到 dirty 才重建。
> **不要**改成「找不到就掃一次」—— 那會在訊息真的不存在時退化回全掃。

---

## D.5 打開兩個開關

Phase C 刻意留在關閉狀態的兩個值,現在一起打開:

```ts
// constants.ts
export const MAX_QUEUE_LENGTH = 50;     // was 0
```

sweep 已在 D.4 接上。**這兩件事必須在同一次上線。**

---

## D.6 這一相要刪掉的東西

- `autoPolicy.ts` 舊檔全部內容(整檔替換)
- `skipRules.ts` — 規則移進 `createSkipRules`;若 `hasUnicodeLetters` 有其他
  使用者就留著那一個 export,其餘刪除
- `applySkipRules` 及其所有 IDB 讀取(Phase C 已把它們移進 `ensureForView`)
- `hasAutoRequestsPerMinuteBudget` 與 `requestTimestamps`(由 policy 內部的
  `rateLimited` 取代,而且改成在真正送出時計費)

---

## D.7 驗收

見 `06-verification.md` §D。摘要:

1. `autoPolicy.test.ts` 43 個測試全綠(參考實作 §9.4)。
2. 突變 M5–M12 全殺。
3. 整合測試 16 個全綠(參考實作 §9.8),混沌測試三種子全綠(§9.9)。
4. 瀏覽器:捲動後停下,**畫面上 12 則要在約 5 秒內全部翻完**。這是 sweep
   的直接驗證 —— 沒有它,參考實作量到的是 12 則裡只有 2 則。
5. `__translate.log.records()` 在斷路器打開時**不應該**每秒增加十幾筆
   `skip:circuit-open`(缺陷 #16 的驗證)。
