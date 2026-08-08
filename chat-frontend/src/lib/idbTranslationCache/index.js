// IndexedDB-backed translation cache: two tables with deliberately different
// lifetimes.
//
//   translationIntent  — the authoritative display decision for a message.
//                        Never pruned. It records the user's *exception* to
//                        the global auto-translate switch, so evicting it
//                        would silently un-translate a message the user asked
//                        to see translated.
//   translationContent — a rebuildable byte-LRU cache of translated text.
//                        Evicting it only costs a re-translation.
//
// There is no 'auto' intent mode. Automatic translation is derived from
// "no intent row + global switch on", which is what makes "turn the switch
// off -> instantly back to source" fall out of the display rule instead of
// needing a separate restore pass.

import Dexie from 'dexie'

export const CACHE_BYTE_CAP = 50 * 1024 * 1024
export const DEFAULT_PRUNE_BATCH = 10000
export const DEFAULT_DB_NAME = 'chat-translation-cache'

export const INTENT_MODES = ['manual', 'off']

const encoder = new TextEncoder()

function utf8Bytes(text) {
  return text ? encoder.encode(text).length : 0
}

export function createTranslationCache({
  dbName = DEFAULT_DB_NAME,
  byteCap = CACHE_BYTE_CAP,
  pruneBatch = DEFAULT_PRUNE_BATCH,
  now = () => Date.now(),
} = {}) {
  const db = new Dexie(dbName)
  db.version(1).stores({
    translationIntent: 'messageId, roomId',
    translationContent: 'messageId, roomId, bytes, lastAccessAt',
  })

  // null is the "not yet known" sentinel, distinct from a genuine 0. Storing
  // 0 for "unknown" is what lets the cap silently stop applying after a
  // reload: the total looks satisfied and nothing ever recomputes it.
  // Never persisted — a stale persisted total survives a clear, which is
  // worse than recomputing from the bytes index on first use.
  let runningTotal = null

  async function recomputeTotal() {
    // Walks the `bytes` index only; never materialises translatedText.
    let sum = 0
    await db.translationContent.orderBy('bytes').eachKey((bytes) => {
      sum += bytes
    })
    return sum
  }

  async function getRunningTotal() {
    if (runningTotal === null) runningTotal = await recomputeTotal()
    return runningTotal
  }

  // Resolve a cold total BEFORE the caller touches the store. Recomputing
  // afterwards would read a database that already reflects the write, and the
  // delta would then be applied a second time — every byte counted twice.
  async function warmTotal() {
    if (runningTotal === null) runningTotal = await recomputeTotal()
  }

  // Callers must have warmed the total first; this is pure arithmetic on a
  // known value.
  function addToTotal(delta) {
    runningTotal = Math.max(0, runningTotal + delta)
  }

  async function prune() {
    const total = runningTotal
    if (total <= byteCap) return

    const victims = await db.translationContent
      .orderBy('lastAccessAt')
      .limit(pruneBatch)
      .toArray()

    const doomed = []
    let reclaimed = 0
    for (const row of victims) {
      if (total - reclaimed <= byteCap) break
      doomed.push(row.messageId)
      reclaimed += row.bytes
    }
    if (doomed.length === 0) return

    await db.translationContent.bulkDelete(doomed)
    addToTotal(-reclaimed)
  }

  const intent = {
    async get(messageId) {
      const row = await db.translationIntent.get(messageId)
      return row?.mode
    },

    async set(messageId, roomId, mode) {
      if (!INTENT_MODES.includes(mode)) {
        throw new Error(`invalid translation intent mode: ${mode}`)
      }
      await db.translationIntent.put({ messageId, roomId, mode, updatedAt: now() })
    },

    async clear(messageId) {
      await db.translationIntent.delete(messageId)
    },
  }

  const content = {
    // peek reads without advancing lastAccessAt, so callers that inspect
    // rather than display don't distort the LRU order.
    async peek(messageId) {
      return db.translationContent.get(messageId)
    },

    // get applies both hit guards. A row translated into another language, or
    // built from a superseded source revision, is a miss — returning it would
    // show wrong text rather than merely cost a request.
    async get(messageId, { targetLang, srcVersion }) {
      const row = await db.translationContent.get(messageId)
      if (!row) return undefined
      if (row.targetLang !== targetLang) return undefined
      if (row.srcVersion !== srcVersion) return undefined

      const lastAccessAt = now()
      await db.translationContent.update(messageId, { lastAccessAt })
      return { ...row, lastAccessAt }
    },

    // Drops the cached text for one message WITHOUT touching its intent.
    // This is the edit path: a new revision invalidates the translation, but
    // not the user's decision to see this message translated.
    async clear(messageId) {
      const row = await db.translationContent.get(messageId)
      if (!row) return
      await warmTotal()
      await db.translationContent.delete(messageId)
      addToTotal(-row.bytes)
    },

    async set({ messageId, roomId, targetLang, srcVersion, translatedText, originalText }) {
      // A translation identical to its source is stored as a zero-byte hit
      // rather than skipped. Skipping would make same-language messages a
      // permanent cache miss, re-requested on every render.
      const identical = translatedText === originalText
      const storedText = identical ? '' : translatedText
      const bytes = identical ? 0 : utf8Bytes(storedText)

      const previous = await db.translationContent.get(messageId)
      await warmTotal()
      const timestamp = now()

      await db.translationContent.put({
        messageId,
        roomId,
        targetLang,
        srcVersion,
        translatedText: storedText,
        bytes,
        identical,
        lastAccessAt: timestamp,
        updatedAt: timestamp,
      })

      // An overwrite must give back the old row's bytes first, or the total
      // drifts upward forever and the cap engages far too early.
      addToTotal(bytes - (previous?.bytes ?? 0))
      await prune()
    },
  }

  async function clearMessages(messageIds) {
    const ids = Array.from(messageIds ?? [])
    if (ids.length === 0) return

    const rows = await db.translationContent.bulkGet(ids)
    const freed = rows.reduce((sum, row) => sum + (row?.bytes ?? 0), 0)
    await warmTotal()

    await db.translationContent.bulkDelete(ids)
    await db.translationIntent.bulkDelete(ids)
    addToTotal(-freed)
  }

  // Clears BOTH tables for the room. Leaving intent behind would strand
  // display decisions for messages whose text is gone.
  async function clearRoom(roomId) {
    const rows = await db.translationContent.where('roomId').equals(roomId).toArray()
    const freed = rows.reduce((sum, row) => sum + row.bytes, 0)
    await warmTotal()

    await db.translationContent.where('roomId').equals(roomId).delete()
    await db.translationIntent.where('roomId').equals(roomId).delete()
    addToTotal(-freed)
  }

  // Logout. intent is authoritative display state, so leaving it behind would
  // show one account's translations to the next account on this device.
  async function clearAll() {
    await db.translationContent.clear()
    await db.translationIntent.clear()
    runningTotal = 0
  }

  async function destroy() {
    await db.delete()
  }

  return {
    dbName,
    db,
    intent,
    content,
    clearMessages,
    clearRoom,
    clearAll,
    getRunningTotal,
    destroy,
  }
}

export const translationCache = createTranslationCache()
