import { afterEach, describe, expect, test, vi } from 'vitest'
import { AsyncJobError, ASYNC_JOB_ERROR_KINDS } from '../_transport/asyncJob'
import {
  TRANSLATE_DEFAULT_MAX_ATTEMPTS,
  TRANSLATE_RETRY_BACKOFF_MS,
  translateText,
} from './index'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function makeNats(request) {
  return {
    user: { account: 'alice', siteId: 'site-a' },
    request,
    publish: vi.fn(),
    subscribe: vi.fn(),
    requestWithAsyncResult: vi.fn(),
  }
}

function envelopeError(code, reason) {
  return new AsyncJobError(`boom: ${code}`, ASYNC_JOB_ERROR_KINDS.SyncError, { code, reason })
}

// Runs `fn` while draining the backoff timers it schedules, so retry tests
// don't spend real seconds sleeping.
async function withFakeTimers(fn) {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    // Capture the outcome before draining the timers. Awaiting the drain
    // first would leave this promise floating, and a rejection landing in
    // that window is reported as unhandled even though it is awaited one line
    // later — noise that hides a genuinely unhandled rejection elsewhere.
    const settled = fn().then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )
    await vi.runAllTimersAsync()
    const result = await settled
    if (!result.ok) throw result.error
    return result.value
  } finally {
    vi.useRealTimers()
  }
}

describe('subject and payload', () => {
  test('requests on the per-account translate subject for the caller own site', async () => {
    const request = vi.fn().mockResolvedValue({ translatedText: 'hallo', targetLang: 'de' })
    await translateText(makeNats(request), { text: 'hello', targetLang: 'de' })

    expect(request).toHaveBeenCalledWith('chat.user.alice.request.translate.site-a.text', {
      text: 'hello',
      targetLang: 'de',
    })
  })

  test('sends no requestId — the reply arrives on the request/reply inbox', async () => {
    const request = vi.fn().mockResolvedValue({ translatedText: 'hallo', targetLang: 'de' })
    await translateText(makeNats(request), { text: 'hello', targetLang: 'de' })

    const [, payload] = request.mock.calls[0]
    expect(payload).not.toHaveProperty('requestId')
    expect(Object.keys(payload).sort()).toEqual(['targetLang', 'text'])
  })

  test('returns the reply unchanged', async () => {
    const request = vi.fn().mockResolvedValue({ translatedText: 'こんにちは', targetLang: 'ja' })
    const result = await translateText(makeNats(request), { text: 'hello', targetLang: 'ja' })

    expect(result).toEqual({ translatedText: 'こんにちは', targetLang: 'ja' })
  })
})

describe('retry policy', () => {
  test('defaults to three attempts with 500/1000/2000ms backoff', () => {
    expect(TRANSLATE_DEFAULT_MAX_ATTEMPTS).toBe(3)
    expect(TRANSLATE_RETRY_BACKOFF_MS).toEqual([500, 1000, 2000])
  })

  test('retries an unavailable reply and succeeds on a later attempt', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(envelopeError('unavailable'))
      .mockRejectedValueOnce(envelopeError('unavailable'))
      .mockResolvedValue({ translatedText: 'hallo', targetLang: 'de' })

    const result = await withFakeTimers(() =>
      translateText(makeNats(request), { text: 'hello', targetLang: 'de' }),
    )

    expect(request).toHaveBeenCalledTimes(3)
    expect(result.translatedText).toBe('hallo')
  })

  test('gives up after the attempt budget and rethrows the last error', async () => {
    const request = vi.fn().mockRejectedValue(envelopeError('unavailable'))

    await expect(
      withFakeTimers(() => translateText(makeNats(request), { text: 'hello', targetLang: 'de' })),
    ).rejects.toMatchObject({ code: 'unavailable' })

    expect(request).toHaveBeenCalledTimes(3)
  })

  test('maxAttempts 1 issues exactly one request — the auto path leaves backoff to the circuit breaker', async () => {
    const request = vi.fn().mockRejectedValue(envelopeError('unavailable'))

    await expect(
      translateText(makeNats(request), { text: 'hello', targetLang: 'de' }, { maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: 'unavailable' })

    expect(request).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['bad_request', 'empty_text'],
    ['bad_request', 'unsupported_lang'],
    ['internal', undefined],
  ])('does not retry %s / %s', async (code, reason) => {
    const request = vi.fn().mockRejectedValue(envelopeError(code, reason))

    await expect(
      translateText(makeNats(request), { text: 'hello', targetLang: 'de' }),
    ).rejects.toMatchObject({ code })

    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('abort', () => {
  test('rejects immediately when the signal is already aborted, without requesting', async () => {
    const request = vi.fn()
    const controller = new AbortController()
    controller.abort()

    await expect(
      translateText(
        makeNats(request),
        { text: 'hello', targetLang: 'de' },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/abort/i)

    expect(request).not.toHaveBeenCalled()
  })

  test('stops retrying once the signal aborts mid-backoff', async () => {
    const controller = new AbortController()
    const request = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(envelopeError('unavailable'))
    })

    await expect(
      withFakeTimers(() =>
        translateText(
          makeNats(request),
          { text: 'hello', targetLang: 'de' },
          { signal: controller.signal },
        ),
      ),
    ).rejects.toThrow(/abort/i)

    expect(request).toHaveBeenCalledTimes(1)
  })
})
