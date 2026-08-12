import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { CACHE_BYTE_CAP, DEFAULT_PRUNE_BATCH, createTranslationCache } from './index'

// Each test gets its own database, so nothing leaks between tests and the
// byte cap can be shrunk to something a test can actually fill.
let openCaches = []

function makeCache(opts = {}) {
  const cache = createTranslationCache({
    dbName: `test-translation-${openCaches.length}-${Math.random().toString(36).slice(2)}`,
    ...opts,
  })
  openCaches.push(cache)
  return cache
}

afterEach(async () => {
  for (const cache of openCaches) await cache.destroy()
  openCaches = []
})

function contentEntry(overrides = {}) {
  return {
    messageId: 'm1',
    roomId: 'r1',
    targetLang: 'ja',
    srcVersion: 1,
    translatedText: 'こんにちは',
    originalText: 'hello',
    ...overrides,
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('production defaults', () => {
  test('caps the content table at ~50MB and prunes in 10000-row batches', () => {
    expect(CACHE_BYTE_CAP).toBe(50 * 1024 * 1024)
    expect(DEFAULT_PRUNE_BATCH).toBe(10000)
  })
})

describe('intent table', () => {
  test('round-trips manual and off', async () => {
    const cache = makeCache()
    await cache.intent.set('m1', 'r1', 'manual')
    expect(await cache.intent.get('m1')).toBe('manual')

    await cache.intent.set('m1', 'r1', 'off')
    expect(await cache.intent.get('m1')).toBe('off')
  })

  test('returns undefined for a message with no recorded intent', async () => {
    const cache = makeCache()
    expect(await cache.intent.get('nope')).toBeUndefined()
  })

  test('rejects a mode outside manual|off', async () => {
    const cache = makeCache()
    // There is deliberately no 'auto' mode: automatic translation is derived
    // from "no intent + global switch on", so recording one would break the
    // "turn auto off -> instantly back to source" property.
    await expect(cache.intent.set('m1', 'r1', 'auto')).rejects.toThrow()
    expect(await cache.intent.get('m1')).toBeUndefined()
  })

  test('clear removes a single message intent', async () => {
    const cache = makeCache()
    await cache.intent.set('m1', 'r1', 'manual')
    await cache.intent.clear('m1')
    expect(await cache.intent.get('m1')).toBeUndefined()
  })
})

describe('content table hit/miss guards', () => {
  test('round-trips a translation', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry())
    const row = await cache.content.get('m1', { targetLang: 'ja', srcVersion: 1 })
    expect(row.translatedText).toBe('こんにちは')
    expect(row.identical).toBe(false)
  })

  test('misses when the requested targetLang differs', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry())
    expect(await cache.content.get('m1', { targetLang: 'de', srcVersion: 1 })).toBeUndefined()
  })

  test('misses when srcVersion differs — an edited message must re-translate', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry())
    expect(await cache.content.get('m1', { targetLang: 'ja', srcVersion: 2 })).toBeUndefined()
  })

  test('compares srcVersion with !== so 1 and "1" are a miss', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry({ srcVersion: 1 }))
    expect(await cache.content.get('m1', { targetLang: 'ja', srcVersion: '1' })).toBeUndefined()
  })

  test('a hit advances lastAccessAt so the LRU sees the read', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry())
    const before = (await cache.content.peek('m1')).lastAccessAt
    await tick()
    await cache.content.get('m1', { targetLang: 'ja', srcVersion: 1 })
    expect((await cache.content.peek('m1')).lastAccessAt).toBeGreaterThan(before)
  })
})

describe('identical translations', () => {
  test('stores an empty blob with zero bytes and the identical flag', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry({ translatedText: 'hello', originalText: 'hello' }))
    const row = await cache.content.peek('m1')
    expect(row.identical).toBe(true)
    expect(row.translatedText).toBe('')
    expect(row.bytes).toBe(0)
  })

  test('an identical row is still a cache hit — it must not re-request forever', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry({ translatedText: 'hello', originalText: 'hello' }))
    const row = await cache.content.get('m1', { targetLang: 'ja', srcVersion: 1 })
    expect(row).toBeDefined()
    expect(row.identical).toBe(true)
  })
})

describe('content.clear (the edit path)', () => {
  test('drops the text but leaves the intent standing', async () => {
    const cache = makeCache()
    await cache.intent.set('m1', 'r1', 'manual')
    await cache.content.set(contentEntry({ translatedText: 'aaa', originalText: 'x' }))

    await cache.content.clear('m1')

    expect(await cache.content.peek('m1')).toBeUndefined()
    expect(await cache.intent.get('m1')).toBe('manual')
  })

  test('gives the removed bytes back to the running total', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry({ translatedText: 'aaa', originalText: 'x' }))
    expect(await cache.getRunningTotal()).toBe(3)

    await cache.content.clear('m1')
    expect(await cache.getRunningTotal()).toBe(0)
  })

  test('is a no-op for a message with nothing cached', async () => {
    const cache = makeCache()
    await expect(cache.content.clear('absent')).resolves.toBeUndefined()
    expect(await cache.getRunningTotal()).toBe(0)
  })
})

describe('byte accounting', () => {
  test('running total reflects the UTF-8 size of stored translations', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry({ messageId: 'm1', translatedText: 'abc', originalText: 'x' }))
    expect(await cache.getRunningTotal()).toBe(3)

    await cache.content.set(contentEntry({ messageId: 'm2', translatedText: 'あ', originalText: 'x' }))
    expect(await cache.getRunningTotal()).toBe(3 + 3) // 'あ' is 3 UTF-8 bytes
  })

  test('overwriting a row subtracts the previous bytes before adding the new ones', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry({ translatedText: 'aaaaa', originalText: 'x' }))
    expect(await cache.getRunningTotal()).toBe(5)

    await cache.content.set(contentEntry({ translatedText: 'bb', originalText: 'x' }))
    expect(await cache.getRunningTotal()).toBe(2)
  })

  test('clearMessages subtracts the bytes it removes', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry({ messageId: 'm1', translatedText: 'aaa', originalText: 'x' }))
    await cache.content.set(contentEntry({ messageId: 'm2', translatedText: 'bbbb', originalText: 'x' }))
    expect(await cache.getRunningTotal()).toBe(7)

    await cache.clearMessages(['m1'])
    expect(await cache.getRunningTotal()).toBe(4)
  })

  test('clearRoom subtracts the bytes it removes', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry({ messageId: 'm1', roomId: 'r1', translatedText: 'aaa', originalText: 'x' }))
    await cache.content.set(contentEntry({ messageId: 'm2', roomId: 'r2', translatedText: 'bbbb', originalText: 'x' }))
    expect(await cache.getRunningTotal()).toBe(7)

    await cache.clearRoom('r1')
    expect(await cache.getRunningTotal()).toBe(4)
  })

  test('a cold running total is recomputed from the bytes index, not assumed zero', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry({ translatedText: 'aaaaa', originalText: 'x' }))

    // Simulate a fresh page load against an existing database: a second handle
    // over the same store starts with no in-memory total.
    const reopened = makeCache({ dbName: cache.dbName })
    expect(await reopened.getRunningTotal()).toBe(5)
  })

  test('an empty database recomputes to 0 and stays 0 — zero is a real total, not "unknown"', async () => {
    const cache = makeCache()
    expect(await cache.getRunningTotal()).toBe(0)
    await cache.content.set(contentEntry({ translatedText: 'ab', originalText: 'x' }))
    expect(await cache.getRunningTotal()).toBe(2)
  })

  test('clearAll resets the running total to 0', async () => {
    const cache = makeCache()
    await cache.content.set(contentEntry({ translatedText: 'aaa', originalText: 'x' }))
    await cache.clearAll()
    expect(await cache.getRunningTotal()).toBe(0)
  })
})

describe('lifecycle clears span both tables', () => {
  test('clearRoom removes intent and content for that room only', async () => {
    const cache = makeCache()
    await cache.intent.set('m1', 'r1', 'manual')
    await cache.content.set(contentEntry({ messageId: 'm1', roomId: 'r1' }))
    await cache.intent.set('m2', 'r2', 'off')
    await cache.content.set(contentEntry({ messageId: 'm2', roomId: 'r2' }))

    await cache.clearRoom('r1')

    expect(await cache.intent.get('m1')).toBeUndefined()
    expect(await cache.content.peek('m1')).toBeUndefined()
    expect(await cache.intent.get('m2')).toBe('off')
    expect(await cache.content.peek('m2')).toBeDefined()
  })

  test('clearMessages removes intent and content for the listed ids', async () => {
    const cache = makeCache()
    await cache.intent.set('m1', 'r1', 'manual')
    await cache.content.set(contentEntry({ messageId: 'm1' }))

    await cache.clearMessages(['m1'])

    expect(await cache.intent.get('m1')).toBeUndefined()
    expect(await cache.content.peek('m1')).toBeUndefined()
  })

  test('clearAll wipes both tables — a different account must not inherit state', async () => {
    const cache = makeCache()
    await cache.intent.set('m1', 'r1', 'manual')
    await cache.content.set(contentEntry())

    await cache.clearAll()

    expect(await cache.intent.get('m1')).toBeUndefined()
    expect(await cache.content.peek('m1')).toBeUndefined()
  })
})

describe('byte-LRU pruning', () => {
  test('evicts the least recently accessed rows until the total is under the cap', async () => {
    const cache = makeCache({ byteCap: 10 })

    await cache.content.set(contentEntry({ messageId: 'old', translatedText: 'aaaa', originalText: 'x' }))
    await tick()
    await cache.content.set(contentEntry({ messageId: 'mid', translatedText: 'bbbb', originalText: 'x' }))
    await tick()
    // Pushes the total to 12 > 10, so the oldest row must go.
    await cache.content.set(contentEntry({ messageId: 'new', translatedText: 'cccc', originalText: 'x' }))

    expect(await cache.content.peek('old')).toBeUndefined()
    expect(await cache.content.peek('mid')).toBeDefined()
    expect(await cache.content.peek('new')).toBeDefined()
    expect(await cache.getRunningTotal()).toBeLessThanOrEqual(10)
  })

  test('a recent read protects a row from eviction', async () => {
    const cache = makeCache({ byteCap: 10 })

    await cache.content.set(contentEntry({ messageId: 'a', translatedText: 'aaaa', originalText: 'x' }))
    await tick()
    await cache.content.set(contentEntry({ messageId: 'b', translatedText: 'bbbb', originalText: 'x' }))
    await tick()
    // Touch 'a' so 'b' becomes the least recently used.
    await cache.content.get('a', { targetLang: 'ja', srcVersion: 1 })
    await tick()
    await cache.content.set(contentEntry({ messageId: 'c', translatedText: 'cccc', originalText: 'x' }))

    expect(await cache.content.peek('a')).toBeDefined()
    expect(await cache.content.peek('b')).toBeUndefined()
  })

  test('pruning never removes intent rows — display state is not a cache', async () => {
    const cache = makeCache({ byteCap: 4 })

    await cache.intent.set('a', 'r1', 'off')
    await cache.content.set(contentEntry({ messageId: 'a', translatedText: 'aaaa', originalText: 'x' }))
    await tick()
    await cache.content.set(contentEntry({ messageId: 'b', translatedText: 'bbbb', originalText: 'x' }))

    expect(await cache.content.peek('a')).toBeUndefined()
    expect(await cache.intent.get('a')).toBe('off')
  })
})
