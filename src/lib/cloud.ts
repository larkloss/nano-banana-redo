import { useSyncExternalStore } from 'react'
import { loadStoredReferences, onStoredReferencesChange, saveStoredReferences, type StoredReference } from './refStore'
import { base64ToBlob } from './imageUtils'

// ---------------------------------------------------------------------------
// Cloud sync for the password-protected deployment (worker/index.ts).
//
// The apps already keep everything worth keeping in localStorage ("nbr.*")
// and reference photos in IndexedDB. This layer mirrors exactly that:
//   1. before the app renders, it pulls the cloud copy into local storage,
//      so the app starts with the synced values without knowing about sync;
//   2. afterwards, every local write is noticed and pushed (debounced).
// Each value carries a version; a push only applies if this tab saw the
// latest version of that value, so another device's newer edit is never
// silently overwritten — it surfaces as a conflict instead.
//
// API keys are excluded by name here and refused again by the server.
// Opened from a file:// double-click, none of this runs.
// ---------------------------------------------------------------------------

export type CloudState =
  | 'off' // not a cloud deployment
  | 'synced'
  | 'saving'
  | 'offline' // a push failed; retrying
  | 'conflict' // another device changed the same thing
  | 'stale' // another device changed something this tab hasn't loaded
  | 'signed-out'

export interface CloudStatus {
  state: CloudState
  lastSyncedAt: number | null
  conflictKeys: string[]
  // The cloud had no prompts yet on load — the UI offers importing a file
  cloudWasEmpty: boolean
  error: string | null
}

// Reference-photo slots that exist in the apps (IndexedDB keys)
const REF_SLOTS = ['generator']
// Per-device bookkeeping that must not follow the user around
const DEVICE_ONLY_KEYS = new Set(['nbr.promptSync.updatedAt'])
const PUSH_DELAY_MS = 1200

export function isSyncedKey(name: string): boolean {
  return name.startsWith('nbr.') && !/api.?key/i.test(name) && !DEVICE_ONLY_KEYS.has(name)
}

interface StoredValue {
  value: string | null
  version: number
}

// --- status store (read by React through useCloudStatus) -------------------

let status: CloudStatus = { state: 'off', lastSyncedAt: null, conflictKeys: [], cloudWasEmpty: false, error: null }
const listeners = new Set<() => void>()

function setStatus(patch: Partial<CloudStatus>): void {
  status = { ...status, ...patch }
  listeners.forEach((l) => l())
}

export function useCloudStatus(): CloudStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => status,
  )
}

// --- sync bookkeeping -------------------------------------------------------

// Version of each value as this tab last saw it in the cloud (0 = never existed)
const baseVersions = new Map<string, number>()
// The value at that version, to tell real edits from rewrites of the same data
const syncedValues = new Map<string, string | null>()
const dirty = new Set<string>()
const pendingRefs = new Map<string, StoredReference[]>()
const blobsInCloud = new Set<string>()
// Slots whose photos didn't all download at start-up. Pushing their (shorter)
// list would delete the missing photos from the cloud, so they're frozen.
const frozenRefSlots = new Set<string>()
let pushTimer: number | undefined
let pushing = false
let retryDelay = 5000

const rawSetItem = Storage.prototype.setItem
const rawRemoveItem = Storage.prototype.removeItem

// ---------------------------------------------------------------------------
// Boot: call before rendering. Resolves immediately when not deployed.
// ---------------------------------------------------------------------------

export async function bootCloud(): Promise<void> {
  if (!/^https?:$/.test(location.protocol)) return
  let keys: Record<string, StoredValue>
  try {
    const res = await fetch('/api/snapshot', { cache: 'no-store' })
    if (res.status === 401) return goToLogin()
    // Anything else that isn't our API (e.g. the Vite dev server) = not deployed
    if (!res.ok || res.headers.get('X-NBR-Cloud') !== '1') return
    keys = ((await res.json()) as { keys: Record<string, StoredValue> }).keys
  } catch {
    return
  }

  await applySnapshot(keys)
  // Anything stored locally that the cloud has never seen gets pushed
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i)
    if (name && isSyncedKey(name) && !(name in keys)) dirty.add(name)
  }
  for (const slot of REF_SLOTS) {
    if (!(`refs:${slot}` in keys) && (await loadStoredReferences(slot)).length > 0) dirty.add(`refs:${slot}`)
  }

  installHooks()
  setStatus({
    state: 'synced',
    lastSyncedAt: Date.now(),
    cloudWasEmpty: !keys['nbr.promptModules.v1']?.value,
  })
  if (dirty.size > 0) schedulePush()
}

// Writes the cloud's values into local storage without them counting as edits
async function applySnapshot(keys: Record<string, StoredValue>): Promise<void> {
  for (const [name, stored] of Object.entries(keys)) {
    if (name.startsWith('refs:')) {
      await applyRefs(name.slice(5), stored)
    } else if (isSyncedKey(name)) {
      if (stored.value === null) rawRemoveItem.call(localStorage, name)
      else rawSetItem.call(localStorage, name, stored.value)
    } else {
      continue
    }
    baseVersions.set(name, stored.version)
    syncedValues.set(name, stored.value)
  }
}

async function applyRefs(slot: string, stored: StoredValue): Promise<void> {
  const list = parseRefList(stored.value)
  const local = new Map((await loadStoredReferences(slot)).map((r) => [r.id, r]))
  const refs: StoredReference[] = []
  for (const item of list) {
    blobsInCloud.add(item.id)
    const have = local.get(item.id)
    if (have) {
      refs.push({ ...have, name: item.name })
      continue
    }
    const bytes = await downloadBlob(item.id)
    if (!bytes) {
      frozenRefSlots.add(slot)
      continue
    }
    refs.push({ ...item, base64: arrayBufferToBase64(bytes) })
  }
  await saveStoredReferences(slot, refs, false)
  if (frozenRefSlots.has(slot)) {
    setStatus({ error: 'Some reference photos could not be downloaded. Reload the page to try again.' })
  }
}

async function downloadBlob(id: string): Promise<ArrayBuffer | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`/api/blob/${encodeURIComponent(id)}`, { cache: 'no-store' })
      if (res.ok) return await res.arrayBuffer()
      if (res.status === 404) return null
    } catch {
      // network blip — try again
    }
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
  }
  return null
}

function installHooks(): void {
  Storage.prototype.setItem = function (name: string, value: string) {
    rawSetItem.call(this, name, value)
    if (this === window.localStorage && isSyncedKey(name)) noteChange(name)
  }
  Storage.prototype.removeItem = function (name: string) {
    rawRemoveItem.call(this, name)
    if (this === window.localStorage && isSyncedKey(name)) noteChange(name)
  }
  onStoredReferencesChange((slot, refs) => {
    if (frozenRefSlots.has(slot)) return
    pendingRefs.set(slot, refs)
    noteChange(`refs:${slot}`)
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForRemoteChanges()
  })
  window.addEventListener('beforeunload', (e) => {
    if (dirty.size === 0) return
    void pushNow({ keepalive: true })
    e.preventDefault()
  })
}

function noteChange(name: string): void {
  const current = currentValue(name)
  if (current === syncedValues.get(name) && baseVersions.has(name)) dirty.delete(name)
  else dirty.add(name)
  if (dirty.size > 0) schedulePush()
}

function currentValue(name: string): string | null {
  if (name.startsWith('refs:')) {
    const refs = pendingRefs.get(name.slice(5))
    return refs ? refListJson(refs) : (syncedValues.get(name) ?? null)
  }
  return localStorage.getItem(name)
}

function schedulePush(delay = PUSH_DELAY_MS): void {
  if (status.state === 'conflict' || status.state === 'signed-out') return
  clearTimeout(pushTimer)
  if (status.state !== 'offline') setStatus({ state: 'saving' })
  pushTimer = window.setTimeout(() => void pushNow(), delay)
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

async function pushNow({ force = false, keepalive = false } = {}): Promise<boolean> {
  if (pushing && !keepalive) {
    schedulePush()
    return false
  }
  if (dirty.size === 0) return true
  pushing = true
  try {
    const changes: Record<string, { value: string | null; base: number }> = {}
    for (const name of dirty) {
      if (name.startsWith('refs:')) {
        if (keepalive) continue // photo uploads can't ride on a closing tab
        const slot = name.slice(5)
        const refs = pendingRefs.get(slot) ?? (await loadStoredReferences(slot))
        await uploadMissingBlobs(refs)
        changes[name] = { value: refListJson(refs), base: baseVersions.get(name) ?? 0 }
      } else {
        changes[name] = { value: localStorage.getItem(name), base: baseVersions.get(name) ?? 0 }
      }
    }
    if (Object.keys(changes).length === 0) return true

    const res = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NBR': '1' },
      body: JSON.stringify({ changes, force }),
      keepalive,
    })
    if (res.status === 401) {
      setStatus({ state: 'signed-out' })
      return false
    }
    if (res.status === 409) {
      const body = (await res.json()) as { conflicts: Record<string, StoredValue> }
      setStatus({ state: 'conflict', conflictKeys: Object.keys(body.conflicts) })
      return false
    }
    if (!res.ok) throw new Error(`push failed (${res.status}): ${(await res.text()).slice(0, 200)}`)

    const { versions } = (await res.json()) as { versions: Record<string, number> }
    for (const [name, change] of Object.entries(changes)) {
      baseVersions.set(name, versions[name])
      syncedValues.set(name, change.value)
      // Edited again while the push was in flight? Then it stays dirty.
      if (currentValue(name) === change.value) dirty.delete(name)
    }
    retryDelay = 5000
    setStatus({ state: dirty.size > 0 ? 'saving' : 'synced', lastSyncedAt: Date.now(), conflictKeys: [], error: null })
    return true
  } catch (err) {
    if (keepalive) return false
    setStatus({ state: 'offline', error: err instanceof Error ? err.message : String(err) })
    retryDelay = Math.min(retryDelay * 2, 60000)
    return false
  } finally {
    pushing = false
    if (dirty.size > 0 && status.state !== 'conflict' && status.state !== 'signed-out') {
      schedulePush(status.state === 'offline' ? retryDelay : PUSH_DELAY_MS)
    }
  }
}

async function uploadMissingBlobs(refs: StoredReference[]): Promise<void> {
  for (const ref of refs) {
    if (blobsInCloud.has(ref.id)) continue
    const res = await fetch(`/api/blob/${encodeURIComponent(ref.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': ref.mimeType || 'image/png', 'X-NBR': '1' },
      body: base64ToBlob(ref.base64, ref.mimeType || 'image/png'),
    })
    if (res.status === 401) throw new Error('signed out')
    if (!res.ok) throw new Error(`photo upload failed (${res.status})`)
    blobsInCloud.add(ref.id)
  }
}

// ---------------------------------------------------------------------------
// Another device's changes
// ---------------------------------------------------------------------------

async function checkForRemoteChanges(): Promise<void> {
  if (status.state !== 'synced') return
  try {
    const res = await fetch('/api/snapshot', { cache: 'no-store' })
    if (res.status === 401) return setStatus({ state: 'signed-out' })
    if (!res.ok) return
    const { keys } = (await res.json()) as { keys: Record<string, StoredValue> }
    const changed = Object.entries(keys).some(
      ([name, stored]) =>
        (name.startsWith('refs:') || isSyncedKey(name)) && stored.version !== (baseVersions.get(name) ?? 0),
    )
    if (changed && status.state === 'synced') setStatus({ state: 'stale' })
  } catch {
    // offline for a moment — the next focus checks again
  }
}

// ---------------------------------------------------------------------------
// Actions for the UI
// ---------------------------------------------------------------------------

// Replace everything here with the cloud copy, then restart the page on it
export async function loadCloudVersion(): Promise<void> {
  const res = await fetch('/api/snapshot', { cache: 'no-store' })
  if (res.status === 401) return goToLogin()
  if (!res.ok) throw new Error(`Could not load from the cloud (${res.status})`)
  const { keys } = (await res.json()) as { keys: Record<string, StoredValue> }
  dirty.clear()
  clearTimeout(pushTimer)
  await applySnapshot(keys)
  location.reload()
}

// Overwrite the cloud with this device's version of the conflicting values
export async function keepThisVersion(): Promise<void> {
  setStatus({ state: 'saving', conflictKeys: [] })
  await pushNow({ force: true })
}

// Seeds the cloud from a prompt file saved by the app (file sync / backup)
export async function importIntoCloud(values: Record<string, string>): Promise<void> {
  while (pushing) await new Promise((resolve) => setTimeout(resolve, 100))
  for (const [name, value] of Object.entries(values)) localStorage.setItem(name, value)
  if (status.state === 'conflict') setStatus({ state: 'saving', conflictKeys: [] })
  const ok = await pushNow({ force: true })
  if (!ok) throw new Error(status.error ?? 'The cloud did not accept the import')
  location.reload()
}

export async function signOut(): Promise<void> {
  if (dirty.size > 0) await pushNow()
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = '/logout'
  document.body.appendChild(form)
  form.submit()
}

function goToLogin(): Promise<never> {
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`
  // The page is navigating away; nothing should render meanwhile
  return new Promise<never>(() => {})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refListJson(refs: StoredReference[]): string {
  return JSON.stringify(refs.map(({ id, name, mimeType }) => ({ id, name, mimeType })))
}

function parseRefList(value: string | null): { id: string; name: string; mimeType: string }[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is { id: string; name: string; mimeType: string } =>
        typeof r?.id === 'string' && typeof r?.mimeType === 'string' && typeof r?.name === 'string',
    )
  } catch {
    return []
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
