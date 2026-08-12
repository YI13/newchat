// Transient app-wide notices.
//
// The message text is the identity: showing the same string while it is still
// on screen refreshes its timer rather than adding a second copy. A retry
// against a backend that is still down is one situation, and it should read as
// one notice. That also keeps the React key stable without an id generator.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import './style.css'

export const TOAST_DURATION_MS = 5000

const NOOP = () => {}

// Default rather than a throwing guard: chrome rendered outside the provider
// (tests, isolated harnesses) should stay silent, not crash. Same posture as
// useTranslationSettings' read-only defaults.
const ToastContext = createContext({ show: NOOP, dismiss: NOOP })

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }) {
  const [messages, setMessages] = useState([])
  const timers = useRef(new Map())

  const dismiss = useCallback((message) => {
    const timer = timers.current.get(message)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.current.delete(message)
    }
    setMessages((prev) => prev.filter((m) => m !== message))
  }, [])

  const show = useCallback(
    (message) => {
      if (!message) return
      const running = timers.current.get(message)
      if (running !== undefined) clearTimeout(running)
      timers.current.set(
        message,
        setTimeout(() => dismiss(message), TOAST_DURATION_MS),
      )
      setMessages((prev) => (prev.includes(message) ? prev : [...prev, message]))
    },
    [dismiss],
  )

  // Timers outlive React state, so unmounting mid-flight would leave them to
  // fire against a dead setter.
  const pending = timers.current
  useEffect(
    () => () => {
      pending.forEach(clearTimeout)
      pending.clear()
    },
    [pending],
  )

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {messages.length > 0 && (
        <div className="toast-host">
          {messages.map((message) => (
            <div key={message} className="toast" role="status">
              <span className="toast-message">{message}</span>
              <button
                type="button"
                className="toast-dismiss"
                aria-label="Dismiss notification"
                onClick={() => dismiss(message)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}

export default ToastProvider
