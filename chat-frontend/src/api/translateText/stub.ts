// Dev stand-in for the translation backend.
//
// Same signature as `translateText`, so it is injected in place of the real
// operation rather than branching inside it — the retry ladder, the queue and
// the abort plumbing all stay on their production code paths.
//
// The failure modes are the point: `slow` and `no-reply` are how you hold
// queue slots open long enough to watch concurrency behave, and `unavailable`
// is how you drive the retry ladder without a saturated backend.

import { SUPPORTED_TARGET_LANGS } from '@/lib/translationSettings'
import { AsyncJobError, ASYNC_JOB_ERROR_KINDS } from '../_transport/asyncJob'
import type { Nats } from '../types'
import type { TranslateTextArgs, TranslateTextOptions, TranslateTextResponse } from './index'

export const TRANSLATE_STUB_MODES = [
  'normal',
  'slow',
  'no-reply',
  'unavailable',
  'internal',
  'identical',
] as const

export type TranslateStubMode = (typeof TRANSLATE_STUB_MODES)[number]

export interface TranslateStubOptions {
  mode?: TranslateStubMode
  delayMs?: number
}

function envelope(code: string, reason?: string, message = `stub: ${code}`): AsyncJobError {
  return new AsyncJobError(message, ASYNC_JOB_ERROR_KINDS.SyncError, {
    code,
    reason,
  } as never)
}

function abortError(): Error {
  const err = new Error('translate aborted')
  err.name = 'AbortError'
  return err
}

/** Resolves after `ms`, or rejects as soon as the signal aborts. `ms === null`
 *  never resolves — that is the lost-reply mode. */
function wait(ms: number | null, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      reject(abortError())
    }
    const timer =
      ms === null
        ? undefined
        : setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createTranslateTextStub({
  mode = 'normal',
  delayMs = 250,
}: TranslateStubOptions = {}) {
  return async function translateTextStub(
    _nats: Nats,
    { text, targetLang }: TranslateTextArgs,
    opts?: TranslateTextOptions,
  ): Promise<TranslateTextResponse> {
    // Validation runs before the mode so an input the real backend would
    // reject fails the same way here, whichever failure mode is selected.
    if (!text) throw envelope('bad_request', 'empty_text', 'text is empty')
    if (!SUPPORTED_TARGET_LANGS.includes(targetLang)) {
      throw envelope('bad_request', 'unsupported_lang', 'unsupported targetLang')
    }

    if (mode === 'no-reply') {
      await wait(null, opts?.signal)
    }

    await wait(delayMs, opts?.signal)

    switch (mode) {
      case 'unavailable':
        throw envelope('unavailable', undefined, 'handler saturated')
      case 'internal':
        throw envelope('internal', undefined, 'internal error')
      case 'identical':
        // Exercises the identical path: a same-language reply must be cached
        // as a zero-byte hit, not re-requested forever.
        return { translatedText: text, targetLang }
      default:
        return { translatedText: `[${targetLang}] ${text}`, targetLang }
    }
  }
}
