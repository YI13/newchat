import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { setAutoTranslate, setTargetLang } from '@/lib/translationSettings'
import { ToastProvider } from '@/context/ToastContext'
import {
  TranslationProvider,
  useAutoTranslateRegistration,
  useTranslationActions,
} from './TranslationContext'

// Provider wiring test. The modules under it have their own suites; what only
// this level can catch is a seam the provider itself gets wrong — found live:
// a tab that loads in the background renders `active: false` into a ref, and
// bringing it to the foreground re-renders nothing, so the policy skipped
// every candidate as 'inactive' while the user was looking straight at the
// page.

vi.mock('@/context/NatsContext', () => ({
  useNats: () => ({ user: { account: 'alice', siteId: 'site-local' } }),
}))

let ios = []

class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback
    ios.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const io = () => ios[ios.length - 1]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let visibility = 'visible'

function makeCache() {
  return {
    intent: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
    content: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}), clear: vi.fn() },
    clearMessages: vi.fn(async () => {}),
    clearRoom: vi.fn(async () => {}),
    clearAll: vi.fn(async () => {}),
  }
}

function Row({ message }) {
  const register = useAutoTranslateRegistration(message, 'r1')
  return <div ref={register} data-message-id={message.id} />
}

function ManualTranslateButton({ message }) {
  const { translate } = useTranslationActions()
  return (
    <button type="button" onClick={() => translate(message, 'r1')}>
      Translate
    </button>
  )
}

/** Stand-in for the errcode envelope the transport throws. */
function envelope(code, reason) {
  const err = new Error(`stub: ${code}`)
  err.code = code
  if (reason) err.reason = reason
  return err
}

function show(id) {
  const el = document.querySelector(`[data-message-id="${id}"]`)
  io().callback(
    [
      {
        target: el,
        isIntersecting: true,
        intersectionRatio: 1,
        boundingClientRect: { top: 100, height: 20, bottom: 120 },
      },
    ],
    io(),
  )
}

beforeEach(() => {
  ios = []
  visibility = 'visible'
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => visibility !== 'visible',
  })
  setAutoTranslate(true)
  setTargetLang('ja')
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete document.visibilityState
  delete document.hidden
  localStorage.clear()
})

describe('foregrounding a tab that loaded in the background', () => {
  test('translates what is on screen without waiting for a re-render', async () => {
    // Every render happens while hidden — exactly what a tab opened via
    // "open in new tab" does.
    visibility = 'hidden'

    const translate = vi.fn(async (_n, { text, targetLang }) => ({
      translatedText: `[${targetLang}] ${text}`,
      targetLang,
    }))
    const message = { id: 'm1', content: '早安', sender: { account: 'bob' }, editedAt: 0 }

    render(
      <TranslationProvider translate={translate} cache={makeCache()}>
        <Row message={message} />
      </TranslationProvider>,
    )

    // The user brings the tab to the front. Nothing about this re-renders
    // React — the page just becomes visible and the observer starts firing.
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    show('m1')

    // Provider wires the real dwell (400ms); wait it out plus slack.
    await sleep(600)

    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0][1]).toMatchObject({ text: '早安', targetLang: 'ja' })
  })

  test('still refuses to translate while genuinely hidden', async () => {
    visibility = 'hidden'

    const translate = vi.fn(async () => ({ translatedText: 'x', targetLang: 'ja' }))
    const message = { id: 'm1', content: '早安', sender: { account: 'bob' }, editedAt: 0 }

    render(
      <TranslationProvider translate={translate} cache={makeCache()}>
        <Row message={message} />
      </TranslationProvider>,
    )

    // A hidden tab can still receive observer entries (initial computation).
    // Live-reading visibility must block these, not just the stale-ref case.
    show('m1')
    await sleep(600)

    expect(translate).not.toHaveBeenCalled()
  })
})

// A failed translation is a UI state, not a rejected promise — the store
// settles an outcome descriptor and never throws. So the toast can only come
// from the one seam that knows the user asked for this: the manual action.
describe('failure notices', () => {
  const message = { id: 'm1', content: '早安', sender: { account: 'bob' }, editedAt: 0 }

  function renderManual(translate) {
    return render(
      <ToastProvider>
        <TranslationProvider translate={translate} cache={makeCache()}>
          <ManualTranslateButton message={message} />
        </TranslationProvider>
      </ToastProvider>,
    )
  }

  // The toast is plain useState, so the settle that raises it lands outside
  // React's batching unless the whole round trip is wrapped.
  async function clickTranslate() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Translate' }))
      await sleep(50)
    })
  }

  test.each([
    ['too_many_requests', 'rate_limited', 'Translation service is busy, retry later'],
    ['unavailable', 'upstream_unavailable', 'Translation service is unavailable, retry later'],
  ])('a manual %s tells the user to retry later', async (code, reason, copy) => {
    renderManual(
      vi.fn(async () => {
        throw envelope(code, reason)
      }),
    )
    await clickTranslate()
    expect(screen.getByRole('status')).toHaveTextContent(copy)
  })

  test('a manual server fault stays with the inline bar', async () => {
    renderManual(
      vi.fn(async () => {
        throw envelope('internal')
      }),
    )
    await clickTranslate()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('a manual success says nothing', async () => {
    renderManual(vi.fn(async () => ({ translatedText: 'Good morning', targetLang: 'ja' })))
    await clickTranslate()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('an automatic failure stays silent', async () => {
    // The same outage that toasts on the manual path must produce nothing on
    // the automatic one: the user did not ask for this translation, and one
    // down backend would otherwise toast once per message on screen.
    const translate = vi.fn(async () => {
      throw envelope('unavailable', 'upstream_unavailable')
    })

    render(
      <ToastProvider>
        <TranslationProvider translate={translate} cache={makeCache()}>
          <Row message={message} />
        </TranslationProvider>
      </ToastProvider>,
    )
    show('m1')
    await sleep(600)

    expect(translate).toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
