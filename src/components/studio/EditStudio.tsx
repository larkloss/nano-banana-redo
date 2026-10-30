import { useEffect, useRef, useState } from 'react'
import type { RunState, Settings } from '../../types'
import type { EditRequest, EditSession, EditTurn, EditVersion } from '../../hooks/useEditStudio'
import { MODELS, PROVIDER_LABELS, PROVIDER_ORDER, getModel } from '../../lib/models'
import { downloadBlob, makeFilename } from '../../lib/imageUtils'
import { friendlyReason } from '../../lib/friendly'

interface Props {
  session: EditSession
  settings: Settings
  referenceCount: number
  // null while the edit is still being prepared (nothing sent yet)
  runState: RunState | null
  isRunning: boolean
  runningTurn: { sessionId: string; turnId: string } | null
  onSelectVersion: (versionId: string) => void
  onSubmit: (request: EditRequest) => void
  onRetry: (turnId: string) => void
  onStop: () => void
  onClose: () => void
}

const IMAGE_MODELS = MODELS.filter((m) => m.output === 'image')
const SUGGESTIONS = [
  'Change the background to a sunny park',
  'Make the lighting warmer and softer',
  'Change her outfit color to navy blue',
  'Fix the hands so they look natural',
  'Make it a close-up portrait',
]

export function EditStudio({
  session,
  settings,
  referenceCount,
  runState,
  isRunning,
  runningTurn,
  onSelectVersion,
  onSubmit,
  onRetry,
  onStop,
  onClose,
}: Props) {
  const [prompt, setPrompt] = useState('')
  const [candidates, setCandidates] = useState(1)
  const [withReferences, setWithReferences] = useState(false)
  const [modelId, setModelId] = useState(() =>
    getModel(settings.modelId).output === 'image' ? settings.modelId : IMAGE_MODELS[0].id,
  )
  const [comparing, setComparing] = useState(false)
  const threadEnd = useRef<HTMLDivElement>(null)

  const selected = session.versions.find((v) => v.id === session.selectedVersionId) ?? session.versions[0]
  const selectedTurn = session.turns.find((t) => t.id === selected.turnId)
  const previous = selectedTurn ? session.versions.find((v) => v.id === selectedTurn.sourceVersionId) : null
  const shown = comparing && previous ? previous : selected
  const busyHere = isRunning && runningTurn?.sessionId === session.id
  const busyElsewhere = isRunning && !busyHere
  const canSend = !isRunning && prompt.trim().length > 0

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [session.turns.length, session.versions.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLTextAreaElement)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const send = () => {
    if (!canSend) return
    onSubmit({ prompt, candidates, withReferences: withReferences && referenceCount > 0, modelId })
    setPrompt('')
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/50 p-3 backdrop-blur-sm md:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Edit studio"
        className="soft-shadow flex w-full max-w-7xl flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-500/15 text-base">✏️</span>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Edit studio</h2>
              <p className="text-[11px] text-zinc-500">
                Describe a change — refusals are retried automatically until a picture comes out.
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <label className="text-[11px] text-zinc-500" htmlFor="studio-model">
              Model
            </label>
            <select
              id="studio-model"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              disabled={isRunning}
              className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:opacity-50"
            >
              {PROVIDER_ORDER.map((provider) => (
                <optgroup key={provider} label={PROVIDER_LABELS[provider]}>
                  {IMAGE_MODELS.filter((m) => m.provider === provider).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              type="button"
              onClick={onClose}
              title="Close (Esc) — the chain is kept, reopen it from any of its pictures"
              className="rounded-xl px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
          {/* Stage: the version on screen, plus the strip of every version */}
          <section className="flex min-h-0 flex-col gap-3 p-4">
            <div className="relative flex min-h-[240px] flex-1 items-center justify-center overflow-hidden rounded-2xl bg-zinc-900">
              <img
                src={shown.image.objectUrl}
                alt={versionLabel(shown)}
                className="max-h-full max-w-full object-contain"
              />
              <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white">
                {comparing && previous ? `Before · ${versionLabel(previous)}` : versionLabel(selected)}
              </span>
              {busyHere && (
                <span className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" /> editing…
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {previous && (
                <button
                  type="button"
                  onPointerDown={() => setComparing(true)}
                  onPointerUp={() => setComparing(false)}
                  onPointerLeave={() => setComparing(false)}
                  className="select-none rounded-xl border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  title="Hold to see the picture this version was edited from"
                >
                  Hold to compare
                </button>
              )}
              <button
                type="button"
                onClick={() => downloadBlob(selected.image.blob, makeFilename(selected.image, 0))}
                className="rounded-xl border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                ↓ Download {versionLabel(selected)}
              </button>
              <span className="ml-auto text-[11px] text-zinc-500">
                {selected.image.width}×{selected.image.height} · {getModel(selected.image.modelId).label}
              </span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {session.versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => onSelectVersion(v.id)}
                  title={v.number === 0 ? 'The original picture' : `Edit: ${editPrompt(session, v)}`}
                  className={`group relative shrink-0 overflow-hidden rounded-xl border-2 transition ${
                    v.id === selected.id ? 'border-blue-500' : 'border-transparent opacity-80 hover:opacity-100'
                  }`}
                >
                  <img src={v.image.objectUrl} alt={versionLabel(v)} className="h-16 w-16 object-cover" />
                  <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[10px] font-medium text-white">
                    {v.number === 0 ? 'Original' : `v${v.number}`}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {/* Thread: one turn per instruction, newest at the bottom */}
          <section className="flex min-h-0 flex-col border-t border-zinc-800 lg:border-l lg:border-t-0">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              {session.turns.length === 0 ? (
                <div className="rounded-2xl bg-zinc-900 p-4 text-xs leading-relaxed text-zinc-400">
                  <p className="mb-2 font-medium text-zinc-200">How it works</p>
                  <ol className="list-decimal space-y-1 pl-4">
                    <li>Say what to change — one thing per turn works best.</li>
                    <li>If the model refuses, it quietly tries again until a picture comes out.</li>
                    <li>The result becomes the next version; keep refining from there.</li>
                    <li>Click any version below the picture to branch from it instead.</li>
                  </ol>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setPrompt(s)}
                        className="rounded-full border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:border-blue-500 hover:text-blue-300"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                session.turns.map((turn) => (
                  <TurnView
                    key={turn.id}
                    turn={turn}
                    session={session}
                    live={runningTurn?.turnId === turn.id ? runState : null}
                    canRetry={!isRunning}
                    onSelectVersion={onSelectVersion}
                    onRetry={() => onRetry(turn.id)}
                    onStop={onStop}
                  />
                ))
              )}
              <div ref={threadEnd} />
            </div>

            <div className="border-t border-zinc-800 p-3">
              <div className="mb-2 flex items-center gap-2 text-[11px] text-zinc-500">
                <span>
                  Editing <b className="text-zinc-300">{versionLabel(selected)}</b>
                </span>
                {busyElsewhere && (
                  <span className="text-amber-400">· another picture is being edited — wait for it</span>
                )}
              </div>
              <div className="rounded-2xl border border-zinc-700 bg-zinc-900 focus-within:border-blue-500">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      send()
                    }
                  }}
                  rows={3}
                  placeholder="What should change? e.g. “Make her hair a little longer”"
                  className="block w-full resize-none rounded-2xl bg-transparent px-3.5 pt-3 text-sm leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none"
                />
                <div className="flex flex-wrap items-center gap-2 px-2.5 pb-2.5">
                  <div
                    className="flex items-center gap-1 rounded-full bg-zinc-950 p-0.5"
                    title="How many different results to collect for this edit"
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setCandidates(n)}
                        className={`h-6 min-w-6 rounded-full px-1.5 text-[11px] ${
                          candidates === n
                            ? 'bg-blue-600 font-semibold text-white'
                            : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <label
                    className={`flex items-center gap-1.5 text-[11px] ${referenceCount > 0 ? 'text-zinc-400' : 'text-zinc-600'}`}
                    title={
                      referenceCount > 0
                        ? 'Also send your reference photos so the face stays consistent'
                        : 'No reference photos added on the main page'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={withReferences && referenceCount > 0}
                      disabled={referenceCount === 0}
                      onChange={(e) => setWithReferences(e.target.checked)}
                      className="accent-blue-500"
                    />
                    + reference photos{referenceCount > 0 ? ` (${referenceCount})` : ''}
                  </label>
                  {busyHere ? (
                    <button
                      type="button"
                      onClick={onStop}
                      className="ml-auto rounded-full bg-red-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-red-500"
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={send}
                      disabled={!canSend}
                      className="ml-auto rounded-full bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Apply edit ↵
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1.5 text-[10px] text-zinc-600">
                Enter to send · Shift+Enter for a new line · up to {settings.attemptsCap} tries per edit (Max attempts)
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function TurnView({
  turn,
  session,
  live,
  canRetry,
  onSelectVersion,
  onRetry,
  onStop,
}: {
  turn: EditTurn
  session: EditSession
  live: RunState | null
  canRetry: boolean
  onSelectVersion: (versionId: string) => void
  onRetry: () => void
  onStop: () => void
}) {
  const source = session.versions.find((v) => v.id === turn.sourceVersionId)
  const results = turn.resultVersionIds
    .map((id) => session.versions.find((v) => v.id === id))
    .filter((v): v is EditVersion => Boolean(v))
  const running = turn.status === 'running'
  const attempts = live ? live.attempts : turn.attempts
  const refusals = Math.max(0, attempts - results.length)
  const lastFailure = live ? live.lastFailure : turn.lastFailure
  const waiting = live?.lanes.find((l) => l.status === 'backoff')

  return (
    <div className="space-y-2">
      {/* The instruction, as a chat bubble */}
      <div className="flex justify-end">
        <div className="max-w-[90%] rounded-2xl rounded-br-md bg-blue-600 px-3.5 py-2 text-sm text-white">
          <p className="whitespace-pre-wrap">{turn.prompt}</p>
          <p className="mt-1 text-[10px] text-white/70">
            on {source ? versionLabel(source) : 'a removed version'} · {getModel(turn.modelId).label}
            {turn.candidates > 1 ? ` · ${turn.candidates} results` : ''}
            {turn.withReferences ? ' · with references' : ''}
          </p>
        </div>
      </div>

      {/* The outcome */}
      <div className="max-w-[95%] rounded-2xl rounded-bl-md bg-zinc-900 px-3.5 py-2.5 text-xs text-zinc-300">
        {running ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
              <span>
                Working on it… try <b>{Math.max(1, attempts + 1)}</b>
                {live ? ` of ${live.cap}` : ''}
                {results.length > 0 && ` · ${results.length}/${turn.candidates} done`}
              </span>
              <button type="button" onClick={onStop} className="ml-auto text-[11px] text-zinc-500 hover:text-red-400">
                stop
              </button>
            </div>
            {waiting ? (
              <p className="text-[11px] text-amber-400">{friendlyReason(waiting.lastReason)} — retrying shortly</p>
            ) : (
              lastFailure && (
                <p className="text-[11px] text-zinc-500" title={lastFailure}>
                  Last try {friendlyReason(lastFailure)} — trying again
                  {refusals > 1 ? ` (${refusals} so far)` : ''}
                </p>
              )
            )}
          </div>
        ) : (
          <p className={statusTone(turn)} title={turn.errorMessage ?? turn.lastFailure ?? undefined}>
            {statusText(turn, results.length, refusals)}
          </p>
        )}

        {results.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {results.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => onSelectVersion(v.id)}
                title="Show this version and edit from it next"
                className={`relative overflow-hidden rounded-xl border-2 ${
                  session.selectedVersionId === v.id ? 'border-blue-500' : 'border-transparent hover:border-zinc-600'
                }`}
              >
                <img src={v.image.objectUrl} alt={versionLabel(v)} className="h-20 w-20 object-cover" />
                <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[10px] text-white">
                  v{v.number}
                </span>
              </button>
            ))}
          </div>
        )}

        {!running && turn.status !== 'complete' && (
          <button
            type="button"
            onClick={onRetry}
            disabled={!canRetry}
            className="mt-2 rounded-full border border-zinc-700 px-3 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            ↻ Try this edit again
          </button>
        )}
      </div>
    </div>
  )
}

function statusText(turn: EditTurn, got: number, refusals: number): string {
  const tries = `${turn.attempts} ${turn.attempts === 1 ? 'try' : 'tries'}`
  switch (turn.status) {
    case 'complete':
      return refusals > 0
        ? `Done in ${tries} — ${refusals} ${refusals === 1 ? 'was' : 'were'} turned down along the way.`
        : `Done on the first try.`
    case 'cap-reached':
      return `Gave up after ${tries}${got > 0 ? ` with ${got}/${turn.candidates}` : ''} — last one ${
        friendlyReason(turn.lastFailure) ?? 'failed'
      }. Try rewording the edit, or raise Max attempts.`
    case 'stopped':
      return got > 0 ? `Stopped — kept ${got} result${got === 1 ? '' : 's'}.` : 'Stopped.'
    case 'error':
      return turn.errorMessage ?? 'Something went wrong.'
    default:
      return ''
  }
}

function statusTone(turn: EditTurn): string {
  if (turn.status === 'complete') return 'text-emerald-400'
  if (turn.status === 'error') return 'text-red-400'
  if (turn.status === 'cap-reached') return 'text-amber-400'
  return 'text-zinc-400'
}

function versionLabel(v: EditVersion): string {
  return v.number === 0 ? 'Original' : `Version ${v.number}`
}

function editPrompt(session: EditSession, v: EditVersion): string {
  return session.turns.find((t) => t.id === v.turnId)?.prompt ?? ''
}
