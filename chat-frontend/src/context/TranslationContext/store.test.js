import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createTranslationCache } from '@/lib/idbTranslationCache'
import { createDecisionLog } from './decisionLog'
import { createTranslationStore } from './store'

let disposables = []

function makeCache() {
  const cache = createTranslationCache({
    dbName: `store-test-${disposables.length}-${Math.random().toString(36).slice(2)}`,
  })
  disposables.push(cache)
  return cache
}

/** A translate function whose every call is settled by the test, so queue
 *  occupancy is observable rather than timing-dependent. */
function deferredTranslate() {
  const calls = []
  const fn = vi.fn((_nats, args, opts) => {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    calls.push({ args, opts, resolve, reject })
    opts?.signal?.addEventListener('abort', () => {
      const err = new Error('translate aborted')
      err.name = 'AbortError'
      reject(err)
    })
    return promise
  })
  fn.calls = calls
  return fn
}

function makeStore(overrides = {}) {
  const cache = overrides.cache ?? makeCache()
  const translate = overrides.translate ?? deferredTranslate()
  const store = createTranslationStore({
    nats: { user: { account: 'alice', siteId: 'site-local' } },
    translate,
    cache,
    config: { maxConcurrent: 4, ...overrides.config },
    log: overrides.log,
  })
  return { store, translate, cache }
}

function job(overrides = {}) {
  return {
    roomId: 'r1',
    text: 'hello',
    targetLang: 'ja',
    srcVersion: 1,
    ...overrides,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

afterEach(async () => {
  for (const cache of disposables) await cache.destroy()
  disposables = []
  vi.restoreAllMocks()
})

describe('translate lifecycle', () => {
  test('moves idle -> loading -> translated and exposes the text', async () => {
    const { store, translate } = makeStore()

    expect(store.getEntry('m1').status).toBe('idle')

    const done = store.translate('m1', job())
    await flush()
    // A free slot means the request went out immediately, so the entry is
    // already past 'queued'.
    expect(store.getEntry('m1').status).toBe('loading')

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    const entry = store.getEntry('m1')
    expect(entry.status).toBe('translated')
    expect(entry.translatedText).toBe('[ja] hello')
    expect(entry.targetLang).toBe('ja')
  })

  test('notifies subscribers on every transition', async () => {
    const { store, translate } = makeStore()
    const listener = vi.fn()
    store.subscribe(listener)

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  test('a failure lands on failed without throwing to the caller', async () => {
    const { store, translate } = makeStore()

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].reject(Object.assign(new Error('boom'), { code: 'internal' }))
    await done

    expect(store.getEntry('m1').status).toBe('failed')
  })

  test('persists the result so a later view hydrates without a request', async () => {
    const { store, translate, cache } = makeStore()

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    const row = await cache.content.peek('m1')
    expect(row.translatedText).toBe('[ja] hello')
    expect(row.srcVersion).toBe(1)
  })

  test('an identical reply is recorded as identical', async () => {
    const { store, translate, cache } = makeStore()

    const done = store.translate('m1', job({ text: 'hello' }))
    await flush()
    translate.calls[0].resolve({ translatedText: 'hello', targetLang: 'ja' })
    await done

    expect(store.getEntry('m1').identical).toBe(true)
    expect((await cache.content.peek('m1')).identical).toBe(true)
  })
})

describe('queued vs in flight', () => {
  test('a job waiting for a slot reports queued, not loading', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()

    // 'loading' has to mean "the request is on the wire". Reporting it while
    // the job is still in the queue makes a full gate indistinguishable from
    // a slow backend.
    expect(store.getEntry('m1').status).toBe('loading')
    expect(store.getEntry('m2').status).toBe('queued')
    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('a queued job flips to loading when a slot frees', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()
    expect(store.getEntry('m2').status).toBe('queued')

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()

    expect(store.getEntry('m2').status).toBe('loading')
  })

  test('a repeat request for a queued message is still deduplicated', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()
    store.translate('m2', job())
    await flush()

    expect(store.getEntry('m2').status).toBe('queued')
    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('an automatic job dropped at pick time leaves queued for idle', async () => {
    const visible = new Set(['m1'])
    const { store } = makeStore({
      config: {
        maxConcurrent: 1,
        maxConcurrentAuto: 1,
        isAutoEligible: (id) => visible.has(id),
      },
    })

    store.translate('m1', { ...job(), origin: 'auto' })
    await flush()
    store.translate('m2', { ...job(), origin: 'auto' })
    await flush()
    expect(store.getEntry('m2').status).toBe('queued')

    visible.delete('m2')
    store.detach('m1')
    await flush()

    // Never sent, so it must not linger as though something were happening.
    expect(store.getEntry('m2').status).toBe('idle')
  })
})

describe('deduplication and generations', () => {
  test('a second request for the same message and language is a no-op', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job())
    await flush()
    store.translate('m1', job())
    await flush()

    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('a different language supersedes the in-flight request', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job({ targetLang: 'ja' }))
    await flush()
    store.translate('m1', job({ targetLang: 'de' }))
    await flush()

    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.calls[0].opts.signal.aborted).toBe(true)
  })

  test('a superseded reply arriving late is discarded', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job({ targetLang: 'ja' }))
    await flush()
    const stale = translate.calls[0]

    const fresh = store.translate('m1', job({ targetLang: 'de' }))
    await flush()

    // The stale generation answers after being superseded — it must not win.
    stale.resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    translate.calls[1].resolve({ translatedText: '[de] hello', targetLang: 'de' })
    await fresh
    await flush()

    expect(store.getEntry('m1').translatedText).toBe('[de] hello')
    expect(store.getEntry('m1').targetLang).toBe('de')
  })
})

describe('concurrency gate', () => {
  test('runs at most maxConcurrent requests at once', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 2 } })

    for (const id of ['m1', 'm2', 'm3', 'm4']) store.translate(id, job())
    await flush()

    expect(translate).toHaveBeenCalledTimes(2)
  })

  test('starts a queued request as soon as a slot frees', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 2 } })

    for (const id of ['m1', 'm2', 'm3']) store.translate(id, job())
    await flush()
    expect(translate).toHaveBeenCalledTimes(2)

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()

    expect(translate).toHaveBeenCalledTimes(3)
  })

  test('a failed request also frees its slot', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()
    expect(translate).toHaveBeenCalledTimes(1)

    translate.calls[0].reject(Object.assign(new Error('boom'), { code: 'internal' }))
    await flush()

    expect(translate).toHaveBeenCalledTimes(2)
  })
})

describe('read-through for a mounted message', () => {
  test('an off intent shows the source and issues no request', async () => {
    const { store, translate, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'off')

    await store.ensureForView('m1', { ...job(), autoTranslate: true })

    expect(translate).not.toHaveBeenCalled()
    expect(store.getEntry('m1').status).toBe('idle')
  })

  test('a manual intent translates even while the global switch is off', async () => {
    const { store, translate, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'manual')

    await store.ensureForView('m1', { ...job(), autoTranslate: false })

    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('no intent and the switch off leaves the message untranslated', async () => {
    const { store, translate } = makeStore()

    await store.ensureForView('m1', { ...job(), autoTranslate: false })

    expect(translate).not.toHaveBeenCalled()
  })

  test('a cached translation hydrates without touching the network', async () => {
    const { store, translate, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'manual')
    await cache.content.set({
      messageId: 'm1',
      roomId: 'r1',
      targetLang: 'ja',
      srcVersion: 1,
      translatedText: '[ja] hello',
      originalText: 'hello',
    })

    await store.ensureForView('m1', { ...job(), autoTranslate: false })

    expect(translate).not.toHaveBeenCalled()
    expect(store.getEntry('m1').status).toBe('translated')
    expect(store.getEntry('m1').translatedText).toBe('[ja] hello')
  })

  test('a cached translation in another language is refetched', async () => {
    const { store, translate, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'manual')
    await cache.content.set({
      messageId: 'm1',
      roomId: 'r1',
      targetLang: 'ja',
      srcVersion: 1,
      translatedText: '[ja] hello',
      originalText: 'hello',
    })

    await store.ensureForView('m1', { ...job({ targetLang: 'de' }), autoTranslate: false })

    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.calls[0].args.targetLang).toBe('de')
  })
})

describe('user intent', () => {
  test('translate records a manual intent so the choice outlives the cache', async () => {
    const { store, translate, cache } = makeStore()

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    expect(await cache.intent.get('m1')).toBe('manual')
  })

  test('revert writes off rather than deleting the intent', async () => {
    const { store, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'manual')

    await store.revert('m1', 'r1')

    expect(await cache.intent.get('m1')).toBe('off')
    expect(store.getEntry('m1').status).toBe('idle')
  })

  test('revert aborts an in-flight request', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job())
    await flush()
    await store.revert('m1', 'r1')

    expect(translate.calls[0].opts.signal.aborted).toBe(true)
  })

  test('an aborted request does not surface as failed', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job())
    await flush()
    await store.revert('m1', 'r1')
    await flush()

    expect(store.getEntry('m1').status).toBe('idle')
    expect(translate.calls[0].opts.signal.aborted).toBe(true)
  })
})

describe('message edited', () => {
  test('drops the stale translation but KEEPS the user intent', async () => {
    const { store, translate, cache } = makeStore()

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done
    expect(await cache.intent.get('m1')).toBe('manual')

    await store.onMessageEdited('m1', 'r1', 2)

    // Editing invalidates the translation, not the decision to translate.
    // Writing 'off' here is what would make an edited message permanently
    // opt out of automatic translation.
    expect(await cache.intent.get('m1')).toBe('manual')
    expect(await cache.content.peek('m1')).toBeUndefined()
    expect(store.getEntry('m1').status).toBe('idle')
  })

  test('a re-view after an edit re-translates at the new revision', async () => {
    const { store, translate, cache } = makeStore()
    await cache.intent.set('m1', 'r1', 'manual')
    await cache.content.set({
      messageId: 'm1',
      roomId: 'r1',
      targetLang: 'ja',
      srcVersion: 1,
      translatedText: '[ja] hello',
      originalText: 'hello',
    })

    await store.onMessageEdited('m1', 'r1', 2)
    await store.ensureForView('m1', {
      ...job({ srcVersion: 2, text: 'hello again' }),
      autoTranslate: false,
    })

    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.calls[0].args.text).toBe('hello again')
  })

  test('aborts an in-flight request for the superseded revision', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job())
    await flush()
    await store.onMessageEdited('m1', 'r1', 2)

    expect(translate.calls[0].opts.signal.aborted).toBe(true)
  })
})

describe('request budget per origin', () => {
  test('an automatic job asks for exactly one attempt', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job({ origin: 'auto' }))
    await flush()

    // The circuit breaker owns backoff for the automatic path. Letting the
    // transport run its own retry ladder underneath would turn one auto job
    // into three real requests against an already saturated backend, and hold
    // one of only two auto slots for the whole ladder.
    expect(translate.calls[0].opts.maxAttempts).toBe(1)
  })

  test('a manual job keeps the default ladder', async () => {
    const { store, translate } = makeStore()

    store.translate('m1', job())
    await flush()

    // Nothing is watching a manual request on the user's behalf, so the
    // transport default applies.
    expect(translate.calls[0].opts.maxAttempts).toBeUndefined()
  })
})

describe('automatic translation gate', () => {
  const auto = (overrides = {}) => ({ ...job(), origin: 'auto', ...overrides })

  test('automatic jobs are capped below the overall concurrency limit', async () => {
    const { store, translate } = makeStore({
      config: { maxConcurrent: 4, maxConcurrentAuto: 2 },
    })

    for (const id of ['m1', 'm2', 'm3', 'm4']) store.translate(id, auto())
    await flush()

    // The remaining slots are reserved: a message the user explicitly asks
    // for must not queue behind background work.
    expect(translate).toHaveBeenCalledTimes(2)
  })

  test('a manual request still runs while the automatic sub-gate is full', async () => {
    const { store, translate } = makeStore({
      config: { maxConcurrent: 4, maxConcurrentAuto: 2 },
    })

    for (const id of ['a1', 'a2', 'a3']) store.translate(id, auto())
    await flush()
    expect(translate).toHaveBeenCalledTimes(2)

    store.translate('m-manual', job())
    await flush()

    expect(translate).toHaveBeenCalledTimes(3)
    expect(translate.calls[2].args.text).toBe('hello')
  })

  test('an automatic job that scrolled out of view is dropped at pick time', async () => {
    // m0 and m1 are on screen; m2 is not by the time a slot frees.
    const visible = new Set(['m0', 'm1'])
    const { store, translate } = makeStore({
      config: { maxConcurrent: 1, maxConcurrentAuto: 1, isAutoEligible: (id) => visible.has(id) },
    })

    store.translate('m0', auto())
    await flush()
    // m2 is queued behind m0 but has left the viewport by the time a slot frees.
    store.translate('m2', auto())
    store.translate('m1', auto())
    await flush()

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()

    const requested = translate.calls.map((c) => c.args.text)
    expect(translate).toHaveBeenCalledTimes(2)
    expect(requested).toHaveLength(2)
    expect(store.getEntry('m2').status).toBe('idle')
  })

  test('a manual job is never dropped by the visibility filter', async () => {
    const { store, translate } = makeStore({
      config: { maxConcurrent: 1, isAutoEligible: () => false },
    })

    store.translate('m1', job())
    await flush()

    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('queued automatic jobs are picked in the injected order', async () => {
    const { store, translate } = makeStore({
      config: {
        maxConcurrent: 1,
        maxConcurrentAuto: 1,
        orderAutoQueue: (ids) => [...ids].reverse(),
      },
    })

    store.translate('first', auto({ text: 'first' }))
    await flush()
    store.translate('second', auto({ text: 'second' }))
    store.translate('third', auto({ text: 'third' }))
    await flush()

    translate.calls[0].resolve({ translatedText: 'x', targetLang: 'ja' })
    await flush()

    expect(translate.calls[1].args.text).toBe('third')
  })

  test('detaching an in-flight job frees its slot immediately', async () => {
    const { store, translate } = makeStore({
      config: { maxConcurrent: 1, maxConcurrentAuto: 1 },
    })

    store.translate('m1', auto())
    await flush()
    store.translate('m2', auto())
    await flush()
    expect(translate).toHaveBeenCalledTimes(1)

    store.detach('m1')
    await flush()

    // The reply is still coming; what must not happen is the queue sitting
    // idle waiting for a message nobody is looking at any more.
    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.calls[0].opts.signal.aborted).toBe(false)
  })

  test('a detached reply still lands, because the request was never cancelled', async () => {
    const { store, translate } = makeStore()

    const done = store.translate('m1', auto())
    await flush()
    store.detach('m1')

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    expect(store.getEntry('m1').status).toBe('translated')
  })
})

describe('message deleted', () => {
  test('clears both tables and forgets the entry', async () => {
    const { store, translate, cache } = makeStore()

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    await store.onMessagesDeleted(['m1'])

    expect(await cache.intent.get('m1')).toBeUndefined()
    expect(await cache.content.peek('m1')).toBeUndefined()
    expect(store.getEntry('m1').status).toBe('idle')
  })
})

describe('a request that never replies', () => {
  test('gives its slot back once the timeout elapses', async () => {
    // The failure this exists for: under request/reply a lost reply produces
    // no rejection at all, so without a timeout the slot is held forever and
    // the queue behind it never moves again.
    const { store, translate } = makeStore({
      config: { maxConcurrent: 1, timeoutMs: 20 },
    })

    store.translate('m1', job())
    await flush()
    store.translate('m2', job())
    await flush()

    expect(translate.calls).toHaveLength(1)

    await sleep(60)

    // The stalled job ended and the one behind it got the slot. Without the
    // timeout the second request is never made at all.
    expect(translate.calls).toHaveLength(2)
    expect(store.getEntry('m1').status).toBe('failed')
  })

  test('is reported as a failure rather than an abort, so an outage is visible', async () => {
    // The timeout cancels the request, and a cancelled request rejects with
    // AbortError. Reporting that as "aborted" would exempt it from failure
    // accounting — which is how a circuit breaker sits open-eyed through a
    // total outage.
    const { store } = makeStore({ config: { timeoutMs: 20 } })

    const done = store.translate('m1', job())
    const outcome = await done

    expect(outcome.ok).toBe(false)
    expect(outcome.aborted).toBeFalsy()
    expect(outcome.superseded).toBeFalsy()
    expect(outcome.error.code).toBe('timeout')
    expect(store.getEntry('m1').status).toBe('failed')
  })

  test('the timer is dropped when the reply arrives in time', async () => {
    const { store, translate } = makeStore({ config: { timeoutMs: 30 } })

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await done

    expect(store.getEntry('m1').status).toBe('translated')

    // A timeout that still fires after a success would knock a translated
    // message back to failed for no reason.
    await sleep(60)
    expect(store.getEntry('m1').status).toBe('translated')
  })

  test('no timeout is applied when the ceiling is zero', async () => {
    const { store } = makeStore({ config: { timeoutMs: 0 } })

    store.translate('m1', job())
    await sleep(40)

    expect(store.getEntry('m1').status).toBe('loading')
  })
})

describe('queue ceiling', () => {
  function saturate() {
    const made = makeStore({ config: { maxConcurrent: 1, maxQueueLength: 2 } })
    return made
  }

  test('refuses a new automatic job once the queue is at its ceiling', async () => {
    const { store } = saturate()

    store.translate('m1', job({ origin: 'auto' })) // runs
    store.translate('m2', job({ origin: 'auto' })) // queued 1
    store.translate('m3', job({ origin: 'auto' })) // queued 2 — at the ceiling
    await flush()

    const outcome = await store.translate('m4', job({ origin: 'auto' }))

    expect(outcome.dropped).toBe(true)
    expect(store.stats().queued).toBe(2)
  })

  test('leaves a refused automatic job idle so a later view can retry it', async () => {
    const { store } = saturate()

    store.translate('m1', job({ origin: 'auto' }))
    store.translate('m2', job({ origin: 'auto' }))
    store.translate('m3', job({ origin: 'auto' }))
    await flush()
    await store.translate('m4', job({ origin: 'auto' }))

    // Not 'failed': nothing was attempted. Leaving it failed would put an
    // error on a message that was never sent.
    expect(store.getEntry('m4').status).toBe('idle')
  })

  test('never refuses an explicit request, however long the queue is', async () => {
    const { store } = saturate()

    store.translate('m1', job({ origin: 'auto' }))
    store.translate('m2', job({ origin: 'auto' }))
    store.translate('m3', job({ origin: 'auto' }))
    await flush()

    store.translate('m4', job({ origin: 'manual' }))
    await flush()

    // The user asked for this one. A background ceiling must never be the
    // reason a click does nothing.
    expect(store.getEntry('m4').status).toBe('queued')
    expect(store.stats().queued).toBe(3)
  })

  test('a view request for a full queue reports the drop instead of queueing', async () => {
    const { store } = saturate()

    store.translate('m1', job({ origin: 'auto' }))
    store.translate('m2', job({ origin: 'auto' }))
    store.translate('m3', job({ origin: 'auto' }))
    await flush()

    const result = await store.ensureForView('m9', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })

    // 'dropped', not 'queued': the policy layer charges its rate budget and
    // its circuit breaker on 'queued' alone, and neither should move for a
    // request that was never made.
    expect(result.outcome).toBe('dropped')
  })
})

describe('reporting whether a request actually went out', () => {
  test('resolves sent=true when the request reaches the wire', async () => {
    const { store } = makeStore()

    const result = await store.ensureForView('m1', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })

    expect(result.outcome).toBe('queued')
    await expect(result.sent).resolves.toBe(true)
  })

  test('resolves sent=false for a job dropped before it was picked', async () => {
    // The distinction the rate limiter depends on. An accepted candidate is
    // not a request: most of them are dropped at pick time because their
    // message scrolled away while they waited.
    const visible = new Set()
    const { store } = makeStore({
      config: { maxConcurrent: 1, maxConcurrentAuto: 1, isAutoEligible: (id) => visible.has(id) },
    })

    visible.add('m1')
    store.translate('m1', job({ origin: 'auto' }))
    await flush()

    const result = await store.ensureForView('m2', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })
    expect(result.outcome).toBe('queued')

    // m2 never becomes visible, so when the slot frees it is dropped.
    store.detach('m1')
    await flush()

    await expect(result.sent).resolves.toBe(false)
  })

  test('resolves sent=false when the queue ceiling refuses the job', async () => {
    const { store } = makeStore({ config: { maxConcurrent: 1, maxQueueLength: 1 } })

    store.translate('m1', job({ origin: 'auto' }))
    store.translate('m2', job({ origin: 'auto' }))
    await flush()

    const result = await store.ensureForView('m3', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })

    expect(result.outcome).toBe('dropped')
    await expect(result.sent).resolves.toBe(false)
  })
})

describe('a queued job whose state moves on is purged, not run', () => {
  test('reverting a queued message removes its job before it can be sent', async () => {
    // invalidate() aborts the in-flight request, but a job still WAITING for
    // a slot has no controller to abort — left in the queue it eventually
    // sends a request whose reply is unusable, for a message the user
    // explicitly asked to see in the original.
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()
    expect(store.stats().queued).toBe(1)

    await store.revert('m2', 'r1')
    expect(store.stats().queued).toBe(0)

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()
    await flush()

    expect(translate).toHaveBeenCalledTimes(1)
    expect(store.getEntry('m2').status).toBe('idle')
  })

  test('switching language while queued replaces the job instead of stacking two', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job({ targetLang: 'ja' }))
    await flush()
    store.translate('m2', job({ targetLang: 'de' }))
    await flush()

    expect(store.stats().queued).toBe(1)

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()
    await flush()

    // Only the de job may reach the wire for m2.
    const m2Calls = translate.calls.slice(1)
    expect(m2Calls).toHaveLength(1)
    expect(m2Calls[0].args.targetLang).toBe('de')
  })

  test('editing a message purges its queued job', async () => {
    const { store, translate } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    store.translate('m2', job())
    await flush()

    await store.onMessageEdited('m2')
    expect(store.stats().queued).toBe(0)

    translate.calls[0].resolve({ translatedText: '[ja] hello', targetLang: 'ja' })
    await flush()
    await flush()

    expect(translate).toHaveBeenCalledTimes(1)
  })

  test('a purged job resolves as never-sent, so no budget is charged for it', async () => {
    const { store } = makeStore({ config: { maxConcurrent: 1 } })

    store.translate('m1', job())
    const result = await store.ensureForView('m2', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })
    expect(result.outcome).toBe('queued')

    await store.revert('m2', 'r1')

    await expect(result.sent).resolves.toBe(false)
  })
})

describe('revert racing an in-progress view decision', () => {
  test('a revert landing between the intent read and the enqueue wins', async () => {
    // ensureForView is not atomic: intent read, then a content read (an IDB
    // round trip), then the enqueue. A revert landing inside that window used
    // to be overwritten — the enqueue took a fresh generation and translated
    // a message whose user had just said "see original". Found by the chaos
    // harness (seed 83).
    const cache = makeCache()
    let releaseContentRead
    const gate = new Promise((r) => {
      releaseContentRead = r
    })
    const gatedCache = {
      ...cache,
      intent: cache.intent,
      content: {
        ...cache.content,
        get: async (...args) => {
          await gate
          return cache.content.get(...args)
        },
      },
    }
    const { store, translate } = makeStore({ cache: gatedCache })

    const pending = store.ensureForView('m1', {
      roomId: 'r1',
      text: 'hello',
      targetLang: 'ja',
      srcVersion: 1,
      autoTranslate: true,
    })
    await flush()

    await store.revert('m1', 'r1')
    releaseContentRead()
    const result = await pending

    expect(result.outcome).not.toBe('queued')
    expect(translate).not.toHaveBeenCalled()
    expect(store.getEntry('m1').status).toBe('idle')
  })
})

describe('a local fault is not a backend failure', () => {
  test('a translation whose cache write fails is still translated', async () => {
    // Quota exhausted, private-mode database, corrupt store. The backend
    // replied correctly and the text is in hand; the only loss is that it has
    // to be fetched again next time. Reporting this as a failed translation
    // discards a good result, shows the user an error, and — because the
    // policy layer counts settled failures — walks the automatic circuit
    // breaker toward switching the feature off over a fault the backend had
    // no part in.
    const { store, translate, cache } = makeStore()
    vi.spyOn(cache.content, 'set').mockRejectedValue(new Error('QuotaExceededError'))

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: 'こんにちは' })

    expect(await done).toMatchObject({ ok: true })
    expect(store.getEntry('m1')).toMatchObject({
      status: 'translated',
      translatedText: 'こんにちは',
    })
  })

  test('the failed write is recorded, so a missing cache is still diagnosable', async () => {
    const log = createDecisionLog({ printing: false })
    const { store, translate, cache } = makeStore({ log })
    vi.spyOn(cache.content, 'set').mockRejectedValue(new Error('QuotaExceededError'))

    const done = store.translate('m1', job())
    await flush()
    translate.calls[0].resolve({ translatedText: 'こんにちは' })
    await done

    const violation = log.records().find((r) => r.reason === 'cache-write-failed')
    expect(violation).toBeDefined()
    expect(violation.messageId).toBe('m1')
  })
})

describe('every path out of translateMessage settles `sent`', () => {
  // ensureForView reports `outcome: 'queued'` for every call that reaches
  // translateMessage, and hands back the `sent` promise unconditionally. A
  // caller that awaits it — the policy layer does, to decide whether to
  // charge its rate budget — hangs forever on any path that returns without
  // resolving it, and takes the circuit breaker's probe token down with it.
  test('the dedupe path resolves it false', async () => {
    const { store } = makeStore()
    store.translate('m1', job())
    await flush()

    let settled = null
    const second = store.translate('m1', { ...job(), onSent: (v) => (settled = v) })

    await expect(second).resolves.toMatchObject({ deduped: true })
    expect(settled).toBe(false)
  })

  test('the refusal path resolves it false', async () => {
    // The queue ceiling applies to automatic jobs only.
    const { store } = makeStore({ config: { maxQueueLength: 1, maxConcurrent: 1 } })
    store.translate('a', { ...job(), origin: 'auto' })
    await flush()
    store.translate('b', { ...job(), origin: 'auto' })
    await flush()

    let settled = null
    await store.translate('c', {
      ...job(),
      origin: 'auto',
      onSent: (v) => (settled = v),
    })
    expect(settled).toBe(false)
  })
})
