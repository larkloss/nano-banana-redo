import { useEffect, useRef, useState } from 'react'
import type { RunState, Settings } from '../../types'
import { studioReferenceSlots } from '../../hooks/useEditStudio'
import type { EditRequest, EditSession, EditTurn, EditVersion } from '../../hooks/useEditStudio'
import { MODELS, PROVIDER_LABELS, PROVIDER_ORDER, getModel } from '../../lib/models'
import { downloadImage, saveFormat, sourceLabel } from '../../lib/imageUtils'
import { friendlyReason } from '../../lib/friendly'
import { MAX_MARKS, markColor, summarizeEdit, type EditMark } from '../../lib/annotate'
import { mentionedNumbers } from '../../lib/mentions'
import type { Touch } from '../../lib/localEdit'
import { DEFAULT_LOCATOR_MODEL, LOCATOR_MODELS } from '../../lib/locate'
import { loadApiKeys, loadStudioPrefs, saveStudioPrefs } from '../../lib/storage'
import { isMockMode } from '../../lib/mockGemini'
import { MarkedImage, type FoundBox } from './MarkedImage'
import { MarkList } from './MarkList'

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
  // Replace an "only around the arrows" result with the model's whole picture
  onUseWhole: (versionId: string) => void
  // Cut the same answer out again with spots the user picked (no request);
  // resolves to what went wrong, if anything
  onRecut: (versionId: string, touches: Touch[]) => Promise<string | null>
  isRecutting: boolean
  onStop: () => void
  onClose: () => void
}

const IMAGE_MODELS = MODELS.filter((m) => m.output === 'image')
// Touch-up spot sizes, as a share of the picture's shorter side
const TOUCH_SIZES = [
  { label: 'S', r: 0.035 },
  { label: 'M', r: 0.07 },
  { label: 'L', r: 0.12 },
]
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
  onUseWhole,
  onRecut,
  isRecutting,
  onStop,
  onClose,
}: Props) {
  const [prompt, setPrompt] = useState('')
  const [candidates, setCandidates] = useState(1)
  const [withReferences, setWithReferences] = useState(false)
  const [modelId, setModelId] = useState(() =>
    getModel(settings.modelId).output === 'image' ? settings.modelId : IMAGE_MODELS[0].id,
  )
  // Held-down views of the stage: the version it came from, the model's own
  // whole picture, or the area that was replaced
  const [peek, setPeek] = useState<null | 'before' | 'whole' | 'area'>(null)
  const comparing = peek !== null
  // Edits with arrows keep everything away from them pixel-identical
  const [localOnly, setLocalOnly] = useState(true)
  // Arrows pointed at the picture, each with its own instruction. Positions
  // are relative, so they survive switching between versions of the picture.
  const [marks, setMarks] = useState<EditMark[]>([])
  const [activeMark, setActiveMark] = useState<string | null>(null)
  // "Find the object": ask a Gemini model where the things the arrows point
  // at are, so that all of each is taken (a standing choice, off to begin with)
  const [prefs, setPrefs] = useState(loadStudioPrefs)
  const updatePrefs = (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    saveStudioPrefs(next)
  }
  const hasGoogleKey = loadApiKeys('gemini').some(Boolean) || isMockMode()
  // Touching up the version on screen: spots picked since "Touch up" was pressed
  // (it belongs to that version: showing another one ends it)
  const [touchUp, setTouching] = useState<{
    versionId: string
    take: boolean
    size: number
    picked: Touch[]
  } | null>(null)
  const [touchNote, setTouchNote] = useState<string | null>(null)
  const threadEnd = useRef<HTMLDivElement>(null)
  const pressedBackdrop = useRef(false)

  const selected = session.versions.find((v) => v.id === session.selectedVersionId) ?? session.versions[0]
  const selectedTurn = session.turns.find((t) => t.id === selected.turnId)
  const previous = selectedTurn ? session.versions.find((v) => v.id === selectedTurn.sourceVersionId) : null
  const shown = peek === 'before' && previous ? previous : selected
  const shownUrl = peek === 'whole' && selected.local ? selected.local.whole.objectUrl : shown.image.objectUrl
  const hold = (view: 'before' | 'whole' | 'area') => ({
    onPointerDown: () => setPeek(view),
    onPointerUp: () => setPeek(null),
    onPointerLeave: () => setPeek(null),
  })
  // "@2" in an instruction points at reference photo 2 — which only travels
  // with the edit when "+ reference photos" is ticked
  const mentioned = mentionedNumbers([prompt, ...marks.map((m) => m.text)].join('\n'))
  const sendingReferences = withReferences && referenceCount > 0
  // (not all of them fit beside the picture and the arrow guide on every model)
  const referencesSent = Math.min(referenceCount, studioReferenceSlots(modelId, marks.length > 0))
  const unsentMentions = mentioned.filter((n) => !sendingReferences || n > referencesSent)
  // One answer's whole picture is added once, whichever cut of it is on screen
  const wholeAlreadyTaken = session.versions.some((v) => {
    if (!v.derived || v.recut || !v.derivedFrom) return false
    if (v.derivedFrom === selected.id) return true
    const from = session.versions.find((o) => o.id === v.derivedFrom)
    return Boolean(from?.local && selected.local && from.local.whole.blob === selected.local.whole.blob)
  })
  // Touching up belongs to the version it was started on: showing another
  // one ends it (it doesn't come back, spots and all, later)
  const [shownId, setShownId] = useState(selected.id)
  if (shownId !== selected.id) {
    setShownId(selected.id)
    setTouching(null)
    setTouchNote(null)
  }
  const touching = touchUp && touchUp.versionId === selected.id && selected.local ? touchUp : null
  // What "find the object" saw for the edit that made this version
  const found = selectedTurn?.found
  // (only the areas this version's cut actually went by)
  const used = selected.local?.info.extentsUsed
  const foundBoxes: FoundBox[] = found
    ? [
        ...found.boxes.flatMap((area, i): FoundBox[] =>
          area && used?.[i] ? [{ area, kind: 'object', label: found.labels[i] ?? `arrow ${i + 1}` }] : [],
        ),
        ...found.faces.map((area): FoundBox => ({ area, kind: 'face' })),
      ]
    : []
  const touchable = Boolean(selected.local) && !isRunning
  const applyTouches = async () => {
    if (!touching || touching.picked.length === 0) return
    const problem = await onRecut(selected.id, touching.picked)
    setTouchNote(problem)
    if (!problem) setTouching(null)
  }
  const busyHere = isRunning && runningTurn?.sessionId === session.id
  const busyElsewhere = isRunning && !busyHere && !isRecutting
  const marksReady = marks.every((m) => m.text.trim().length > 0)
  const canSend = !isRunning && marksReady && (prompt.trim().length > 0 || marks.length > 0)

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [session.turns.length, session.versions.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      // Esc while typing (an arrow's instruction, the prompt) must not close
      // the studio and throw away what's been marked and written
      const t = e.target
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) return
      // … and in touch-up mode it leaves that mode, not the studio
      if (touchUp) {
        if (!isRecutting) setTouching(null)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, touchUp, isRecutting])

  const send = () => {
    if (!canSend) return
    onSubmit({
      prompt,
      marks,
      candidates,
      withReferences: withReferences && referenceCount > 0,
      modelId,
      localOnly: localOnly && marks.length > 0,
      findObject: prefs.findObject && hasGoogleKey,
      locatorModel: prefs.locatorModel || DEFAULT_LOCATOR_MODEL,
    })
    setTouching(null)
    setPrompt('')
    setMarks([])
    setActiveMark(null)
  }

  const addMark = (x: number, y: number) => {
    if (marks.length >= MAX_MARKS) return
    const mark: EditMark = { id: crypto.randomUUID(), x, y, text: '' }
    setMarks((prev) => [...prev, mark])
    setActiveMark(mark.id)
  }
  const updateMark = (id: string, patch: Partial<EditMark>) =>
    setMarks((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
  const removeMark = (id: string) => {
    setMarks((prev) => prev.filter((m) => m.id !== id))
    setActiveMark((current) => (current === id ? null : current))
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/50 p-3 backdrop-blur-sm md:p-6"
      // Closes only for a click that started on the backdrop — not a press on
      // the picture that happened to be released outside the dialog
      onPointerDownCapture={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        // (not while spots are picked: a stray click must not throw them away)
        if (pressedBackdrop.current && e.target === e.currentTarget && !touching?.picked.length) onClose()
      }}
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
              <MarkedImage
                src={shownUrl}
                alt={versionLabel(shown)}
                marks={touching ? [] : marks}
                activeId={activeMark}
                interactive={!comparing}
                overlayUrl={peek === 'area' || (touching && !comparing) ? selected.local?.areaUrl : null}
                boxes={peek === 'area' || (touching && !comparing) ? foundBoxes : undefined}
                touchUp={
                  touching && selected.local && !comparing
                    ? {
                        applied: selected.local.options.touches ?? [],
                        pending: touching.picked,
                        size: touching.size,
                        take: touching.take,
                        onAdd: (x, y) => {
                          // (not while the last ones are being applied)
                          if (isRecutting) return
                          setTouching((t) =>
                            t ? { ...t, picked: [...t.picked, { x, y, r: t.size, take: t.take }] } : t,
                          )
                        },
                      }
                    : null
                }
                onAdd={addMark}
                onMove={(id, x, y) => updateMark(id, { x, y })}
                onActivate={setActiveMark}
              />
              {!comparing && (
                <span className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[11px] text-white">
                  {touching
                    ? touching.take
                      ? 'Pink = taken from the model · click where part of the edit was left behind'
                      : 'Pink = taken from the model · click what should go back to your original'
                    : marks.length === 0
                    ? '👆 Click the picture to point at what to change'
                    : marks.length >= MAX_MARKS
                      ? `That's ${MAX_MARKS} arrows — the most one edit takes`
                      : 'Click again for another spot · drag an arrow to adjust it'}
                </span>
              )}
              <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white">
                {peek === 'before' && previous
                  ? `Before · ${versionLabel(previous)}`
                  : peek === 'whole'
                    ? 'The model’s whole picture'
                    : peek === 'area'
                      ? 'Replaced area'
                      : touching
                        ? `Touching up ${versionLabel(selected)}`
                        : versionLabel(selected)}
              </span>
              {busyHere && (
                <span className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" /> editing…
                </span>
              )}
            </div>
            {touching && selected.local && (
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-[11px] text-zinc-300">
                <div className="flex items-center gap-1 rounded-full bg-zinc-950 p-0.5">
                  <button
                    type="button"
                    onClick={() => setTouching({ ...touching, take: true })}
                    title="Click a spot where part of the edit was left behind: everything the model drew there is taken"
                    className={`rounded-full px-2.5 py-1 ${touching.take ? 'bg-emerald-600 font-semibold text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    + Take from the model
                  </button>
                  <button
                    type="button"
                    onClick={() => setTouching({ ...touching, take: false })}
                    title="Click a spot the edit should not have touched: your original is put back there"
                    className={`rounded-full px-2.5 py-1 ${!touching.take ? 'bg-amber-600 font-semibold text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    − Put the original back
                  </button>
                </div>
                <div className="flex items-center gap-1 rounded-full bg-zinc-950 p-0.5" title="Size of each spot">
                  {TOUCH_SIZES.map((size) => (
                    <button
                      key={size.label}
                      type="button"
                      onClick={() => setTouching({ ...touching, size: size.r })}
                      className={`h-6 min-w-6 rounded-full px-1.5 ${
                        touching.size === size.r ? 'bg-blue-600 font-semibold text-white' : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {size.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setTouching({ ...touching, picked: touching.picked.slice(0, -1) })}
                  disabled={touching.picked.length === 0 || isRecutting}
                  className="rounded-full border border-zinc-700 px-2.5 py-1 hover:bg-zinc-800 disabled:opacity-40"
                >
                  Undo
                </button>
                <span className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setTouching(null)
                      setTouchNote(null)
                    }}
                    disabled={isRecutting}
                    className="rounded-full px-2.5 py-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void applyTouches()}
                    disabled={touching.picked.length === 0 || isRunning}
                    title={
                      isRunning && !isRecutting
                        ? 'Wait for the edit that is running to finish'
                        : 'Cuts the same answer out again — no new request, nothing is spent'
                    }
                    className="rounded-full bg-blue-600 px-3 py-1 font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isRecutting ? 'Working…' : `Apply ${touching.picked.length || ''} — no new request`}
                  </button>
                </span>
                {touchNote && <p className="w-full text-amber-400">{touchNote}</p>}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {previous && (
                <button
                  type="button"
                  {...hold('before')}
                  className="select-none rounded-xl border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  title="Hold to see the picture this version was edited from"
                >
                  Hold to compare
                </button>
              )}
              {selected.local && (
                <>
                  <button
                    type="button"
                    {...hold('area')}
                    className="select-none rounded-xl border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                    title="Hold to highlight the area taken from the model — everything else is your original, pixel for pixel"
                  >
                    Hold: what changed
                  </button>
                  <button
                    type="button"
                    {...hold('whole')}
                    className="select-none rounded-xl border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                    title="Hold to see the model’s own answer, before everything away from the arrows was put back"
                  >
                    Hold: whole picture
                  </button>
                  <button
                    type="button"
                    onClick={() => onUseWhole(selected.id)}
                    disabled={wholeAlreadyTaken}
                    className="rounded-xl border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
                    title={
                      wholeAlreadyTaken
                        ? 'Already added as its own version'
                        : 'Add the model’s whole picture as a new version instead'
                    }
                  >
                    Use whole picture
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTouchNote(null)
                      setTouching(touching ? null : { versionId: selected.id, take: true, size: TOUCH_SIZES[1].r, picked: [] })
                    }}
                    disabled={!touchable}
                    className={`rounded-xl border px-3 py-1.5 text-xs disabled:cursor-default disabled:opacity-40 ${
                      touching
                        ? 'border-blue-500 bg-blue-500/15 text-blue-500'
                        : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                    }`}
                    title="Part of the edit left behind, or something changed that shouldn’t have? Click those spots — the same answer is cut out again, without a new request"
                  >
                    ✚ Touch up
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => void downloadImage(selected.image, 0)}
                title={`Download ${saveFormat(selected.image)}`}
                className="rounded-xl border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                ↓ Download {versionLabel(selected)}
              </button>
              <span className="ml-auto text-[11px] text-zinc-500">
                {selected.image.width}×{selected.image.height} · {sourceLabel(selected.image)}
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
                    <li>
                      Say what to change, or click the picture to point arrows at exact spots and give each its own
                      instruction (“1: remove this”, “2: change the pose”).
                    </li>
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
                {marks.length > 0 && (
                  <MarkList
                    marks={marks}
                    activeId={activeMark}
                    onActivate={setActiveMark}
                    onChange={(id, text) => updateMark(id, { text })}
                    onRemove={removeMark}
                    onSubmit={send}
                  />
                )}
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      send()
                    }
                  }}
                  rows={marks.length > 0 ? 2 : 3}
                  placeholder={
                    marks.length === 0
                      ? 'What should change? Or click the picture to point at a spot. e.g. “Make her hair a little longer”'
                      : localOnly
                        ? 'Anything else about these spots? (optional)'
                        : 'Anything else, for the whole picture? (optional)'
                  }
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
                  {marks.length > 0 && (
                    <label
                      className="flex items-center gap-1.5 text-[11px] text-zinc-400"
                      title={
                        'On: only what changed around the arrows is kept — faces, skin and everything else stay ' +
                        'your original, pixel for pixel. Off: the model’s whole picture is used.'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={localOnly}
                        onChange={(e) => setLocalOnly(e.target.checked)}
                        className="accent-blue-500"
                      />
                      only around arrows
                    </label>
                  )}
                  {marks.length > 0 && localOnly && (
                    <label
                      className={`flex items-center gap-1.5 text-[11px] ${hasGoogleKey ? 'text-zinc-400' : 'text-zinc-600'}`}
                      title={
                        hasGoogleKey
                          ? 'First asks a Gemini model where the thing each arrow points at is — all of it — and where the ' +
                            'faces are. Then the whole thing is taken even where it barely differs from what is behind ' +
                            'it, and faces are left alone. One extra request per edit, with your Google key.'
                          : 'Needs a Google AI Studio key (settings panel on the main page)'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={prefs.findObject && hasGoogleKey}
                        disabled={!hasGoogleKey}
                        onChange={(e) => updatePrefs({ findObject: e.target.checked })}
                        className="accent-blue-500"
                      />
                      find the object
                    </label>
                  )}
                  {marks.length > 0 && localOnly && prefs.findObject && hasGoogleKey && (
                    <>
                      <input
                        type="text"
                        list="studio-locator-models"
                        value={prefs.locatorModel}
                        onChange={(e) => updatePrefs({ locatorModel: e.target.value.trim() })}
                        placeholder={DEFAULT_LOCATOR_MODEL}
                        spellCheck={false}
                        aria-label="Gemini model that finds the object"
                        title={`The Gemini model that looks at the picture — any one that understands images (${LOCATOR_MODELS.join(', ')}, …). Empty: ${DEFAULT_LOCATOR_MODEL}.`}
                        className="w-36 rounded-full border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-[11px] text-zinc-300 placeholder-zinc-600 outline-none focus:border-blue-500"
                      />
                      <datalist id="studio-locator-models">
                        {LOCATOR_MODELS.map((id) => (
                          <option key={id} value={id} />
                        ))}
                      </datalist>
                    </>
                  )}
                  <label
                    className={`flex items-center gap-1.5 text-[11px] ${referenceCount > 0 ? 'text-zinc-400' : 'text-zinc-600'}`}
                    title={
                      referenceCount > 0
                        ? 'Also send your reference photos so the face stays consistent — point at one with @1, @2, … in an instruction'
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
                    + reference photos
                    {referenceCount === 0
                      ? ''
                      : referencesSent < referenceCount
                        ? ` (${referencesSent} of ${referenceCount})`
                        : ` (${referenceCount})`}
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
              {marks.length > 0 && localOnly && prompt.trim().length > 0 && (
                <p className="mt-1.5 text-[11px] text-amber-400">
                  Only changes around the arrows are kept — turn off “only around arrows” to apply this to the whole
                  picture.
                </p>
              )}
              {unsentMentions.length > 0 && (
                <p className="mt-1.5 text-[11px] text-amber-400">
                  {unsentMentions.map((n) => `@${n}`).join(', ')}{' '}
                  {referenceCount === 0
                    ? 'points at a reference photo, but none are added on the main page.'
                    : !sendingReferences
                      ? 'points at a reference photo — tick “+ reference photos” to send them along.'
                      : referencesSent < referenceCount
                        ? `won’t be sent — ${getModel(modelId).label} takes only ${
                            referencesSent === 0 ? 'no reference photos' : `the first ${referencesSent}`
                          } alongside the picture${marks.length > 0 ? ' and its arrows' : ''}.`
                        : `points at no photo — there ${referenceCount === 1 ? 'is only 1' : `are only ${referenceCount}`}.`}
                </p>
              )}
              <p className="mt-1.5 text-[10px] text-zinc-600">
                {marks.length > 0 && !marksReady
                  ? 'Say what to do at each numbered arrow, then send'
                  : `Enter to send · Shift+Enter for a new line · up to ${settings.attemptsCap} tries per edit (Max attempts)`}
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
  // Versions derived afterwards ("use whole picture") aren't answers
  const answers = results.filter((v) => !v.derived).length
  const refusals = Math.max(0, attempts - answers)
  const lastFailure = live ? live.lastFailure : turn.lastFailure
  const waiting = live?.lanes.find((l) => l.status === 'backoff')

  return (
    <div className="space-y-2">
      {/* The instruction, as a chat bubble */}
      <div className="flex justify-end">
        <div className="max-w-[90%] rounded-2xl rounded-br-md bg-blue-600 px-3.5 py-2 text-sm text-white">
          {turn.guideUrl && (
            <img
              src={turn.guideUrl}
              alt="Where each change goes"
              className="mb-2 max-h-40 rounded-xl border border-white/20"
            />
          )}
          {turn.marks.length > 0 && (
            <ol className="mb-1 space-y-0.5">
              {turn.marks.map((mark, i) => (
                <li key={mark.id} className="flex gap-1.5">
                  <span
                    className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ring-1 ring-white/70"
                    style={{ backgroundColor: markColor(i).css }}
                  >
                    {i + 1}
                  </span>
                  <span>{mark.text}</span>
                </li>
              ))}
            </ol>
          )}
          {turn.prompt && <p className="whitespace-pre-wrap">{turn.prompt}</p>}
          <p className="mt-1 text-[10px] text-white/70">
            on {source ? versionLabel(source) : 'a removed version'} · {getModel(turn.modelId).label}
            {turn.candidates > 1 ? ` · ${turn.candidates} results` : ''}
            {turn.withReferences ? ' · with references' : ''}
            {turn.localOnly && turn.marks.length > 0 ? ' · only around arrows' : ''}
            {turn.findObject ? ' · find the object' : ''}
          </p>
        </div>
      </div>

      {/* The outcome */}
      <div className="max-w-[95%] rounded-2xl rounded-bl-md bg-zinc-900 px-3.5 py-2.5 text-xs text-zinc-300">
        {running ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
              {turn.findObject && !turn.found ? (
                // (the edit itself has not been asked for yet)
                <span>Finding the object first — asking Gemini where it is…</span>
              ) : (
                <span>
                  Working on it… try <b>{Math.max(1, attempts + 1)}</b>
                  {live ? ` of ${live.cap}` : ''}
                  {answers > 0 && ` · ${answers}/${turn.candidates} done`}
                </span>
              )}
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
            {statusText(turn, answers, refusals)}
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
        {turn.found && (
          <p className="mt-1.5 text-[11px] text-zinc-500" title={turn.found.problem ?? undefined}>
            {foundNote(turn, results)}
          </p>
        )}
        {localNotes(turn, results).map((note) => (
          <p key={note} className="mt-1.5 text-[11px] text-zinc-500">
            {note}
          </p>
        ))}

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
      if (refusals === 0) return 'Done on the first try.'
      // In a local edit, an answer can also be set aside because it changed
      // nothing at the arrows — not only because it was refused
      return turn.localOnly && turn.marks.length > 0
        ? `Done in ${tries} — ${refusals} earlier ${refusals === 1 ? 'answer wasn’t' : 'answers weren’t'} usable.`
        : `Done in ${tries} — ${refusals} ${refusals === 1 ? 'was' : 'were'} turned down along the way.`
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

// What an "only around the arrows" edit kept, in plain words
function localNotes(turn: EditTurn, results: EditVersion[]): string[] {
  const local = results.filter((v) => v.local)
  if (local.length === 0) return []
  const notes: string[] = []
  // Arrows no result changed (one result missing an arrow another one got
  // isn't worth a warning)
  const missed = turn.marks
    .map((_, i) => i)
    .filter((i) => local.every((v) => v.local!.info.arrowsChanged[i] === false))
    .map((i) => i + 1)
  if (missed.length > 0) {
    const one = missed.length === 1
    notes.push(
      `Nothing changed at ${one ? 'arrow' : 'arrows'} ${listing(missed)} — try again, or reword ${
        one ? 'that instruction' : 'those instructions'
      }.`,
    )
  }
  if (local.some((v) => v.local!.info.widespread)) {
    notes.push(
      'The model also changed things away from the arrows — only the part around them was kept. Hold “whole picture” to see everything it did, or use it instead.',
    )
  } else if (turn.prompt) {
    notes.push(
      'Your extra instruction was only kept where it touched the arrows — hold “whole picture” to compare, or use the whole picture.',
    )
  }
  if (local.some((v) => v.local!.info.reachedLimit)) {
    notes.push('The change may go further than what was kept — hold “what changed” to check, or use the whole picture.')
  }
  if (notes.length === 0) {
    notes.push('Only what changed around the arrows was kept — everything else is your original, pixel for pixel.')
  }
  return notes
}

// What "find the object" came back with, and what was made of it, in plain words
function foundNote(turn: EditTurn, results: EditVersion[]): string {
  const found = turn.found!
  if (found.problem) return `“Find the object” didn’t get an answer (${found.problem}) — carried on without it.`
  // An area is "used" if any result's cut went by it
  const local = results.filter((v) => v.local)
  const usedBy = (i: number) => local.some((v) => v.local!.info.extentsUsed?.[i])
  const settled = local.length > 0
  const named: string[] = []
  const unused: number[] = []
  const missing: number[] = []
  found.boxes.forEach((box, i) => {
    if (!box) missing.push(i + 1)
    else if (!settled || usedBy(i)) named.push(`${found.labels[i] ?? 'the thing'} (${i + 1})`)
    else unused.push(i + 1)
  })
  const parts: string[] = []
  if (named.length > 0) parts.push(`Found: ${named.join(', ')}`)
  if (unused.length > 0)
    parts.push(
      `the area found at ${unused.length === 1 ? 'arrow' : 'arrows'} ${listing(unused)} wasn’t gone by (it didn’t fit the arrow, or what it held stayed as it was)`,
    )
  if (missing.length > 0) parts.push(`nothing found at ${missing.length === 1 ? 'arrow' : 'arrows'} ${listing(missing)}`)
  if (found.faces.length > 0) {
    // An arrow pointing into a face's area still edits what it points at there
    const into = turn.marks.some((m) =>
      found.faces.some((f) => m.x >= f.x0 && m.x <= f.x1 && m.y >= f.y0 && m.y <= f.y1),
    )
    parts.push(
      `${found.faces.length} ${found.faces.length === 1 ? 'face' : 'faces'} guarded` +
        (into ? ' (an arrow points into one: only what it points at changes there)' : ''),
    )
  } else if (named.length > 0) {
    // (with none reported, nothing guards a face that lies in a found area)
    parts.push('no face reported — if there is one near the thing, check it')
  }
  const text = parts.join(' · ')
  const sentence = text.charAt(0).toUpperCase() + text.slice(1)
  return named.length > 0 || found.faces.length > 0 ? `${sentence}. Hold “what changed” to see where.` : `${sentence}.`
}

// 1 · 1 and 2 · 1, 2 and 3
function listing(items: number[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function versionLabel(v: EditVersion): string {
  return v.number === 0 ? 'Original' : `Version ${v.number}`
}

function editPrompt(session: EditSession, v: EditVersion): string {
  const turn = session.turns.find((t) => t.id === v.turnId)
  return turn ? summarizeEdit(turn.prompt, turn.marks) : ''
}
