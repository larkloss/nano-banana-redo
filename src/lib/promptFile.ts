import type { PromptWorkspace, Settings } from '../types'
import { normalizeSettings } from './storage'

// Storage that outlives the browser: the app reads and writes a real file the
// user picks (File System Access API, available on file:// in Chrome/Edge).
// Put that file in a synced folder — iCloud Drive, Dropbox, OneDrive — and the
// same prompts and settings show up on another machine.
//
// API keys are deliberately absent: they live in their own storage entries and
// never enter this file, which may sit in a shared cloud folder.

export interface PromptFilePayload {
  version: 1
  updatedAt: number
  workspace: PromptWorkspace
  settings: Settings
}

// Minimal shape of the parts of FileSystemFileHandle this app uses, including
// the permission methods that aren't in the standard DOM types yet.
export interface SyncFileHandle {
  name: string
  getFile: () => Promise<File>
  createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>
  queryPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>
}

interface FilePickerOptions {
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
  multiple?: boolean
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options?: FilePickerOptions) => Promise<SyncFileHandle>
  showOpenFilePicker?: (options?: FilePickerOptions) => Promise<SyncFileHandle[]>
}

const FILE_TYPES = [{ description: 'Prompt library', accept: { 'application/json': ['.json'] } }]
const DEFAULT_NAME = 'nano-banana-prompts.json'

export function isFileSyncSupported(): boolean {
  const w = window as PickerWindow
  return typeof w.showSaveFilePicker === 'function' && typeof w.showOpenFilePicker === 'function'
}

export async function pickNewSyncFile(): Promise<SyncFileHandle | null> {
  const picker = (window as PickerWindow).showSaveFilePicker
  if (!picker) return null
  try {
    return await picker.call(window, { suggestedName: DEFAULT_NAME, types: FILE_TYPES })
  } catch (err) {
    if (isAbort(err)) return null
    throw err
  }
}

export async function pickExistingSyncFile(): Promise<SyncFileHandle | null> {
  const picker = (window as PickerWindow).showOpenFilePicker
  if (!picker) return null
  try {
    const [handle] = await picker.call(window, { types: FILE_TYPES, multiple: false })
    return handle ?? null
  } catch (err) {
    if (isAbort(err)) return null
    throw err
  }
}

// Chrome grants file access per session, so a stored handle usually needs one
// click to re-authorize. `request` must be called from a user gesture.
export async function checkPermission(handle: SyncFileHandle, request: boolean): Promise<PermissionState> {
  const opts = { mode: 'readwrite' } as const
  const current = (await handle.queryPermission?.(opts)) ?? 'granted'
  if (current === 'granted' || !request) return current
  return (await handle.requestPermission?.(opts)) ?? 'denied'
}

export async function readPayload(handle: SyncFileHandle): Promise<PromptFilePayload | null> {
  const file = await handle.getFile()
  const text = await file.text()
  if (!text.trim()) return null
  const parsed = JSON.parse(text) as PromptFilePayload
  if (!parsed || typeof parsed !== 'object' || !parsed.workspace || !Array.isArray(parsed.workspace.modules)) {
    throw new Error('That file is not a prompt library saved by this app')
  }
  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    workspace: parsed.workspace,
    settings: normalizeSettings(parsed.settings),
  }
}

export async function writePayload(handle: SyncFileHandle, payload: PromptFilePayload): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(JSON.stringify(payload, null, 2))
  await writable.close()
}

// ---------------------------------------------------------------------------
// Remembering the chosen file across reloads (handles are structured-cloneable)
// ---------------------------------------------------------------------------

const DB_NAME = 'nbr-sync'
const STORE = 'handles'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function rememberHandle(slot: string, handle: SyncFileHandle | null): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      if (handle) tx.objectStore(STORE).put(handle, slot)
      else tx.objectStore(STORE).delete(slot)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    // storage unavailable — the file just has to be re-picked next time
  }
}

export async function recallHandle(slot: string): Promise<SyncFileHandle | null> {
  try {
    const db = await openDb()
    return await new Promise<SyncFileHandle | null>((resolve) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(slot)
      request.onsuccess = () => resolve((request.result as SyncFileHandle) ?? null)
      request.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}
