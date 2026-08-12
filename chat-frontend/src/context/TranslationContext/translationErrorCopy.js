// Toast copy for the two translation failures the user can act on.
//
// Keyed on the errcode `code`, not the `reason`, for two reasons. The reasons
// these failures carry (`rate_limited`, `upstream_unavailable`) are not unique
// to translation — `upstream_unavailable` is already in the shared catalog for
// auth-service and portal-service, where "Translation service is unavailable"
// would be plainly wrong. And the backend is free to refine a reason
// (`rate_limited` → `rate_limited_caller`) without the copy silently going
// missing. The code is the stable half of the envelope.
//
// Deliberately NOT added to REASON_COPY in api/_transport/asyncJob.ts: that
// map is global and reason-keyed, so an entry there would rewrite unrelated
// services' errors.

const COPY = {
  too_many_requests: 'Translation service is busy, retry later',
  unavailable: 'Translation service is unavailable, retry later',
}

/**
 * User-facing notice for a failed translation, or null when the failure does
 * not warrant one.
 *
 * Null covers more than it might look like. `internal` and `bad_request` give
 * the user nothing to act on, and `timeout` is the store's own deadline
 * expiring rather than the backend saying it is unavailable — conflating them
 * would tell the user the service is down when their connection stalled. All
 * of those still show the inline "Translation failed" bar on the message; the
 * toast is only for the two the user can respond to by waiting.
 */
export function translationErrorToast(err) {
  const code = (err && typeof err === 'object' && err.code) || null
  if (!code) return null
  return COPY[code] ?? null
}
