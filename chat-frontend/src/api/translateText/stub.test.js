import { afterEach, describe, expect, test, vi } from 'vitest'
import { TRANSLATE_STUB_MODES, createTranslateTextStub } from './stub'

afterEach(() => {
  vi.useRealTimers()
})

const nats = { user: { account: 'alice', siteId: 'site-a' } }

describe('modes', () => {
  test('exposes the six dev modes', () => {
    expect(TRANSLATE_STUB_MODES).toEqual([
      'normal',
      'slow',
      'no-reply',
      'unavailable',
      'internal',
      'identical',
    ])
  })

  test('normal returns a marked translation echoing the requested language', async () => {
    const translate = createTranslateTextStub({ mode: 'normal', delayMs: 0 })
    const result = await translate(nats, { text: 'hello', targetLang: 'ja' })

    expect(result.targetLang).toBe('ja')
    expect(result.translatedText).toContain('hello')
    expect(result.translatedText).not.toBe('hello')
  })

  test('identical echoes the source unchanged so the identical flag engages', async () => {
    const translate = createTranslateTextStub({ mode: 'identical', delayMs: 0 })
    const result = await translate(nats, { text: 'hello', targetLang: 'ja' })

    expect(result.translatedText).toBe('hello')
  })

  test('unavailable rejects with a retryable envelope', async () => {
    const translate = createTranslateTextStub({ mode: 'unavailable', delayMs: 0 })
    await expect(translate(nats, { text: 'hello', targetLang: 'ja' })).rejects.toMatchObject({
      code: 'unavailable',
    })
  })

  test('internal rejects with a non-retryable envelope', async () => {
    const translate = createTranslateTextStub({ mode: 'internal', delayMs: 0 })
    await expect(translate(nats, { text: 'hello', targetLang: 'ja' })).rejects.toMatchObject({
      code: 'internal',
    })
  })

  test('no-reply never settles until aborted — models a lost reply', async () => {
    const translate = createTranslateTextStub({ mode: 'no-reply' })
    const controller = new AbortController()
    const settled = vi.fn()

    const promise = translate(
      nats,
      { text: 'hello', targetLang: 'ja' },
      { signal: controller.signal },
    )
    promise.then(settled, settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    controller.abort()
    await expect(promise).rejects.toThrow(/abort/i)
  })
})

describe('input validation mirrors the backend', () => {
  test('empty text is rejected as bad_request/empty_text without a round trip', async () => {
    const translate = createTranslateTextStub({ mode: 'normal', delayMs: 0 })
    await expect(translate(nats, { text: '', targetLang: 'ja' })).rejects.toMatchObject({
      code: 'bad_request',
      reason: 'empty_text',
    })
  })

  test('an unsupported targetLang is rejected as bad_request/unsupported_lang', async () => {
    const translate = createTranslateTextStub({ mode: 'normal', delayMs: 0 })
    await expect(translate(nats, { text: 'hello', targetLang: 'klingon' })).rejects.toMatchObject({
      code: 'bad_request',
      reason: 'unsupported_lang',
    })
  })
})

describe('latency', () => {
  test('slow holds the reply for the configured delay', async () => {
    vi.useFakeTimers()
    const translate = createTranslateTextStub({ mode: 'slow', delayMs: 3000 })
    const settled = vi.fn()

    const promise = translate(nats, { text: 'hello', targetLang: 'ja' })
    promise.then(settled, settled)

    await vi.advanceTimersByTimeAsync(2999)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await promise
    expect(settled).toHaveBeenCalled()
  })

  test('an abort during the delay rejects instead of resolving late', async () => {
    vi.useFakeTimers()
    const translate = createTranslateTextStub({ mode: 'slow', delayMs: 3000 })
    const controller = new AbortController()

    const promise = translate(
      nats,
      { text: 'hello', targetLang: 'ja' },
      { signal: controller.signal },
    )
    const assertion = expect(promise).rejects.toThrow(/abort/i)

    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await assertion
  })
})
