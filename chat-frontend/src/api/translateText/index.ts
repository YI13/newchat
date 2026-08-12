import { translateText as translateTextSubject } from '../_transport/subjects'
import type { Nats } from '../types'

export interface TranslateTextArgs {
  text: string
  /** BCP-47 tag from the local translation settings, e.g. `zh-Hant-TW`. */
  targetLang: string
}

export interface TranslateTextResponse {
  translatedText: string
  targetLang: string
}

export interface TranslateTextOptions {
  /**
   * Honoured before each attempt and during backoff sleeps — NOT mid-flight.
   * nats.ws's RequestOptions carries no abort support, and cancelling the
   * wait would buy nothing anyway: the publish has already happened, so the
   * backend completes the work regardless, and the wire bounds every attempt
   * at requestSync's own 5s timeout. Slot accounting deliberately does not
   * depend on this signal; the store's timeout and detach() own that.
   */
  signal?: AbortSignal
  /**
   * Request budget for one logical translation. The automatic path passes 1
   * and lets its circuit breaker own the backoff: keeping the default there
   * would turn every auto job into three real requests against an already
   * saturated backend, and hold a queue slot for the whole retry ladder.
   */
  maxAttempts?: number
}

export const TRANSLATE_DEFAULT_MAX_ATTEMPTS = 3
export const TRANSLATE_RETRY_BACKOFF_MS = [500, 1000, 2000]

/** Only a saturated handler is worth retrying. Rejected input stays rejected,
 *  and an internal failure has already been logged server-side. */
function isRetryable(err: unknown): boolean {
  return (err as { code?: string })?.code === 'unavailable'
}

function abortError(): Error {
  const err = new Error('translate aborted')
  err.name = 'AbortError'
  return err
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Translate one message body.
 *
 * Synchronous request/reply: the reply lands on the auto-generated inbox, so
 * the payload carries no correlation id. `siteId` is the caller's own site —
 * translation is stateless and never crosses sites.
 */
export async function translateText(
  nats: Nats,
  { text, targetLang }: TranslateTextArgs,
  opts?: TranslateTextOptions,
): Promise<TranslateTextResponse> {
  const { user, request } = nats
  const maxAttempts = opts?.maxAttempts ?? TRANSLATE_DEFAULT_MAX_ATTEMPTS
  const subject = translateTextSubject(user.account, user.siteId)

  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (opts?.signal?.aborted) throw abortError()

    try {
      return await request<TranslateTextResponse>(subject, { text, targetLang })
    } catch (err) {
      lastError = err
      if (!isRetryable(err)) throw err
      if (attempt === maxAttempts - 1) break
      await sleep(TRANSLATE_RETRY_BACKOFF_MS[attempt], opts?.signal)
    }
  }
  throw lastError
}
