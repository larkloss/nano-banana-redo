import { useRef, useState } from 'react'
import { importIntoCloud, signOut, useCloudStatus } from '../../lib/cloud'
import { parsePayloadText } from '../../lib/promptFile'
import { loadPromptWorkspace, loadSettings } from '../../lib/storage'
import { downloadBlob } from '../../lib/imageUtils'
import { statusText } from './statusText'

// Replaces the "save to a file" card when the app runs from the cloud
// deployment: shows sync status, seeds the cloud from an existing prompt
// file, downloads a backup, signs out.
export function CloudSection() {
  const cloud = useCloudStatus()
  const fileInput = useRef<HTMLInputElement>(null)
  const [importState, setImportState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })

  const onFile = async (file: File) => {
    setImportState({ busy: true, error: null })
    try {
      const payload = parsePayloadText(await file.text())
      if (!payload) throw new Error('That file is empty.')
      // Same storage entries the app itself writes; the page reloads on them
      await importIntoCloud({
        'nbr.promptModules.v1': JSON.stringify(payload.workspace),
        'nbr.settings.v1': JSON.stringify(payload.settings),
      })
    } catch (err) {
      setImportState({ busy: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const downloadBackup = () => {
    const payload = { version: 1, updatedAt: Date.now(), workspace: loadPromptWorkspace(), settings: loadSettings() }
    const stamp = new Date().toISOString().slice(0, 10)
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `nano-banana-prompts_${stamp}.json`,
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <StatusDot state={cloud.state} />
        <span className="text-zinc-300">{statusText(cloud.state, cloud.lastSyncedAt)}</span>
      </div>
      {cloud.error && cloud.state !== 'offline' && <p className="text-[11px] text-amber-400">{cloud.error}</p>}

      {cloud.cloudWasEmpty && (
        <p className="rounded-xl bg-blue-500/10 px-3 py-2 text-[11px] leading-relaxed text-blue-300">
          The cloud is empty. Import the prompt file you already have (the .json the old “Save as…” wrote) and
          everything in it moves in.
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={importState.busy}
          className="rounded-full border border-zinc-700 px-3 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          title="Load prompts and settings from a .json file saved by this app — replaces what's in the cloud"
        >
          {importState.busy ? 'Importing…' : '↑ Import a saved file…'}
        </button>
        <button
          type="button"
          onClick={downloadBackup}
          className="rounded-full border border-zinc-700 px-3 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          title="Download prompts and settings as a .json file (it can be imported again)"
        >
          ↓ Download backup
        </button>
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-full border border-zinc-700 px-3 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
        >
          Sign out
        </button>
      </div>
      {importState.error && <p className="text-[11px] text-red-400">Import failed — {importState.error}</p>}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void onFile(file)
        }}
      />
      <p className="text-[10px] leading-relaxed text-zinc-600">
        Prompts, settings and reference photos sync to your private cloud and show up on every device you sign in
        from. API keys never leave this browser — enter them once per device.
      </p>
    </div>
  )
}

export function StatusDot({ state }: { state: string }) {
  const color =
    state === 'synced'
      ? 'bg-emerald-500'
      : state === 'saving'
        ? 'bg-blue-500 animate-pulse'
        : state === 'conflict' || state === 'signed-out'
          ? 'bg-red-500'
          : 'bg-amber-500'
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />
}
