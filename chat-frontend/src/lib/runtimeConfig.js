// Runtime config: window.__APP_CONFIG__ in prod (rendered by nginx envsubst),
// import.meta.env.VITE_* in `vite dev`, literal defaults as last resort.

const runtime = (typeof window !== 'undefined' && window.__APP_CONFIG__) || {}

function boolConfig(value, fallback) {
  return String(value ?? fallback).toLowerCase() === 'true'
}

export const PORTAL_URL =
  runtime.PORTAL_URL || import.meta.env.VITE_PORTAL_URL || 'http://localhost:8085'

export const DEV_MODE = boolConfig(runtime.DEV_MODE ?? import.meta.env.VITE_DEV_MODE, true)

export const OIDC_ISSUER_URL =
  runtime.OIDC_ISSUER_URL ||
  import.meta.env.VITE_OIDC_ISSUER_URL ||
  'http://localhost:8180/realms/chatapp'

export const OIDC_CLIENT_ID =
  runtime.OIDC_CLIENT_ID || import.meta.env.VITE_OIDC_CLIENT_ID || 'nats-chat'

export const OTEL_ENABLED = boolConfig(
  runtime.OTEL_ENABLED ?? import.meta.env.VITE_OTEL_ENABLED,
  true,
)

export const OTEL_EXPORTER_OTLP_TRACES_URL =
  runtime.OTEL_EXPORTER_OTLP_TRACES_URL ||
  import.meta.env.VITE_OTEL_EXPORTER_OTLP_TRACES_URL ||
  'http://localhost:4318/v1/traces'

export const OTEL_SERVICE_NAME =
  runtime.OTEL_SERVICE_NAME || import.meta.env.VITE_OTEL_SERVICE_NAME || 'chat-frontend'

export const OTEL_SERVICE_VERSION =
  runtime.OTEL_SERVICE_VERSION || import.meta.env.VITE_OTEL_SERVICE_VERSION || '0.0.1'

export const OTEL_DEPLOYMENT_ENVIRONMENT =
  runtime.OTEL_DEPLOYMENT_ENVIRONMENT ||
  import.meta.env.VITE_OTEL_DEPLOYMENT_ENVIRONMENT ||
  'local'

// Translation transport. No translation service is deployed against this
// stack, so the dev stub is the default. It answers on the same signature as
// the real operation, which keeps the retry ladder, the queue and the abort
// plumbing on their production code paths.
// Set VITE_TRANSLATE_USE_STUB=false once a real backend is reachable.
export const TRANSLATE_USE_STUB = boolConfig(
  runtime.TRANSLATE_USE_STUB ?? import.meta.env.VITE_TRANSLATE_USE_STUB,
  true,
)

// One of the six stub modes: normal | slow | no-reply | unavailable |
// internal | identical. `slow` and `unavailable` are the useful ones — they
// hold queue slots open and drive the retry ladder on demand.
export const TRANSLATE_STUB_MODE =
  runtime.TRANSLATE_STUB_MODE || import.meta.env.VITE_TRANSLATE_STUB_MODE || 'normal'

export const TRANSLATE_STUB_DELAY_MS = Number(
  runtime.TRANSLATE_STUB_DELAY_MS ?? import.meta.env.VITE_TRANSLATE_STUB_DELAY_MS ?? 250,
)

// Mirrors portal-service's BOT_LOGIN_ENABLED flag (surfaced via /api/settings
// as botLoginEnabled). Default true: a missing flag (old portal, or a deploy
// that hasn't wired the var yet) must not silently lock out bots that were
// working.
export const BOT_LOGIN_ENABLED = boolConfig(
  runtime.BOT_LOGIN_ENABLED ?? import.meta.env.VITE_BOT_LOGIN_ENABLED,
  true,
)
