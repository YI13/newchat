import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { translateText } from '@/api'
import { createTranslateTextStub } from '@/api/translateText/stub'
import { useNats } from '@/context/NatsContext'
import { useToast } from '@/context/ToastContext'
import { translationCache } from '@/lib/idbTranslationCache'
import {
  DEFAULT_AUTO_TRANSLATE,
  DEFAULT_TARGET_LANG,
  getAutoTranslate,
  getTargetLang,
  setAutoTranslate as persistAutoTranslate,
  setTargetLang as persistTargetLang,
} from '@/lib/translationSettings'
import {
  TRANSLATE_STUB_DELAY_MS,
  TRANSLATE_STUB_MODE,
  TRANSLATE_USE_STUB,
} from '@/lib/runtimeConfig'
import { AUTO_TRANSLATE_CONFIG, createAutoPolicy } from './autoPolicy'
import { DECISION, createDecisionLog } from './decisionLog'
import { checkInvariants } from './invariants'
import { IDLE_ENTRY, createTranslationStore } from './store'
import { translationErrorToast } from './translationErrorCopy'
import { createVisibilityObserver } from './visibilityObserver'

/** How often the queue is audited against its own guarantees. Frequent enough
 *  that a stall shows up while you are still looking at the screen, rare
 *  enough to cost nothing. */
const INVARIANT_INTERVAL_MS = 2000

const TranslationContext = createContext(null)

function resolveTranslate() {
  if (!TRANSLATE_USE_STUB) return translateText
  return createTranslateTextStub({
    mode: TRANSLATE_STUB_MODE,
    delayMs: TRANSLATE_STUB_DELAY_MS,
  })
}

export function TranslationProvider({ children, translate, cache }) {
  const nats = useNats()

  const [targetLang, setTargetLangState] = useState(getTargetLang)
  const [autoTranslate, setAutoTranslateState] = useState(getAutoTranslate)

  const setTargetLang = useCallback((lang) => {
    persistTargetLang(lang)
    // Read back rather than trusting the argument: the settings layer rejects
    // an unsupported value, and the UI must not display a language that was
    // never stored.
    setTargetLangState(getTargetLang())
  }, [])

  const setAutoTranslate = useCallback((enabled) => {
    persistAutoTranslate(enabled)
    setAutoTranslateState(getAutoTranslate())
  }, [])

  // Message bodies for the ids the observer is watching. Registration
  // supplies both at once, so the policy never has to reach into a message
  // store it does not own.
  const registryRef = useRef(new Map())
  const contextRef = useRef({})
  contextRef.current = {
    targetLang,
    autoTranslate,
    currentUserAccount: nats?.user?.account,
  }

  // useState's lazy initialiser, not useMemo: these own a queue, in-flight
  // AbortControllers and a live IntersectionObserver, so a second set would
  // strand real work. useMemo is a caching hint React may discard, and
  // StrictMode's double render makes that observable.
  //
  // Built observer -> store -> policy so the store receives its automatic
  // gates at construction rather than having them patched in afterwards.
  const [{ store, auto }] = useState(() => {
    let policy = null
    let candidateId = null

    // One log shared by all three. Their decisions are only interpretable
    // together — the observer's "hidden" is the reason the queue's "drop"
    // happened — and interleaving them in one ordered buffer is the whole
    // point.
    const log = createDecisionLog()

    const observer = createVisibilityObserver({
      dwellMs: AUTO_TRANSLATE_CONFIG.dwellMs,
      prefetchMarginPx: AUTO_TRANSLATE_CONFIG.prefetchMarginPx,
      log,
      // Built in whatever state the setting is already in, so a session that
      // starts with the switch off never runs a single intersection callback.
      // The effect below keeps it in step from here on.
      enabled: autoTranslate,
      onCandidate: (id) => {
        candidateId = id
        policy?.onCandidate(id)
      },
    })

    const createdStore = createTranslationStore({
      nats,
      translate: translate ?? resolveTranslate(),
      cache: cache ?? translationCache,
      log,
      config: {
        maxConcurrent: AUTO_TRANSLATE_CONFIG.maxConcurrent,
        maxConcurrentAuto: AUTO_TRANSLATE_CONFIG.maxConcurrentAuto,
        // Passed through explicitly rather than left to the store's own
        // defaults: AUTO_TRANSLATE_CONFIG is where these numbers are declared
        // and read, and a declared knob that nothing wires up is worse than
        // no knob at all.
        timeoutMs: AUTO_TRANSLATE_CONFIG.timeoutMs,
        maxQueueLength: AUTO_TRANSLATE_CONFIG.maxQueueLength,
        // Re-checked when a slot frees, not when the job was queued: a
        // message can scroll away while it waits, and translating it then is
        // pure waste.
        isAutoEligible: (id) => observer.visibleIds.has(id),
        orderAutoQueue: (ids) => observer.byDistanceFromCentre(ids),
      },
    })

    policy = createAutoPolicy({
      store: createdStore,
      log,
      getVisibleIds: () => observer.visibleIds,
      getMessage: (id) => registryRef.current.get(id)?.message,
      getContext: () => ({
        ...contextRef.current,
        // Read at call time, never snapshotted at render time. A tab that
        // loads in the background renders `false` exactly once, and coming to
        // the foreground re-renders nothing — a snapshot then reports the
        // page hidden while the user is looking straight at it, and every
        // candidate is skipped 'inactive' with no way to see why.
        active: typeof document === 'undefined' || document.visibilityState === 'visible',
        roomId: registryRef.current.get(candidateId)?.roomId,
      }),
    })

    const snapshot = () => ({
      ...createdStore.inspect(),
      // Reported so an empty visibleIds against a full registeredIds reads as
      // "suspended" rather than as the registry going blind — the two look
      // identical from outside, and only one of them is a fault.
      trackerEnabled: observer.isEnabled(),
      visibleIds: [...observer.visibleIds],
      registeredIds: observer.registeredIds(),
    })

    return { store: createdStore, auto: { policy, observer, log, snapshot } }
  })

  // Nothing downstream of the tracker does any work while the switch is off —
  // the policy skips at its first gate — so watching at all is pure cost:
  // an intersection callback per scroll and a dwell timer per row, for
  // candidates that are all discarded. Suspending stops that at the source.
  //
  // Suspend, never destroy. The registry belongs to the mounted rows, and
  // flipping the switch back on re-renders none of them — a resume that had
  // to wait for a re-mount would leave the tracker watching nothing, which is
  // exactly how automatic translation dies silently.
  useEffect(() => {
    auto.observer.setEnabled(autoTranslate)
  }, [auto, autoTranslate])

  // A backgrounded tab must not keep translating, and on return the viewport
  // is re-evaluated rather than resuming a queue built for a screen the user
  // has since scrolled away from.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') auto.observer.reset()
    }
    document.addEventListener('visibilitychange', onVisibility)
    // Only the listener is torn down here. The observer's registry belongs to
    // the provider, not to this effect: destroying it in the cleanup empties
    // the registry on StrictMode's mount/unmount/mount cycle, and the message
    // refs that filled it have already fired and will not fire again. The
    // result is an observer watching nothing, which presents as automatic
    // translation silently never happening.
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [auto])

  // Audit the queue against its own guarantees. A stalled queue produces no
  // error and no failed request — the only symptom is that messages quietly
  // stop being translated — so the properties are checked directly rather
  // than inferred from the UI.
  //
  // Each violation is reported once per continuous occurrence: a stall that
  // lasts a minute is one line, not thirty.
  useEffect(() => {
    const reported = new Set()
    const timer = setInterval(() => {
      const violations = checkInvariants(auto.snapshot())
      const seen = new Set()
      for (const violation of violations) {
        const key = `${violation.code}:${violation.messageId ?? ''}`
        seen.add(key)
        if (reported.has(key)) continue
        reported.add(key)
        auto.log.emit(DECISION.Violation, violation.messageId, {
          code: violation.code,
          detail: violation.detail,
        })
      }
      for (const key of [...reported]) if (!seen.has(key)) reported.delete(key)
    }, INVARIANT_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [auto])

  // Re-offer messages sitting on screen with nothing happening to them. The
  // observer raises a candidate once per visibility transition, so a message
  // whose job ended without translating it — a full queue, a slot lost to a
  // scroll that came back — has nothing left to re-trigger it while it stays
  // still. A sweep repairs that without depending on an event; depending on
  // one would inherit the same blind spot.
  useEffect(() => {
    const timer = setInterval(() => {
      auto.policy.recheckVisible()
    }, AUTO_TRANSLATE_CONFIG.recheckIntervalMs)
    return () => clearInterval(timer)
  }, [auto])

  // A console handle, because the questions worth asking here are ad hoc:
  // "what happened to this one message", "is the queue actually stuck".
  // Attached in an effect so it follows the provider's lifetime.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    window.__translate = {
      log: auto.log,
      store,
      observer: auto.observer,
      policy: auto.policy,
      snapshot: auto.snapshot,
      check: () => checkInvariants(auto.snapshot()),
      timeline: (messageId) => auto.log.timeline(messageId),
      print: (on = true) => auto.log.setPrinting(on),
    }
    return () => {
      delete window.__translate
    }
  }, [auto, store])

  const registerMessage = useCallback(
    (message, roomId, element) => {
      if (!element) {
        registryRef.current.delete(message.id)
        auto.observer.unobserve(message.id)
        auto.policy.forget(message.id)
        store.detach(message.id)
        return
      }
      registryRef.current.set(message.id, { message, roomId })
      auto.observer.observe(message.id, element)
    },
    [auto, store],
  )

  const setScrollRoot = useCallback((element) => auto.observer.setRoot(element), [auto])

  const value = useMemo(
    () => ({
      store,
      auto,
      targetLang,
      autoTranslate,
      setTargetLang,
      setAutoTranslate,
      registerMessage,
      setScrollRoot,
    }),
    [
      store,
      auto,
      targetLang,
      autoTranslate,
      setTargetLang,
      setAutoTranslate,
      registerMessage,
      setScrollRoot,
    ],
  )

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>
}

export function useTranslation() {
  const ctx = useContext(TranslationContext)
  if (!ctx) throw new Error('useTranslation must be used within TranslationProvider')
  return ctx
}

/** Null outside a provider. Message rendering is shared surface: requiring
 *  the translation provider everywhere a bubble appears would couple every
 *  consumer of MessageRow to this feature. */
export function useOptionalTranslation() {
  return useContext(TranslationContext)
}

const NO_STORE_SUBSCRIBE = () => () => {}
const getIdle = () => IDLE_ENTRY

/** Subscribe to one message's display state. Entries are replaced wholesale
 *  on every transition, so identity comparison is enough for the snapshot and
 *  no selector memoisation is needed. */
export function useTranslationEntry(messageId) {
  const ctx = useOptionalTranslation()
  const store = ctx?.store
  const getSnapshot = useCallback(
    () => (store ? store.getEntry(messageId) : IDLE_ENTRY),
    [store, messageId],
  )
  return useSyncExternalStore(store?.subscribe ?? NO_STORE_SUBSCRIBE, getSnapshot, getIdle)
}

/** Ref callback that hands a mounted message and its element to the
 *  visibility observer. Returns a no-op outside a provider so message
 *  rendering stays usable without this feature wired up. */
export function useAutoTranslateRegistration(message, roomId) {
  const ctx = useOptionalTranslation()
  const registerMessage = ctx?.registerMessage
  return useCallback(
    (element) => {
      if (!registerMessage) return
      registerMessage(message, roomId, element)
    },
    // `message` is intentionally keyed by id and revision: a new object for
    // the same unchanged message must not churn the observer registration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registerMessage, message.id, message.editedAt, roomId],
  )
}

/** Tells the observer which element actually scrolls, so intersection is
 *  measured against the message list rather than the whole document. */
export function useAutoTranslateScrollRoot() {
  const ctx = useOptionalTranslation()
  const setScrollRoot = ctx?.setScrollRoot
  return useCallback(
    (element) => {
      if (!setScrollRoot) return
      setScrollRoot(element ?? null)
    },
    [setScrollRoot],
  )
}

const NOOP = () => {}

/** Degrades to read-only defaults outside a provider so header chrome can be
 *  rendered in isolation. `available` tells a caller whether the controls
 *  will actually do anything. */
export function useTranslationSettings() {
  const ctx = useOptionalTranslation()
  return {
    available: !!ctx,
    targetLang: ctx?.targetLang ?? DEFAULT_TARGET_LANG,
    autoTranslate: ctx?.autoTranslate ?? DEFAULT_AUTO_TRANSLATE,
    setTargetLang: ctx?.setTargetLang ?? NOOP,
    setAutoTranslate: ctx?.setAutoTranslate ?? NOOP,
  }
}

/** The two halves of the user's explicit choice. Both are recorded as intent
 *  so they outlive an eviction of the cached text.
 *
 *  `available` is false outside a provider; callers render no control rather
 *  than a button that cannot work. */
export function useTranslationActions() {
  const ctx = useOptionalTranslation()
  const store = ctx?.store
  const targetLang = ctx?.targetLang
  const { show } = useToast()

  const translate = useCallback(
    (message, roomId) => {
      if (!store) return Promise.resolve()
      return store
        .translate(message.id, {
          roomId,
          text: message.content ?? message.msg ?? '',
          targetLang,
          srcVersion: message.editedAt ?? 0,
          origin: 'manual',
        })
        .then((outcome) => {
          // The user just answered the question the sweep had memoised. Both
          // buttons do this: Translate overrides an 'off' intent, See original
          // creates one.
          ctx?.auto?.policy?.forget(message.id)
          // The store settles rather than throws, so this is the only place
          // the outcome is visible — and it is deliberately the manual one.
          // Automatic failures stay silent: nobody asked for them, and a
          // single down backend would otherwise raise one notice per message
          // on screen. An abort is the user's own doing (see original, a new
          // request superseding this one) and says nothing about the service.
          if (outcome && !outcome.ok && !outcome.aborted) {
            show(translationErrorToast(outcome.error))
          }
          return outcome
        })
    },
    [store, targetLang, show],
  )

  const revert = useCallback(
    (message, roomId) => {
      if (!store) return Promise.resolve()
      ctx?.auto?.policy?.forget(message.id)
      return store.revert(message.id, roomId)
    },
    [store, ctx],
  )

  return { available: !!store, translate, revert }
}

/** Queue state, invariant violations and the tail of the decision log, for
 *  the diagnostics panel.
 *
 *  Polled rather than subscribed: the interesting readings — how long a job
 *  has been on the wire, whether the queue is draining — are functions of
 *  elapsed time, and no state change fires while a queue sits stuck. An
 *  event-driven panel goes blank at exactly the moment you need it. */
export function useTranslationDiagnostics({ intervalMs = 500, tail = 40 } = {}) {
  const ctx = useOptionalTranslation()
  const auto = ctx?.auto
  const [reading, setReading] = useState(null)

  useEffect(() => {
    if (!auto) return undefined
    const sample = () => {
      const snapshot = auto.snapshot()
      setReading({
        snapshot,
        violations: checkInvariants(snapshot),
        records: auto.log.records().slice(-tail).reverse(),
        printing: auto.log.isPrinting(),
      })
    }
    sample()
    const timer = setInterval(sample, intervalMs)
    return () => clearInterval(timer)
  }, [auto, intervalMs, tail])

  return {
    available: !!auto,
    log: auto?.log ?? null,
    snapshot: reading?.snapshot ?? null,
    violations: reading?.violations ?? [],
    records: reading?.records ?? [],
    printing: reading?.printing ?? false,
  }
}
