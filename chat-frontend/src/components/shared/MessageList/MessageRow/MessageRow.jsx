import MessageActions from './MessageActions/MessageActions'
import QuotedBlock from '@/components/shared/QuotedBlock/QuotedBlock'
import useHoverWithDelay from '@/hooks/useHoverWithDelay'
import { useSubscription } from '@/context/RoomEventsContext'
import {
  useAutoTranslateRegistration,
  useTranslationActions,
  useTranslationEntry,
} from '@/context/TranslationContext'
import { redactInaccessibleQuoteSnapshot } from '@/lib/redactQuote'
import './style.css'

function formatTime(dateStr) {
  const d = new Date(dateStr)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function senderName(msg) {
  if (msg.sender) {
    return msg.sender.engName || msg.sender.account || msg.sender.userId || 'Unknown'
  }
  return msg.userAccount || msg.userId || 'Unknown'
}

function senderInitial(msg) {
  const name = senderName(msg)
  return (name.charAt(0) || '?').toUpperCase()
}

function messageContent(msg) {
  return msg.content || msg.msg || ''
}

export default function MessageRow({
  message,
  room,
  context,
  isOwn,
  onThread,
  onReply,
  onEdit,
  onDelete,
  onJumpToMessage,
  onRetry,
  onDismiss,
}) {
  // Hover state driven from JS, NOT CSS :hover — see useHoverWithDelay for
  // why. Attach the same `handlers` to both the bubble-wrap (trigger) and
  // the floating menu (so the menu stays open while the cursor travels
  // between them).
  const { hovered, handlers } = useHoverWithDelay(200)

  // Translation is only offered on other people's messages — you do not need
  // your own words translated, and the automatic policy skips them too.
  const translation = useTranslationEntry(message.id)
  const { available: canTranslate, translate, revert } = useTranslationActions()
  const registerForAutoTranslate = useAutoTranslateRegistration(message, room?.id)

  // Mirror history-service's quote redaction client-side: the live broadcast
  // path doesn't gate quote snapshots against the reader's access window, so
  // a quote of a message older than historySharedSince would otherwise leak.
  const subscription = useSubscription(room?.id)
  const quoteSnapshot = redactInaccessibleQuoteSnapshot(
    message.quotedParentMessage,
    subscription?.historySharedSince,
  )

  // Deleted messages are removed from the feed entirely. (Also filtered at
  // MessageList — this is defense-in-depth.)
  if (message.deleted) return null

  const rowClasses = ['message-row']
  if (isOwn) rowClasses.push('message-row-own')

  // An identical translation shows the source: the backend returned the same
  // string, so there is nothing to swap in and no "translated" affordance to
  // offer.
  const isShowingTranslation =
    translation.status === 'translated' && !translation.identical
  const displayedText = isShowingTranslation
    ? translation.translatedText
    : messageContent(message)
  const showTranslationBar = canTranslate && !isOwn && !!messageContent(message)

  return (
    <div
      className={rowClasses.join(' ')}
      data-message-id={message.id}
      ref={registerForAutoTranslate}
      tabIndex={0}
    >
      {!isOwn && (
        <div className="message-row-avatar" aria-hidden="true">
          {senderInitial(message)}
        </div>
      )}
      <div className="message-row-body">
        <div className="message-header">
          <span className="message-sender">{senderName(message)}</span>
          <span className="message-time">{formatTime(message.createdAt)}</span>
          {message.editedAt && <span className="message-edited"> (edited)</span>}
        </div>
        {/* QuotedBlock sits OUTSIDE message-bubble-wrap so hovering the
            quote doesn't trigger the action toolbar. CSS pulls it flush
            against the bubble's top so it still looks attached. */}
        {quoteSnapshot && (
          <QuotedBlock
            variant="bubble"
            snapshot={quoteSnapshot}
            onClick={onJumpToMessage}
          />
        )}
        <div className="message-bubble-wrap" {...handlers}>
          <div className="message-bubble">{displayedText}</div>
          {showTranslationBar && (
            <div className="message-translation-bar">
              {/* Queued and in-flight are shown apart on purpose: a full
                  concurrency gate and a slow backend look identical
                  otherwise, and only one of them is a problem. */}
              {translation.status === 'queued' && (
                <span className="message-translation-status">Queued…</span>
              )}
              {translation.status === 'loading' && (
                <span className="message-translation-status">Translating…</span>
              )}
              {translation.status === 'failed' && (
                <span className="message-translation-status message-translation-error">
                  Translation failed
                </span>
              )}
              {isShowingTranslation ? (
                <button
                  type="button"
                  className="message-translation-toggle"
                  onClick={() => revert(message, room?.id)}
                >
                  See original
                </button>
              ) : (
                <button
                  type="button"
                  className="message-translation-toggle"
                  disabled={translation.status === 'queued' || translation.status === 'loading'}
                  onClick={() => translate(message, room?.id)}
                >
                  Translate
                </button>
              )}
            </div>
          )}
          {hovered && (
            <div className="message-actions-host" {...handlers}>
              <MessageActions
                message={message}
                room={room}
                context={context}
                isOwn={isOwn}
                onThread={onThread}
                onReply={onReply}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            </div>
          )}
        </div>
        {message.tcount > 0 && context !== 'thread' && context !== 'thread-parent' && (
          <button
            type="button"
            className="message-reply-badge"
            onClick={() => onThread?.(message)}
          >
            💬 {message.tcount} {message.tcount === 1 ? 'reply' : 'replies'}
          </button>
        )}
        {message._status === 'failed' && (
          <div className="message-row-failed">
            <span className="message-row-failed-label">Failed to send.</span>
            <button type="button" aria-label="Retry sending message" onClick={() => onRetry?.(message.id)}>⟳</button>
            <button type="button" aria-label="Dismiss failed message" onClick={() => onDismiss?.(message.id)}>✕</button>
          </div>
        )}
      </div>
    </div>
  )
}
