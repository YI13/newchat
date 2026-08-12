import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_AUTO_TRANSLATE,
  DEFAULT_TARGET_LANG,
  SUPPORTED_TARGET_LANGS,
  TRANSLATION_AUTO_TRANSLATE_KEY,
  TRANSLATION_TARGET_LANG_KEY,
  getAutoTranslate,
  getTargetLang,
  isSupportedTargetLang,
  setAutoTranslate,
  setTargetLang,
} from './translationSettings'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('supported languages', () => {
  test('is exactly the five BCP-47 tags the product supports', () => {
    expect(SUPPORTED_TARGET_LANGS).toEqual(['en', 'de', 'ja', 'zh-Hant-TW', 'zh-Hans-CN'])
  })

  test('rejects the retired zhTW/zhCN spellings', () => {
    expect(isSupportedTargetLang('zhTW')).toBe(false)
    expect(isSupportedTargetLang('zhCN')).toBe(false)
  })

  test.each(['en', 'de', 'ja', 'zh-Hant-TW', 'zh-Hans-CN'])('accepts %s', (lang) => {
    expect(isSupportedTargetLang(lang)).toBe(true)
  })

  test('does not accept a bare zh primary subtag', () => {
    // Guards the base()-collapse bug: comparing only the primary subtag makes
    // zh-Hans-CN and zh-Hant-TW indistinguishable, so Hans->Hant never runs.
    expect(isSupportedTargetLang('zh')).toBe(false)
  })
})

describe('getTargetLang', () => {
  test('defaults to en when nothing is stored', () => {
    expect(getTargetLang()).toBe(DEFAULT_TARGET_LANG)
    expect(DEFAULT_TARGET_LANG).toBe('en')
  })

  test('does not derive a default from navigator.language', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('ja-JP')
    expect(getTargetLang()).toBe('en')
  })

  test('returns the stored value when supported', () => {
    localStorage.setItem(TRANSLATION_TARGET_LANG_KEY, 'zh-Hant-TW')
    expect(getTargetLang()).toBe('zh-Hant-TW')
  })

  test('falls back to the default on an unsupported stored value', () => {
    localStorage.setItem(TRANSLATION_TARGET_LANG_KEY, 'klingon')
    expect(getTargetLang()).toBe('en')
  })

  test('falls back to the default when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(getTargetLang()).toBe('en')
  })
})

describe('setTargetLang', () => {
  test('persists a supported value', () => {
    setTargetLang('de')
    expect(localStorage.getItem(TRANSLATION_TARGET_LANG_KEY)).toBe('de')
    expect(getTargetLang()).toBe('de')
  })

  test('ignores an unsupported value and leaves the previous one intact', () => {
    setTargetLang('ja')
    setTargetLang('klingon')
    expect(getTargetLang()).toBe('ja')
  })

  test('swallows a localStorage write failure', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => setTargetLang('de')).not.toThrow()
  })
})

describe('getAutoTranslate', () => {
  test('defaults to false', () => {
    expect(getAutoTranslate()).toBe(DEFAULT_AUTO_TRANSLATE)
    expect(DEFAULT_AUTO_TRANSLATE).toBe(false)
  })

  test('reads a stored true', () => {
    localStorage.setItem(TRANSLATION_AUTO_TRANSLATE_KEY, 'true')
    expect(getAutoTranslate()).toBe(true)
  })

  test('treats any non-"true" string as false', () => {
    localStorage.setItem(TRANSLATION_AUTO_TRANSLATE_KEY, 'yes')
    expect(getAutoTranslate()).toBe(false)
  })

  test('falls back to false when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(getAutoTranslate()).toBe(false)
  })
})

describe('setAutoTranslate', () => {
  test('round-trips true and false', () => {
    setAutoTranslate(true)
    expect(getAutoTranslate()).toBe(true)
    setAutoTranslate(false)
    expect(getAutoTranslate()).toBe(false)
  })

  test('coerces a truthy non-boolean to a boolean string', () => {
    setAutoTranslate(1)
    expect(localStorage.getItem(TRANSLATION_AUTO_TRANSLATE_KEY)).toBe('true')
  })

  test('swallows a localStorage write failure', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => setAutoTranslate(true)).not.toThrow()
  })
})
