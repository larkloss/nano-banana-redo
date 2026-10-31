import { useState } from 'react'
import { keepThisVersion, loadCloudVersion, signOut, useCloudStatus } from '../../lib/cloud'
import { StatusDot } from './CloudSection'
import { statusText } from './statusText'

// Problems that need a decision float at the top of every page. With `pill`,
// a small status chip (with sign-out) also sits in the corner — for the edit
// and video pages, which have no cloud card of their own.
export function CloudBanner({ pill = false }: { pill?: boolean }) {
  const cloud = useCloudStatus()
  const [busy, setBusy] = useState(false)
  if (cloud.state === 'off') return null

  const run = (action: () => Promise<void>) => {
    setBusy(true)
    void action().finally(() => setBusy(false))
  }

  const banner =
    cloud.state === 'conflict' ? (
      <>
        <span>
          This was also changed on another device ({describeKeys(cloud.conflictKeys)}). Which version should win?
        </span>
        <BannerButton disabled={busy} onClick={() => run(loadCloudVersion)} primary>
          Use the cloud version
        </BannerButton>
        <BannerButton disabled={busy} onClick={() => run(keepThisVersion)}>
          Keep this one
        </BannerButton>
      </>
    ) : cloud.state === 'stale' ? (
      <>
        <span>You changed things on another device. Reload to bring them in — download any new pictures first.</span>
        <BannerButton disabled={busy} onClick={() => location.reload()} primary>
          Reload
        </BannerButton>
      </>
    ) : cloud.state === 'signed-out' ? (
      <>
        <span>Your session ended. Changes are kept in this browser until you sign in again.</span>
        <BannerButton disabled={busy} onClick={() => location.reload()} primary>
          Sign in
        </BannerButton>
      </>
    ) : null

  return (
    <>
      {banner && (
        <div className="fixed inset-x-0 top-3 z-[60] flex justify-center px-3">
          <div
            role="alert"
            className="soft-shadow flex max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-xs text-zinc-200"
          >
            {banner}
          </div>
        </div>
      )}
      {pill && (
        <div className="fixed bottom-3 left-3 z-[55] flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-[11px] text-zinc-300 shadow">
          <StatusDot state={cloud.state} />
          {statusText(cloud.state, cloud.lastSyncedAt)}
          <button type="button" onClick={() => void signOut()} className="ml-1 text-zinc-500 hover:text-red-400">
            Sign out
          </button>
        </div>
      )}
    </>
  )
}

function BannerButton({
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
      className={`rounded-full px-3 py-1 font-medium disabled:opacity-50 ${
        primary ? 'bg-blue-600 text-white hover:bg-blue-500' : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  )
}

const KEY_LABELS: Record<string, string> = {
  'nbr.promptModules.v1': 'prompts',
  'nbr.settings.v1': 'settings',
  'nbr.videoPromptModules.v1': 'video prompts',
  'nbr.videoSettings.v1': 'video settings',
  'nbr.edit.settings.v1': 'edit settings',
  'refs:generator': 'reference photos',
}

function describeKeys(keys: string[]): string {
  const labels = [...new Set(keys.map((k) => KEY_LABELS[k] ?? k.replace(/^nbr\./, '')))]
  return labels.join(', ') || 'settings'
}
