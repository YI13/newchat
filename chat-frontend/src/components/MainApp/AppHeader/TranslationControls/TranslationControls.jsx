import { SUPPORTED_TARGET_LANGS } from '@/lib/translationSettings'
import { useTranslationSettings } from '@/context/TranslationContext'
import './style.css'

const LANG_LABELS = {
  en: 'English',
  de: 'Deutsch',
  ja: '日本語',
  'zh-Hant-TW': '繁體中文',
  'zh-Hans-CN': '简体中文',
}

/**
 * Target language and the automatic-translation switch.
 *
 * Sits with the debug controls rather than in a settings dialog: these are
 * the two knobs you need in reach while watching how the visibility policy
 * and the queue behave.
 */
export default function TranslationControls() {
  const { targetLang, autoTranslate, setTargetLang, setAutoTranslate } =
    useTranslationSettings()

  return (
    <div className="translation-controls">
      {/* No visible "Translate to" caption. The header's search bar is
          absolutely positioned, centred and above the flow, so a wider
          right-hand group slides underneath it instead of wrapping — the
          caption was being hidden by exactly that. The select already names
          the language, so the label is redundant anyway. */}
      <select
        className="translation-controls-select"
        aria-label="Translate messages into"
        title="Translate messages into"
        value={targetLang}
        onChange={(e) => setTargetLang(e.target.value)}
      >
        {SUPPORTED_TARGET_LANGS.map((lang) => (
          <option key={lang} value={lang}>
            {LANG_LABELS[lang] ?? lang}
          </option>
        ))}
      </select>

      <label className="translation-controls-label" title="Translate messages you dwell on">
        <input
          type="checkbox"
          checked={autoTranslate}
          onChange={(e) => setAutoTranslate(e.target.checked)}
          aria-label="Automatic translation"
        />
        Auto
      </label>
    </div>
  )
}
