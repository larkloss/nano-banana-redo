// Keeps big pictures on the browser's own disk storage for this page instead
// of in memory. A Blob made in the page lives in the browser's memory for as
// long as anything shows or holds it — every version of an edit chain, 10 to
// 30 MB each — while a Blob read back from IndexedDB is only a handle to a
// file. The bytes are stored and read back as they are; nothing is
// re-encoded, and nothing leaves the device.
//
// Each tab stores under an id of its own and holds a lock named after it for
// as long as it lives. Whatever a tab leaves behind is deleted by the next
// one to start: an id whose lock is free belongs to a tab that is gone.
//
// Everything here is optional: wherever the storage or the locks are missing,
// full or refuse (private windows, some browsers, a file opened from disk),
// the picture simply stays in memory, as it always did.

const DB_NAME = 'nano-banana-pictures'
const STORE = 'blobs'
const LOCK_PREFIX = 'nano-banana-pictures:'
// Below this a picture is not worth the round trip (previews, masks, guides)
const MIN_BYTES = 256 * 1024
// A store that has not answered by now is given up on: the picture stays in
// memory, and so do the ones after it
const PATIENCE_MS = 15000

const session =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2)

interface Row {
  session: string
  blob: Blob
}

// Where each stored picture sits, so it can be deleted when it is let go
const stored = new WeakMap<Blob, IDBValidKey>()
let opening: Promise<IDBDatabase | null> | null = null

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('storage transaction aborted'))
  })
}

// Resolves once this tab holds its lock, which it then keeps until it closes
function holdLock(): Promise<void> {
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(LOCK_PREFIX + session, () => {
        resolve()
        return new Promise<never>(() => {})
      })
      .catch(reject)
  })
}

async function deleteSession(db: IDBDatabase, id: string): Promise<void> {
  const tx = db.transaction(STORE, 'readwrite')
  const index = tx.objectStore(STORE).index('session')
  const keys = await request(index.getAllKeys(IDBKeyRange.only(id)))
  for (const key of keys) tx.objectStore(STORE).delete(key)
  await committed(tx)
}

// Deletes what tabs that are gone left behind
async function sweep(db: IDBDatabase): Promise<void> {
  const ids: string[] = []
  await new Promise<void>((resolve, reject) => {
    const cursor = db.transaction(STORE, 'readonly').objectStore(STORE).index('session').openKeyCursor(null, 'nextunique')
    cursor.onsuccess = () => {
      const at = cursor.result
      if (!at) return resolve()
      ids.push(String(at.key))
      at.continue()
    }
    cursor.onerror = () => reject(cursor.error)
  })
  for (const id of ids) {
    if (id === session) continue
    // A lock that can be taken right now has no tab behind it
    await navigator.locks.request(LOCK_PREFIX + id, { ifAvailable: true }, async (lock) => {
      if (lock) await deleteSession(db, id)
    })
  }
}

function open(): Promise<IDBDatabase | null> {
  opening ??= (async () => {
    try {
      if (typeof indexedDB === 'undefined' || typeof navigator === 'undefined' || !navigator.locks) return null
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { autoIncrement: true }).createIndex('session', 'session')
      }
      const db = await request(req)
      // (another tab upgrading or deleting the database: let it, and stop storing)
      db.onversionchange = () => {
        db.close()
        opening = Promise.resolve(null)
      }
      // The lock first: from here on no other tab takes this one for gone
      await holdLock()
      sweep(db).catch(() => undefined)
      // Leaving for good (not into the back/forward cache): delete now what
      // the next visit would otherwise have to
      addEventListener('pagehide', (event) => {
        if (!event.persisted) deleteSession(db, session).catch(() => undefined)
      })
      return db
    } catch {
      return null
    }
  })()
  return opening
}

// Deletes what earlier visits left behind (asked for once, when the app
// starts: otherwise it would wait for the first picture of this visit)
export function tidyPictureStore(): void {
  void open()
}

// The same picture, held on disk rather than in memory when that is possible:
// resolves to a Blob with the same bytes and type, or to the one given
export function keepOnDisk(blob: Blob): Promise<Blob> {
  if (blob.size < MIN_BYTES || stored.has(blob)) return Promise.resolve(blob)
  return new Promise((resolve) => {
    // (a failing store is handled inside; this is for one that says nothing)
    const giveUp = setTimeout(() => {
      opening = Promise.resolve(null)
      resolve(blob)
    }, PATIENCE_MS)
    void store(blob).then((kept) => {
      clearTimeout(giveUp)
      resolve(kept)
    })
  })
}

async function store(blob: Blob): Promise<Blob> {
  try {
    const db = await open()
    if (!db) return blob
    const write = db.transaction(STORE, 'readwrite')
    const [key] = await Promise.all([
      request(write.objectStore(STORE).add({ session, blob } satisfies Row)),
      committed(write),
    ])
    const row = (await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(key))) as Row | undefined
    const back = row?.blob
    if (!(back instanceof Blob) || back.size !== blob.size || back.type !== blob.type) {
      db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key)
      return blob
    }
    stored.set(back, key)
    return back
  } catch {
    return blob
  }
}

// Deletes the stored copy of pictures nothing shows or holds any more
export function releaseFromDisk(blobs: Iterable<Blob>): void {
  const keys: IDBValidKey[] = []
  for (const blob of blobs) {
    const key = stored.get(blob)
    if (key !== undefined) {
      keys.push(key)
      stored.delete(blob)
    }
  }
  if (keys.length === 0) return
  void open().then((db) => {
    if (!db) return
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
      for (const key of keys) store.delete(key)
    } catch {
      // left for the next start's sweep
    }
  })
}
