import { useCallback, useEffect, useRef, useState } from 'react'
import type { PromptWorkspace, Settings } from '../types'
import {
  checkPermission,
  isFileSyncSupported,
  pickExistingSyncFile,
  pickNewSyncFile,
  readPayload,
  recallHandle,
  rememberHandle,
  writePayload,
  type PromptFilePayload,
  type SyncFileHandle,
} from '../lib/promptFile'

const SLOT = 'generator'
const LOCAL_STAMP_KEY = 'nbr.promptSync.updatedAt'
const WRITE_DEBOUNCE_MS = 1200

export type SyncStatus =
  | { kind: 'unsupported' }
  | { kind: 'off' }
  | { kind: 'needs-permission'; fileName: string }
  | { kind: 'ready'; fileName: string; savedAt: number | null }
  | { kind: 'saving'; fileName: string }
  | { kind: 'error'; fileName: string | null; message: string }

interface Params {
  workspace: PromptWorkspace
  settings: Settings
  // Applied when the file turns out to be newer than what's in this browser
  onAdopt: (payload: PromptFilePayload) => void
}

// Mirrors the prompt library and run settings into a user-picked file. The
// file is the durable copy — localStorage stays as the fast local cache.
export function usePromptFileSync({ workspace, settings, onAdopt }: Params) {
  const supported = isFileSyncSupported()
  const [status, setStatus] = useState<SyncStatus>(supported ? { kind: 'off' } : { kind: 'unsupported' })
  const handleRef = useRef<SyncFileHandle | null>(null)
  // Serialized copy of what the file is known to hold, so echoing an adopted
  // payload back to disk (and pointless rewrites) can be skipped
  const syncedRef = useRef<string | null>(null)
  const localStampRef = useRef<number>(readLocalStamp())
  // Last content seen by the change watcher, to tell real edits from re-renders
  const baselineRef = useRef<string | null>(null)
  const writeTimer = useRef<number | undefined>(undefined)
  // Latest values for the debounced writer, which fires long after render
  const liveRef = useRef({ workspace, settings })
  useEffect(() => {
    liveRef.current = { workspace, settings }
  }, [workspace, settings])

  const bodyOf = (w: PromptWorkspace, s: Settings) => JSON.stringify({ workspace: w, settings: s })

  const push = useCallback(async (reason: 'auto' | 'manual') => {
    const handle = handleRef.current
    if (!handle) return
    const { workspace: w, settings: s } = liveRef.current
    const payload: PromptFilePayload = {
      version: 1,
      updatedAt: Date.now(),
      workspace: w,
      settings: s,
    }
    setStatus({ kind: 'saving', fileName: handle.name })
    try {
      await writePayload(handle, payload)
      syncedRef.current = bodyOf(w, s)
      localStampRef.current = payload.updatedAt
      writeLocalStamp(payload.updatedAt)
      setStatus({ kind: 'ready', fileName: handle.name, savedAt: payload.updatedAt })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(
        reason === 'auto' && /not allowed|permission/i.test(message)
          ? { kind: 'needs-permission', fileName: handle.name }
          : { kind: 'error', fileName: handle.name, message },
      )
    }
  }, [])

  // Whichever side changed last wins; ties keep the local copy.
  const connect = useCallback(
    async (handle: SyncFileHandle, opts: { force?: 'pull' | 'push' } = {}) => {
      handleRef.current = handle
      try {
        const filePayload = await readPayload(handle).catch((err) => {
          // An empty new file is fine — anything else is a real problem
          if (err instanceof SyntaxError) return null
          throw err
        })
        const pull =
          opts.force === 'pull' ||
          (opts.force !== 'push' && filePayload !== null && filePayload.updatedAt > localStampRef.current)

        if (pull && filePayload) {
          syncedRef.current = bodyOf(filePayload.workspace, filePayload.settings)
          localStampRef.current = filePayload.updatedAt
          writeLocalStamp(filePayload.updatedAt)
          onAdopt(filePayload)
          await rememberHandle(SLOT, handle)
          setStatus({ kind: 'ready', fileName: handle.name, savedAt: filePayload.updatedAt })
          return
        }
        await rememberHandle(SLOT, handle)
        await push('manual')
      } catch (err) {
        setStatus({ kind: 'error', fileName: handle.name, message: err instanceof Error ? err.message : String(err) })
      }
    },
    [onAdopt, push],
  )

  // Reattach to the previously chosen file. Chrome usually needs one click to
  // re-grant access, so this only reconnects silently when already permitted.
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void (async () => {
      const handle = await recallHandle(SLOT)
      if (!handle || cancelled) return
      const permission = await checkPermission(handle, false)
      if (cancelled) return
      if (permission === 'granted') {
        void connect(handle)
      } else {
        handleRef.current = handle
        setStatus({ kind: 'needs-permission', fileName: handle.name })
      }
    })()
    return () => {
      cancelled = true
    }
    // Runs once: reconnecting is a startup concern, not a per-render one
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported])

  // Local edits → stamp the change, then write it out (debounced).
  // Merely opening the app is not a change: stamping on mount would make an
  // untouched browser look newer than the file and overwrite it with nothing.
  useEffect(() => {
    const body = bodyOf(workspace, settings)
    if (baselineRef.current === null) {
      baselineRef.current = body
      return
    }
    if (body === baselineRef.current) return
    baselineRef.current = body
    // Content that just arrived from the file isn't a local edit
    if (body === syncedRef.current) return

    localStampRef.current = Date.now()
    writeLocalStamp(localStampRef.current)
    if (syncedRef.current === null || !handleRef.current || status.kind === 'needs-permission') return
    clearTimeout(writeTimer.current)
    writeTimer.current = window.setTimeout(() => void push('auto'), WRITE_DEBOUNCE_MS)
    return () => clearTimeout(writeTimer.current)
  }, [workspace, settings, push, status.kind])

  const connectNew = useCallback(async () => {
    const handle = await pickNewSyncFile()
    if (handle) await connect(handle, { force: 'push' })
  }, [connect])

  // Picking an existing file means "use what's in it" — never the reverse
  const connectExisting = useCallback(async () => {
    const handle = await pickExistingSyncFile()
    if (handle) await connect(handle, { force: 'pull' })
  }, [connect])

  const grantPermission = useCallback(async () => {
    const handle = handleRef.current
    if (!handle) return
    const permission = await checkPermission(handle, true)
    if (permission === 'granted') await connect(handle)
    else setStatus({ kind: 'error', fileName: handle.name, message: 'Access to the file was denied' })
  }, [connect])

  const disconnect = useCallback(async () => {
    clearTimeout(writeTimer.current)
    handleRef.current = null
    syncedRef.current = null
    await rememberHandle(SLOT, null)
    setStatus({ kind: 'off' })
  }, [])

  const pullNow = useCallback(async () => {
    const handle = handleRef.current
    if (handle) await connect(handle, { force: 'pull' })
  }, [connect])

  return { status, connectNew, connectExisting, grantPermission, disconnect, pullNow, pushNow: () => void push('manual') }
}

function readLocalStamp(): number {
  try {
    return Number(localStorage.getItem(LOCAL_STAMP_KEY)) || 0
  } catch {
    return 0
  }
}

function writeLocalStamp(value: number): void {
  try {
    localStorage.setItem(LOCAL_STAMP_KEY, String(value))
  } catch {
    // ignore
  }
}
