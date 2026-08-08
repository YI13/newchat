import { useCallback, useEffect, useRef } from 'react'
import MessageRow from './MessageRow/MessageRow'
import SystemMessage from './SystemMessage/SystemMessage'
import { useAutoTranslateScrollRoot } from '@/context/TranslationContext'
import './style.css'

export default function MessageList({
  messages,
  room,
  hasLoadedHistory,
  historyLoading,
  historyError,
  emptyText,
  context,
  focusMessageId,
  currentUserAccount,
  onThread,
  onReply,
  onEdit,
  onDelete,
  onJumpToMessage,
  bottomRef,
  ariaLive,
  onRetry,
  onDismiss,
  onFocusConsumed,
  parentMessageId,
}) {
  const listRef = useRef(null)
  const localBottomRef = useRef(null)
  const effectiveBottomRef = bottomRef ?? localBottomRef

  // This element is what actually scrolls, so intersection has to be measured
  // against it rather than the document.
  const setScrollRoot = useAutoTranslateScrollRoot()
  const attachList = useCallback(
    (element) => {
      listRef.current = element
      setScrollRoot(element)
    },
    [setScrollRoot],
  )

  useEffect(() => {
    if (!focusMessageId || !listRef.current) return
    const el = listRef.current.querySelector(`[data-message-id="${focusMessageId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('flash-jump')
    const timer = setTimeout(() => el.classList.remove('flash-jump'), 2000)
    // Tell the owning context the focus has been consumed so it can clear
    // focusMessageId. Without this:
    //   - clicking the same quote twice no-ops (deps don't change)
    //   - leaving the room and coming back replays the flash-jump
    onFocusConsumed?.(focusMessageId)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMessageId])

  const empty = hasLoadedHistory && !historyLoading && !historyError && messages.length === 0

  // Filter out deleted messages entirely — they shouldn't take up any visual
  // space (no avatar, no row, no anything). MessageRow ALSO short-circuits
  // on `deleted` as a defense-in-depth; this filter is the primary gate.
  const visibleMessages = messages.filter((m) => !m.deleted)

  return (
    <div
      className="message-list"
      ref={attachList}
      {...(ariaLive ? { 'aria-live': ariaLive } : {})}
    >
      {historyLoading && <div className="message-loading">Loading messages…</div>}
      {historyError && <div className="message-error">{historyError}</div>}
      {visibleMessages.map((msg) => {
        // Messages with a `sysMsgData` payload are server-emitted system
        // events (room_created, members_added, …) — render them as a
        // centered strip instead of a normal sender/bubble row. The
        // discriminator is the payload, not just `type`, because a
        // future broadcast rename to e.g. `type: "text"` on user
        // messages would otherwise silently route every message through
        // SystemMessage.
        if (msg.sysMsgData != null) {
          return <SystemMessage key={msg.id} message={msg} />
        }
        const isParent = context === 'thread' && parentMessageId === msg.id
        const rowContext = isParent ? 'thread-parent' : context
        return (
          <MessageRow
            key={msg.id}
            message={msg}
            room={room}
            context={rowContext}
            isOwn={!!currentUserAccount && msg.sender?.account === currentUserAccount}
            onThread={onThread}
            onReply={onReply}
            onEdit={onEdit}
            onDelete={onDelete}
            onJumpToMessage={onJumpToMessage}
            onRetry={onRetry}
            onDismiss={onDismiss}
          />
        )
      })}
      {visibleMessages.length === 0 && messages.length > 0 && (
        // All buffered messages have been deleted — show the empty state.
        emptyText && <div className="message-empty">{emptyText}</div>
      )}
      {empty && emptyText && <div className="message-empty">{emptyText}</div>}
      <div ref={effectiveBottomRef} />
    </div>
  )
}
