import type { SyncStatus } from '../../hooks/usePromptFileSync'

interface Props {
  status: SyncStatus
  onConnectNew: () => void
  onConnectExisting: () => void
  onGrantPermission: () => void
  onDisconnect: () => void
  onPull: () => void
  disabled: boolean
}

export function SyncSection({
  status,
  onConnectNew,
  onConnectExisting,
  onGrantPermission,
  onDisconnect,
  onPull,
  disabled,
}: Props) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">Prompt &amp; settings file</span>
        <StatusDot status={status} />
      </div>

      {status.kind === 'unsupported' ? (
        <p className="text-[10px] leading-snug text-zinc-600">
          This browser can't sync to a file — Chrome or Edge is required. Prompts stay in this browser only.
        </p>
      ) : status.kind === 'off' ? (
        <>
          <div className="flex gap-1.5">
            <SmallButton onClick={onConnectNew} disabled={disabled}>
              New file…
            </SmallButton>
            <SmallButton onClick={onConnectExisting} disabled={disabled}>
              Open existing…
            </SmallButton>
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-600">
            Keeps prompts and settings in a file instead of only this browser. Put it in an iCloud/Dropbox/OneDrive
            folder and another computer picking the same file gets everything. API keys are never written to it.
          </p>
        </>
      ) : status.kind === 'needs-permission' ? (
        <>
          <SmallButton onClick={onGrantPermission} disabled={disabled} primary>
            Reconnect to {status.fileName}
          </SmallButton>
          <p className="mt-1.5 text-[10px] leading-snug text-amber-400/80">
            The browser asks for file access once per session — until then, changes stay local.
          </p>
        </>
      ) : status.kind === 'error' ? (
        <>
          <p className="mb-1.5 text-[10px] leading-snug text-red-400">{status.message}</p>
          <div className="flex gap-1.5">
            <SmallButton onClick={onConnectExisting} disabled={disabled}>
              Pick file again…
            </SmallButton>
            <SmallButton onClick={onDisconnect} disabled={disabled}>
              Turn off
            </SmallButton>
          </div>
        </>
      ) : (
        <>
          <p className="truncate text-[11px] text-zinc-300" title={status.fileName}>
            {status.fileName}
          </p>
          <p className="mt-0.5 text-[10px] text-zinc-600">
            {status.kind === 'saving'
              ? 'Saving…'
              : status.savedAt
                ? `Saved ${formatTime(status.savedAt)} · changes save automatically`
                : 'Changes save automatically'}
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <SmallButton onClick={onPull} disabled={disabled}>
              Reload from file
            </SmallButton>
            <SmallButton onClick={onDisconnect} disabled={disabled}>
              Turn off
            </SmallButton>
          </div>
        </>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: SyncStatus }) {
  const [color, label] = {
    unsupported: ['bg-zinc-700', 'unavailable'],
    off: ['bg-zinc-600', 'local only'],
    'needs-permission': ['bg-amber-500', 'paused'],
    ready: ['bg-emerald-500', 'synced'],
    saving: ['bg-blue-400 animate-pulse', 'saving'],
    error: ['bg-red-500', 'error'],
  }[status.kind]
  return (
    <span className="flex items-center gap-1.5 text-[10px] text-zinc-500">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  )
}

function SmallButton({
  onClick,
  disabled,
  primary,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-2.5 py-1 text-[10px] disabled:opacity-40 ${
        primary
          ? 'bg-blue-600 font-medium text-white hover:bg-blue-500'
          : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  )
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
