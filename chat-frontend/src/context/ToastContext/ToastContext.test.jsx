import { describe, expect, test, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ToastProvider, useToast, TOAST_DURATION_MS } from './ToastContext'

function Trigger({ message, label = 'show' }) {
  const { show } = useToast()
  return (
    <button type="button" onClick={() => show(message)}>
      {label}
    </button>
  )
}

function click(label = 'show') {
  act(() => {
    screen.getByRole('button', { name: label }).click()
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ToastProvider', () => {
  test('renders nothing until something is shown', () => {
    render(
      <ToastProvider>
        <Trigger message="boom" />
      </ToastProvider>,
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('shows the message that was passed', () => {
    render(
      <ToastProvider>
        <Trigger message="Translation service is busy, retry later" />
      </ToastProvider>,
    )
    click()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Translation service is busy, retry later',
    )
  })

  test('dismisses itself after the display window', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(
      <ToastProvider>
        <Trigger message="boom" />
      </ToastProvider>,
    )
    click()
    expect(screen.getByRole('status')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS)
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('can be dismissed by hand before it expires', () => {
    render(
      <ToastProvider>
        <Trigger message="boom" />
      </ToastProvider>,
    )
    click()
    act(() => {
      screen.getByRole('button', { name: /dismiss/i }).click()
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('repeating a live message refreshes it instead of stacking', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(
      <ToastProvider>
        <Trigger message="boom" />
      </ToastProvider>,
    )
    // Two failures in a row — a retry on a backend that is still down — must
    // read as one notice, not a growing pile of identical ones.
    click()
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS - 100)
    })
    click()

    expect(screen.getAllByRole('status')).toHaveLength(1)
    // The second show restarted the clock: the first one's deadline passes
    // and the toast is still there.
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  test('stacks distinct messages', () => {
    render(
      <ToastProvider>
        <Trigger message="first" label="show" />
        <Trigger message="second" label="other" />
      </ToastProvider>,
    )
    click('show')
    click('other')
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })

  test('an empty message shows nothing', () => {
    render(
      <ToastProvider>
        <Trigger message="" />
      </ToastProvider>,
    )
    click()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('degrades to a no-op outside a provider', () => {
    // Chrome rendered in isolation (tests, storybook-style harnesses) must not
    // crash just because nothing is there to display the notice.
    render(<Trigger message="boom" />)
    expect(() => click()).not.toThrow()
  })
})
