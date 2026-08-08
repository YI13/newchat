// Client-side translation preferences, persisted in localStorage.
//
// These are deliberately NOT the backend's `settings.translateMessageInto`:
// no other client reads or writes that field, so keeping the preference local
// avoids a round-trip and a write-back path nobody consumes.
//
// Every read is total — a throwing localStorage (Safari private mode, storage
// disabled) or a value written by an older build must degrade to the default
// rather than break rendering.

export const TRANSLATION_TARGET_LANG_KEY = 'TRANSLATION_TARGET_LANG'
export const TRANSLATION_AUTO_TRANSLATE_KEY = 'TRANSLATION_AUTO_TRANSLATE'

// Exact BCP-47 tags. The script subtag is significant: zh-Hant-TW and
// zh-Hans-CN are different targets, so matching on the primary subtag alone
// would make Hans->Hant translation a permanent no-op.
export const SUPPORTED_TARGET_LANGS = ['en', 'de', 'ja', 'zh-Hant-TW', 'zh-Hans-CN']

export const DEFAULT_TARGET_LANG = 'en'
export const DEFAULT_AUTO_TRANSLATE = false

export function isSupportedTargetLang(lang) {
  return SUPPORTED_TARGET_LANGS.includes(lang)
}

function readRaw(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable or over quota — the setting stays in-memory for this
    // session. Nothing actionable for the user, so stay silent.
  }
}

export function getTargetLang() {
  const stored = readRaw(TRANSLATION_TARGET_LANG_KEY)
  return isSupportedTargetLang(stored) ? stored : DEFAULT_TARGET_LANG
}

export function setTargetLang(lang) {
  if (!isSupportedTargetLang(lang)) return
  writeRaw(TRANSLATION_TARGET_LANG_KEY, lang)
}

export function getAutoTranslate() {
  return readRaw(TRANSLATION_AUTO_TRANSLATE_KEY) === 'true'
}

export function setAutoTranslate(enabled) {
  writeRaw(TRANSLATION_AUTO_TRANSLATE_KEY, String(!!enabled))
}
