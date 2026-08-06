// Tiny IndexedDB store for reference images. localStorage is unsuitable here
// (5MB quota — one 4K reference can blow it); IndexedDB works on file:// in
// Chrome so the double-click-to-run constraint holds. Every call fails silently
// back to in-memory-only behavior (private mode, unsupported browsers).

export interface StoredReference {
  id: string
  name: string
  mimeType: string
  base64: string
}

const DB_NAME = 'nbr-refs'
const STORE = 'refs'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadStoredReferences(slot: string): Promise<StoredReference[]> {
  try {
    const db = await openDb()
    return await new Promise<StoredReference[]>((resolve) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(slot)
      request.onsuccess = () => {
        const value = request.result
        resolve(Array.isArray(value) ? value.filter(isStoredReference) : [])
      }
      request.onerror = () => resolve([])
    })
  } catch {
    return []
  }
}

export async function saveStoredReferences(slot: string, refs: StoredReference[]): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(refs, slot)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    // storage unavailable — references just won't survive a reload
  }
}

function isStoredReference(value: unknown): value is StoredReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredReference).base64 === 'string' &&
    typeof (value as StoredReference).mimeType === 'string'
  )
}
