import { describe, expect, test } from 'vitest'
import { translationErrorToast } from './translationErrorCopy'

/** Minimal stand-in for the errcode envelope the transport throws. */
function envelope(code, reason) {
  const err = new Error(`stub: ${code}`)
  err.code = code
  if (reason) err.reason = reason
  return err
}

describe('translationErrorToast', () => {
  test('a 429 asks the user to retry later', () => {
    expect(translationErrorToast(envelope('too_many_requests', 'rate_limited'))).toBe(
      'Translation service is busy, retry later',
    )
  })

  test('an upstream failure asks the user to retry later', () => {
    expect(translationErrorToast(envelope('unavailable', 'upstream_unavailable'))).toBe(
      'Translation service is unavailable, retry later',
    )
  })

  test('the code decides, not the reason', () => {
    // The backend is free to refine `rate_limited` into `rate_limited_caller`
    // or drop the reason entirely; the copy must survive either.
    expect(translationErrorToast(envelope('too_many_requests', 'rate_limited_caller'))).toBe(
      'Translation service is busy, retry later',
    )
    expect(translationErrorToast(envelope('too_many_requests'))).toBe(
      'Translation service is busy, retry later',
    )
  })

  test.each([
    ['internal', 'a server fault the user cannot act on'],
    ['bad_request', 'rejected input — retrying changes nothing'],
    ['timeout', "the store's own deadline, not the backend refusing"],
    ['not_found', 'not a documented translation failure'],
  ])('%s stays with the inline bar and raises no toast', (code) => {
    expect(translationErrorToast(envelope(code))).toBeNull()
  })

  test('an abort raises no toast', () => {
    const err = new Error('translate aborted')
    err.name = 'AbortError'
    expect(translationErrorToast(err)).toBeNull()
  })

  test.each([[null], [undefined], [{}], ['a string']])(
    'a non-envelope (%s) raises no toast',
    (err) => {
      expect(translationErrorToast(err)).toBeNull()
    },
  )
})
