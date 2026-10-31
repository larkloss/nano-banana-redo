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
// Each value carries a version; a push only applies if this device saw the
// latest version of that value, so another device's newer edit is never
// silently overwritten — it surfaces as a conflict instead.
//
// Edits not yet pushed are remembered on the device (META_KEY), so closing
// the tab mid-save or going offline never lets the next load overwrite them.
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
// Where unpushed edits are remembered. Deliberately not "nbr." so it never syncs.
const META_KEY = 'nbrcloud.meta.v1'
const PUSH_DELAY_MS = 1200
// Photos above this are re-encoded as JPEG for the cloud copy (the device
// keeps its original); keeps every upload far from the server's limits
const SYNC_PHOTO_MAX_BYTES = 8 * 1024 * 1024

export function isSyncedKey(name: string): boolean {
  return name.startsWith('nbr.') && !/api.?key/i.test(name) && !DEVICE_ONLY_KEYS.has(name)
}

interface StoredValue {
  value: string | null
  version: number
}

interface RefItem {
  id: string
  name: string
  mimeType: string
}

class SignedOutError extends Error {}

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

// Version of each value this device's copy is based on (0 = never in the cloud)
const baseVersions = new Map<string, number>()
// The cloud's value at that version, to tell real edits from rewrites
const syncedValues = new Map<string, string | null>()
const dirty = new Set<string>()
// Keys the user chose to overwrite the cloud with ("keep this one", import)
const forceKeys = new Set<string>()
const pendingRefs = new Map<string, StoredReference[]>()
// Photos the cloud lists that couldn't be downloaded right now. They stay in
// every list this device pushes, so a network blip never deletes them.
const unresolvedRefs = new Map<string, RefItem[]>()
const blobsInCloud = new Set<string>()
let pushTimer: number | undefined
let pushing = false
let retryDelay = 5000
let missingBlobRetries = 0

const rawSetItem = Storage.prototype.setItem
const rawRemoveItem = Storage.prototype.removeItem

function saveMeta(): void {
  const base: Record<string, number> = {}
  for (const name of dirty) base[name] = baseVersions.get(name) ?? 0
  try {
    rawSetItem.call(localStorage, META_KEY, JSON.stringify({ dirty: [...dirty], base }))
  } catch {
    // storage full — unpushed edits just aren't remembered across reloads
  }
}

function loadMeta(): { dirty: string[]; base: Record<string, number> } {
  try {
    const parsed = JSON.parse(localStorage.getItem(META_KEY) ?? '{}') as { dirty?: unknown; base?: unknown }
    return {
      dirty: Array.isArray(parsed.dirty) ? parsed.dirty.filter((n): n is string => typeof n === 'string') : [],
      base: parsed.base && typeof parsed.base === 'object' ? (parsed.base as Record<string, number>) : {},
    }
  } catch {
    return { dirty: [], base: {} }
  }
}

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

  const meta = loadMeta()
  const unpushed = new Set(meta.dirty)
  const conflicts: string[] = []

  for (const [name, stored] of Object.entries(keys)) {
    if (!name.startsWith('refs:') && !isSyncedKey(name)) continue
    syncedValues.set(name, stored.value)
    if (unpushed.has(name)) {
      // An edit from an earlier visit never reached the cloud: keep it
      const local = await localValue(name)
      if (local === stored.value) {
        baseVersions.set(name, stored.version)
      } else {
        const seen = meta.base[name] ?? 0
        baseVersions.set(name, seen)
        dirty.add(name)
        // …and if the cloud moved on meanwhile, ask which one wins
        if (stored.version !== seen) conflicts.push(name)
      }
      continue
    }
    await applyValue(name, stored)
  }

  // Edits the cloud has never seen at all, and leftovers from earlier visits
  for (const name of unpushed) {
    if (!(name in keys)) {
      baseVersions.set(name, 0)
      dirty.add(name)
    }
  }
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i)
    if (name && isSyncedKey(name) && !(name in keys)) dirty.add(name)
  }
  for (const slot of REF_SLOTS) {
    if (!(`refs:${slot}` in keys) && (await loadStoredReferences(slot)).length > 0) dirty.add(`refs:${slot}`)
  }
  saveMeta()

  installHooks()
  setStatus({
    state: conflicts.length > 0 ? 'conflict' : 'synced',
    conflictKeys: conflicts,
    lastSyncedAt: Date.now(),
    cloudWasEmpty: !keys['nbr.promptModules.v1']?.value,
  })
  if (dirty.size > 0) schedulePush()
}

// Writes one cloud value into local storage without it counting as an edit
async function applyValue(name: string, stored: StoredValue): Promise<void> {
  if (name.startsWith('refs:')) await applyRefs(name.slice(5), stored)
  else if (stored.value === null) rawRemoveItem.call(localStorage, name)
  else rawSetItem.call(localStorage, name, stored.value)
  baseVersions.set(name, stored.version)
  syncedValues.set(name, stored.value)
}

async function localValue(name: string): Promise<string | null> {
  if (!name.startsWith('refs:')) return localStorage.getItem(name)
  const slot = name.slice(5)
  return refListJson(slot, await loadStoredReferences(slot))
}

async function applyRefs(slot: string, stored: StoredValue): Promise<void> {
  const local = new Map((await loadStoredReferences(slot)).map((r) => [r.id, r]))
  const refs: StoredReference[] = []
  const unresolved: RefItem[] = []
  for (const item of parseRefList(stored.value)) {
    blobsInCloud.add(item.id)
    const have = local.get(item.id)
    if (have) {
      refs.push({ ...have, name: item.name })
      continue
    }
    const result = await downloadBlob(item.id)
    if (result === 'gone') continue // the cloud lost it; nothing to recover
    if (result === 'failed') {
      unresolved.push(item)
      continue
    }
    refs.push({ ...item, mimeType: result.mimeType || item.mimeType, base64: arrayBufferToBase64(result.bytes) })
  }
  if (unresolved.length > 0) {
    unresolvedRefs.set(slot, unresolved)
    setStatus({ error: 'Some reference photos could not be downloaded. They are safe in the cloud — reload to retry.' })
  } else {
    unresolvedRefs.delete(slot)
  }
  await saveStoredReferences(slot, refs, false)
}

async function downloadBlob(id: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | 'gone' | 'failed'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`/api/blob/${encodeURIComponent(id)}`, { cache: 'no-store' })
      if (res.ok) return { bytes: await res.arrayBuffer(), mimeType: res.headers.get('Content-Type') ?? '' }
      if (res.status === 404) return 'gone'
    } catch {
      // network blip — try again
    }
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
  }
  return 'failed'
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
    pendingRefs.set(slot, refs)
    noteChange(`refs:${slot}`)
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForRemoteChanges()
  })
  // Best effort only — unpushed edits are remembered and go up next visit
  window.addEventListener('pagehide', () => {
    if (dirty.size > 0) void pushNow({ keepalive: true })
  })
}

function noteChange(name: string): void {
  if (currentValue(name) === syncedValues.get(name) && baseVersions.has(name) && !forceKeys.has(name)) {
    dirty.delete(name)
  } else {
    dirty.add(name)
  }
  saveMeta()
  if (dirty.size > 0) {
    schedulePush()
  } else if (!pushing) {
    // Edited and changed back before the push went out: nothing to save
    clearTimeout(pushTimer)
    if (status.state === 'saving') setStatus({ state: 'synced' })
  }
}

function currentValue(name: string): string | null {
  if (name.startsWith('refs:')) {
    const slot = name.slice(5)
    const refs = pendingRefs.get(slot)
    return refs ? refListJson(slot, refs) : (syncedValues.get(name) ?? null)
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

async function pushNow({ keepalive = false } = {}): Promise<boolean> {
  if (pushing && !keepalive) {
    schedulePush()
    return false
  }
  if (dirty.size === 0) {
    if (status.state === 'saving') setStatus({ state: 'synced', lastSyncedAt: Date.now() })
    return true
  }
  pushing = true
  let photoProblem: string | null = null
  try {
    const changes: Record<string, { value: string | null; base: number; force?: boolean }> = {}
    for (const name of dirty) {
      const force = forceKeys.has(name) || undefined
      if (name.startsWith('refs:')) {
        if (keepalive) continue // photo uploads can't ride on a closing tab
        const slot = name.slice(5)
        const refs = pendingRefs.get(slot) ?? (await loadStoredReferences(slot))
        try {
          await uploadMissingBlobs(refs)
        } catch (err) {
          if (err instanceof SignedOutError) throw err
          // One photo failing must not hold up everything else
          photoProblem = err instanceof Error ? err.message : String(err)
          continue
        }
        changes[name] = { value: refListJson(slot, refs), base: baseVersions.get(name) ?? 0, force }
      } else {
        changes[name] = { value: localStorage.getItem(name), base: baseVersions.get(name) ?? 0, force }
      }
    }
    if (Object.keys(changes).length === 0) {
      if (photoProblem) throw new Error(photoProblem)
      return true
    }

    const res = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NBR': '1' },
      body: JSON.stringify({ changes }),
      keepalive,
    })
    if (res.status === 401) throw new SignedOutError()
    if (res.status === 409) {
      const body = (await res.json()) as { conflicts: Record<string, StoredValue> }
      setStatus({ state: 'conflict', conflictKeys: Object.keys(body.conflicts) })
      return false
    }
    if (res.status === 422) {
      // The server doesn't have some photos the list names: upload them again
      const { missingBlobs } = (await res.json()) as { missingBlobs: string[] }
      for (const id of missingBlobs) blobsInCloud.delete(id)
      for (const [slot, items] of unresolvedRefs) {
        unresolvedRefs.set(
          slot,
          items.filter((item) => !missingBlobs.includes(item.id)),
        )
      }
      if (++missingBlobRetries > 2) throw new Error('Some reference photos could not be stored in the cloud')
      return false
    }
    if (!res.ok) throw new Error(`push failed (${res.status}): ${(await res.text()).slice(0, 200)}`)

    const { versions } = (await res.json()) as { versions: Record<string, number> }
    for (const [name, change] of Object.entries(changes)) {
      baseVersions.set(name, versions[name])
      syncedValues.set(name, change.value)
      forceKeys.delete(name)
      // Edited again while the push was in flight? Then it stays dirty.
      if (currentValue(name) === change.value) dirty.delete(name)
    }
    saveMeta()
    missingBlobRetries = 0
    if (photoProblem) throw new Error(photoProblem)
    retryDelay = 5000
    setStatus({ state: dirty.size > 0 ? 'saving' : 'synced', lastSyncedAt: Date.now(), conflictKeys: [], error: null })
    return true
  } catch (err) {
    if (err instanceof SignedOutError) {
      setStatus({ state: 'signed-out' })
      return false
    }
    if (keepalive) return false
    setStatus({ state: 'offline', error: err instanceof Error ? err.message : String(err) })
    retryDelay = Math.min(retryDelay * 2, 60000)
    return false
  } finally {
    pushing = false
    if (!keepalive && dirty.size > 0 && status.state !== 'conflict' && status.state !== 'signed-out') {
      schedulePush(status.state === 'offline' ? retryDelay : missingBlobRetries > 0 ? 0 : PUSH_DELAY_MS)
    }
  }
}

async function uploadMissingBlobs(refs: StoredReference[]): Promise<void> {
  for (const ref of refs) {
    if (blobsInCloud.has(ref.id)) continue
    const body = await cloudCopy(base64ToBlob(ref.base64, ref.mimeType || 'image/png'))
    const res = await fetch(`/api/blob/${encodeURIComponent(ref.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': body.type || 'image/png', 'X-NBR': '1' },
      body,
    })
    if (res.status === 401) throw new SignedOutError()
    if (!res.ok) throw new Error(`Photo “${ref.name}” could not be uploaded (${res.status})`)
    blobsInCloud.add(ref.id)
  }
}

// Big photos travel as a JPEG that fits under SYNC_PHOTO_MAX_BYTES
async function cloudCopy(blob: Blob): Promise<Blob> {
  if (blob.size <= SYNC_PHOTO_MAX_BYTES) return blob
  const bitmap = await createImageBitmap(blob)
  let scale = 1
  try {
    for (let i = 0; i < 6; i++) {
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
      if (jpeg.size <= SYNC_PHOTO_MAX_BYTES) return jpeg
      scale *= Math.sqrt(SYNC_PHOTO_MAX_BYTES / jpeg.size) * 0.95
    }
  } finally {
    bitmap.close()
  }
  throw new Error('A reference photo is too large to sync')
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

// Resolve a conflict in the cloud's favour: take its copy of the conflicting
// values (other unpushed edits are kept), then restart the page on them
export async function loadCloudVersion(): Promise<void> {
  const res = await fetch('/api/snapshot', { cache: 'no-store' })
  if (res.status === 401) return goToLogin()
  if (!res.ok) throw new Error(`Could not load from the cloud (${res.status})`)
  const { keys } = (await res.json()) as { keys: Record<string, StoredValue> }
  clearTimeout(pushTimer)
  const names = status.conflictKeys.length > 0 ? status.conflictKeys : Object.keys(keys)
  for (const name of names) {
    const stored = keys[name] ?? { value: null, version: 0 }
    if (name.startsWith('refs:')) pendingRefs.delete(name.slice(5))
    await applyValue(name, stored)
    dirty.delete(name)
    forceKeys.delete(name)
  }
  saveMeta()
  location.reload()
}

// Resolve a conflict in this device's favour: overwrite only the values the
// banner listed; other edits still go through the normal version check
export async function keepThisVersion(): Promise<void> {
  status.conflictKeys.forEach((name) => {
    forceKeys.add(name)
    dirty.add(name)
  })
  setStatus({ state: 'saving', conflictKeys: [] })
  await pushNow()
}

// Seeds the cloud from a prompt file saved by the app (file sync / backup)
export async function importIntoCloud(values: Record<string, string>): Promise<void> {
  while (pushing) await new Promise((resolve) => setTimeout(resolve, 100))
  for (const [name, value] of Object.entries(values)) {
    forceKeys.add(name)
    localStorage.setItem(name, value)
  }
  if (status.state === 'conflict') setStatus({ state: 'saving', conflictKeys: [] })
  const ok = await pushNow()
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

// The list this device publishes: its photos, plus any the cloud has that
// couldn't be downloaded here (so they aren't dropped by accident)
function refListJson(slot: string, refs: StoredReference[]): string {
  const items: RefItem[] = refs.map(({ id, name, mimeType }) => ({ id, name, mimeType }))
  const have = new Set(items.map((i) => i.id))
  for (const item of unresolvedRefs.get(slot) ?? []) if (!have.has(item.id)) items.push(item)
  return JSON.stringify(items)
}

function parseRefList(value: string | null): RefItem[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is RefItem => typeof r?.id === 'string' && typeof r?.mimeType === 'string' && typeof r?.name === 'string',
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
