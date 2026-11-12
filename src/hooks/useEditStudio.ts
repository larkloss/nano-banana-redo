import { useCallback, useMemo, useRef, useState } from 'react'
import type { GeneratedImage, ReferenceImage, RunStatus, Settings } from '../types'
import { useRetryRun } from './useRetryRun'
import { imageToReference } from '../lib/imageUtils'
import { getModel } from '../lib/models'
import { loadApiKeys } from '../lib/storage'
import { isMockMode } from '../lib/mockGemini'
import { MAX_XAI_SOURCES } from '../lib/xai'
import { MAX_OPENAI_SOURCES } from '../lib/openai'
import { buildEditPrompt, buildSingleSourcePrompt, renderGuide, summarizeEdit, type EditMark } from '../lib/annotate'
import type { LocalEditInfo } from '../lib/localEdit'
import { createLocalEditor, makeLocalEditCaller, type LocalEditor } from '../lib/localEditClient'
import { base64ToBlob, processImagePart } from '../lib/imageUtils'
import { blobToBase64 } from '../edit/lib/mask'
import { cropFromFrame, frameForModel, marksInFrame } from '../lib/frame'

// One picture's edit history. Version 0 is the picture the chain started
// from; every successful edit adds a version, and any version can be the
// starting point of the next edit — so a chain can branch and back up.
export interface EditVersion {
  id: string
  number: number
  image: GeneratedImage
  // The turn that produced it; null for the original
  turnId: string | null
  // Made from another version (its model's whole picture), not a new answer
  derived?: boolean
  derivedFrom?: string
  // For "only around the arrows" edits: the model's own whole-picture answer
  // (before everything away from the arrows was put back), the area that was
  // taken from it, and what the change detection found
  local?: {
    whole: { blob: Blob; objectUrl: string }
    areaUrl: string
    info: LocalEditInfo
  }
}

export type TurnStatus = Exclude<RunStatus, 'idle'>

export interface EditTurn {
  id: string
  // General instruction; may be empty when the turn has marks
  prompt: string
  // Spots marked on the picture, each with its own instruction
  marks: EditMark[]
  // The marked-up copy that was sent alongside the picture (for display)
  guideUrl: string | null
  sourceVersionId: string
  withReferences: boolean
  // Keep everything away from the arrows exactly as it was
  localOnly: boolean
  candidates: number
  modelId: string
  status: TurnStatus
  resultVersionIds: string[]
  attempts: number
  lastFailure: string | null
  errorMessage: string | null
}

export interface EditSession {
  id: string
  versions: EditVersion[]
  turns: EditTurn[]
  // The version on screen, which is also where the next edit starts
  selectedVersionId: string
}

export interface EditRequest {
  prompt: string
  marks: EditMark[]
  candidates: number
  withReferences: boolean
  // Keep everything away from the arrows exactly as it was
  localOnly: boolean
  modelId: string
}

interface Options {
  settings: Settings
  references: ReferenceImage[]
  // Every edit result also lands in the main gallery, so it can be zipped
  onResult: (image: GeneratedImage) => void
}

export function useEditStudio({ settings, references, onResult }: Options) {
  const run = useRetryRun()
  const [sessions, setSessions] = useState<Record<string, EditSession>>({})
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const [runningTurn, setRunningTurn] = useState<{ sessionId: string; turnId: string } | null>(null)
  // Next version number per chain (v0 is the original)
  const versionCounters = useRef<Record<string, number>>({})
  // Synchronous guard: two quick submits must not both get past the check
  // before React re-renders with isRunning = true
  const busyRef = useRef(false)
  // True between "Apply edit" and the engine actually starting (the source
  // picture is being read back for upload). Counts as busy everywhere, and a
  // stop pressed in that window cancels the edit before any request is sent.
  const [preparing, setPreparing] = useState(false)
  const cancelledRef = useRef(false)
  const busy = run.isRunning || preparing

  const patchSession = useCallback((sessionId: string, patch: (s: EditSession) => EditSession) => {
    setSessions((prev) => (prev[sessionId] ? { ...prev, [sessionId]: patch(prev[sessionId]) } : prev))
  }, [])

  // Opening an image that is already part of a chain resumes that chain at
  // that version; any other image starts a new chain with itself as v0.
  const open = useCallback(
    (image: GeneratedImage) => {
      const existing =
        (image.edit && sessions[image.edit.sessionId]) ||
        Object.values(sessions).find((s) => s.versions[0].image.id === image.id)
      if (existing) {
        const version = existing.versions.find((v) => v.image.id === image.id)
        if (version) patchSession(existing.id, (s) => ({ ...s, selectedVersionId: version.id }))
        setOpenSessionId(existing.id)
        return
      }
      const original: EditVersion = { id: crypto.randomUUID(), number: 0, image, turnId: null }
      const session: EditSession = {
        id: crypto.randomUUID(),
        versions: [original],
        turns: [],
        selectedVersionId: original.id,
      }
      setSessions((prev) => ({ ...prev, [session.id]: session }))
      setOpenSessionId(session.id)
    },
    [sessions, patchSession],
  )

  const close = useCallback(() => setOpenSessionId(null), [])
  const reopenRunning = useCallback(() => {
    if (runningTurn) setOpenSessionId(runningTurn.sessionId)
  }, [runningTurn])

  const selectVersion = useCallback(
    (sessionId: string, versionId: string) => patchSession(sessionId, (s) => ({ ...s, selectedVersionId: versionId })),
    [patchSession],
  )

  const runTurn = useCallback(
    async (sessionId: string, turn: EditTurn) => {
      const session = sessions[sessionId]
      const source = session?.versions.find((v) => v.id === turn.sourceVersionId)
      if (!session || !source || busyRef.current) return
      const finishTurn = (patch: Partial<EditTurn>) =>
        patchSession(sessionId, (s) => ({
          ...s,
          turns: s.turns.map((t) => (t.id === turn.id ? { ...t, ...patch } : t)),
        }))

      const model = getModel(turn.modelId)
      const storedKeys = loadApiKeys(model.provider).filter(Boolean)
      const keys = storedKeys.length > 0 ? storedKeys : isMockMode() ? ['mock'] : []
      if (keys.length === 0) {
        patchSession(sessionId, (s) => ({
          ...s,
          turns: [
            ...s.turns.filter((t) => t.id !== turn.id),
            { ...turn, status: 'error', errorMessage: missingKeyMessage(model.provider) },
          ],
        }))
        return
      }

      // The picture being edited always goes first; reference photos ride
      // along behind it when asked for, within the provider's source limit
      const maxSources =
        model.provider === 'xai'
          ? MAX_XAI_SOURCES
          : model.provider === 'openai'
            ? MAX_OPENAI_SOURCES
            : model.maxReferences
      // With marks, the guide image takes the second slot
      const guideSlots = turn.marks.length > 0 ? 1 : 0
      const extras = turn.withReferences ? references.slice(0, Math.max(0, maxSources - 1 - guideSlots)) : []

      busyRef.current = true
      cancelledRef.current = false
      setPreparing(true)
      patchSession(sessionId, (s) => ({ ...s, turns: [...s.turns.filter((t) => t.id !== turn.id), turn] }))
      setRunningTurn({ sessionId, turnId: turn.id })
      const local = turn.localOnly && turn.marks.length > 0
      let job: LocalEditor | null = null
      try {
        if (local) job = await createLocalEditor(source.image.blob, turn.marks)
        const localJob = job
        // A picture in a shape the model can't answer in (an upload) goes
        // inside a frame of a shape it can, and is cut back out of the answer
        const frame = local ? await frameForModel(source.image, turn.modelId) : null
        const sent = frame
          ? { ...source.image, blob: frame.blob, mimeType: frame.blob.type, width: frame.width, height: frame.height }
          : source.image
        const sentMarks = frame ? marksInFrame(turn.marks, frame) : turn.marks
        const prompt = buildEditPrompt(turn.prompt, sentMarks, extras.length)
        const singleSourcePrompt =
          turn.marks.length > 0 ? buildSingleSourcePrompt(turn.prompt, sentMarks) : undefined
        const runSettings: Settings = {
          ...settings,
          modelId: turn.modelId,
          // An empty override would be ignored anyway; a stale one for another
          // provider must not leak into this request
          // The typed model ID override belongs to the main settings' model;
          // picking a different model in the studio must actually switch
          xaiModelId: turn.modelId === settings.modelId ? settings.xaiModelId : '',
          prompt,
          targetCount: turn.candidates,
          // Edits keep the picture's own framing
          aspectRatio: frame ? frame.ratio : 'auto',
          ...(local ? localSettings(sent) : {}),
        }

        let firstResult = true
        let delivered = 0
        const prepareSources = async () => {
          const guide = turn.marks.length > 0 ? await renderGuide(sent.blob, sentMarks) : null
          if (guide) {
            const guideUrl = URL.createObjectURL(guide.blob)
            patchSession(sessionId, (s) => ({
              ...s,
              turns: s.turns.map((t) => (t.id === turn.id ? { ...t, guideUrl } : t)),
            }))
          }
          const sources = [
            await imageToReference(sent),
            ...(guide ? [{ base64: guide.base64, mimeType: guide.mimeType }] : []),
            ...extras.map(({ base64, mimeType }) => ({ base64, mimeType })),
          ]
          if (cancelledRef.current) throw new StoppedBeforeStart()
          setPreparing(false)
          return sources
        }
        const finished = await run.start(
          keys,
          runSettings,
          await prepareSources(),
          (image, part) => {
            const extra = localJob?.extras.get(part.base64)
            const wholeBlob = extra ? base64ToBlob(extra.raw.base64, extra.raw.mimeType) : null
            // Numbered outside the state updater so StrictMode's double call
            // can't skip a number or add the picture to the gallery twice
            const number = versionCounters.current[sessionId] ?? 1
            versionCounters.current[sessionId] = number + 1
            const tagged: GeneratedImage = {
              ...image,
              edit: { sessionId, version: number, prompt: summarizeEdit(turn.prompt, turn.marks) },
            }
            const version: EditVersion = {
              id: crypto.randomUUID(),
              number,
              image: tagged,
              turnId: turn.id,
              ...(extra && wholeBlob
                ? {
                    local: {
                      whole: { blob: wholeBlob, objectUrl: URL.createObjectURL(wholeBlob) },
                      areaUrl: URL.createObjectURL(extra.mask),
                      info: extra.info,
                    },
                  }
                : {}),
            }
            // The first result becomes the new base so the next edit chains on it
            delivered += 1
            const select = firstResult
            firstResult = false
            onResult(tagged)
            patchSession(sessionId, (s) => ({
              ...s,
              versions: [...s.versions, version],
              turns: s.turns.map((t) =>
                t.id === turn.id ? { ...t, resultVersionIds: [...t.resultVersionIds, version.id] } : t,
              ),
              selectedVersionId: select ? version.id : s.selectedVersionId,
            }))
          },
          {
            singleSourcePrompt,
            wrapCaller: localJob
              ? (caller) =>
                  makeLocalEditCaller(caller, localJob, frame ? (answer) => cropFromFrame(answer, frame) : undefined)
              : undefined,
          },
        )

        if (!finished) {
          finishTurn({ status: 'error', errorMessage: 'Another edit was already running.' })
          return
        }
        if (localJob?.problem && delivered === 0) {
          finishTurn({
            status: 'error',
            attempts: finished.attempts,
            lastFailure: finished.lastFailure,
            errorMessage:
              `${getModel(turn.modelId).label} answered with a picture of a different shape, so it can’t be ` +
              'pasted back around the arrows. Turn off “only around arrows”, or pick another model.',
          })
          return
        }
        finishTurn({
          status: finished.result,
          attempts: finished.attempts,
          lastFailure: finished.lastFailure,
          errorMessage: finished.errorMessage ?? null,
          // An answer that could not be decoded still counts as collected in
          // the engine; with nothing to show, report it rather than "done"
          ...(finished.result === 'complete' && delivered === 0
            ? { status: 'error' as const, errorMessage: 'The model answered, but the picture could not be decoded.' }
            : {}),
        })
      } catch (err) {
        if (err instanceof StoppedBeforeStart) finishTurn({ status: 'stopped' })
        // e.g. the source picture could not be read back for upload
        else finishTurn({ status: 'error', errorMessage: err instanceof Error ? err.message : String(err) })
      } finally {
        if (job) job.release()
        busyRef.current = false
        setPreparing(false)
        setRunningTurn(null)
      }
    },
    [sessions, references, settings, run, patchSession, onResult],
  )

  const submit = useCallback(
    (sessionId: string, request: EditRequest) => {
      const session = sessions[sessionId]
      const marks = request.marks.map((m) => ({ ...m, text: m.text.trim() }))
      if (!session || busy || marks.some((m) => !m.text)) return
      if (!request.prompt.trim() && marks.length === 0) return
      void runTurn(sessionId, {
        id: crypto.randomUUID(),
        prompt: request.prompt.trim(),
        marks,
        guideUrl: null,
        sourceVersionId: session.selectedVersionId,
        withReferences: request.withReferences,
        localOnly: request.localOnly,
        candidates: request.candidates,
        modelId: request.modelId,
        status: 'running',
        resultVersionIds: [],
        attempts: 0,
        lastFailure: null,
        errorMessage: null,
      })
    },
    [sessions, busy, runTurn],
  )

  // Runs a finished turn again from the same source — same prompt, fresh
  // attempt budget. Earlier results of that turn are kept.
  const retry = useCallback(
    (sessionId: string, turnId: string) => {
      const turn = sessions[sessionId]?.turns.find((t) => t.id === turnId)
      if (!turn || busy) return
      void runTurn(sessionId, {
        ...turn,
        id: crypto.randomUUID(),
        guideUrl: null,
        status: 'running',
        resultVersionIds: [],
        attempts: 0,
        lastFailure: null,
        errorMessage: null,
      })
    },
    [sessions, busy, runTurn],
  )

  // Swaps an "only around the arrows" result for the model's own whole
  // picture: added as a new version (the composited one stays available).
  // Once per version — a double click must not add it twice.
  const wholeTaken = useRef(new Set<string>())
  const takeWholePicture = useCallback(
    async (sessionId: string, versionId: string) => {
      const source = sessions[sessionId]?.versions.find((v) => v.id === versionId)
      if (!source?.local || wholeTaken.current.has(versionId)) return
      wholeTaken.current.add(versionId)
      const blob = source.local.whole.blob
      let image: GeneratedImage
      try {
        image = await processImagePart(
          { base64: await blobToBase64(blob), mimeType: blob.type || 'image/png' },
          settings.format,
          { attempt: source.image.attempt, modelId: source.image.modelId },
        )
      } catch {
        wholeTaken.current.delete(versionId)
        return
      }
      const number = versionCounters.current[sessionId] ?? 1
      versionCounters.current[sessionId] = number + 1
      const prompt = source.image.edit?.prompt ?? ''
      const tagged: GeneratedImage = {
        ...image,
        edit: { sessionId, version: number, prompt: `${prompt} (whole picture)` },
      }
      const version: EditVersion = {
        id: crypto.randomUUID(),
        number,
        image: tagged,
        turnId: source.turnId,
        derived: true,
        derivedFrom: source.id,
      }
      onResult(tagged)
      patchSession(sessionId, (s) => ({
        ...s,
        versions: [...s.versions, version],
        turns: s.turns.map((t) =>
          t.id === source.turnId ? { ...t, resultVersionIds: [...t.resultVersionIds, version.id] } : t,
        ),
        selectedVersionId: version.id,
      }))
    },
    [sessions, settings.format, onResult, patchSession],
  )

  // A stop during preparation is honoured once the upload data is ready,
  // before anything is sent; afterwards it aborts the engine as usual
  const stop = useCallback(() => {
    cancelledRef.current = true
    run.stop()
  }, [run])

  const openSession = openSessionId ? (sessions[openSessionId] ?? null) : null

  return useMemo(
    () => ({
      openSession,
      open,
      close,
      reopenRunning,
      selectVersion,
      submit,
      retry,
      takeWholePicture,
      stop,
      // While preparing, the engine's state still belongs to the last run
      runState: preparing ? null : run.runState,
      isRunning: busy,
      runningTurn,
    }),
    [
      openSession,
      open,
      close,
      reopenRunning,
      selectVersion,
      submit,
      retry,
      takeWholePicture,
      stop,
      preparing,
      run.runState,
      busy,
      runningTurn,
    ],
  )
}

function missingKeyMessage(provider: string): string {
  const name = provider === 'xai' ? 'xAI' : provider === 'openai' ? 'OpenAI' : 'Google AI Studio'
  return `No ${name} API key saved yet — add one in the settings panel, then try again.`
}

class StoppedBeforeStart extends Error {
  constructor() {
    super('Stopped before the edit was sent')
  }
}

// "Only around the arrows" pastes part of the answer back into the picture,
// so the answer has to come in the picture's own shape and about its own
// resolution (or the pasted area looks softer than the rest) — asked for in
// each provider's terms. The composite is always a lossless PNG: a JPEG
// would re-encode every pixel the edit was meant to leave alone.
function localSettings(image: GeneratedImage): Partial<Settings> {
  const long = Math.max(image.width, image.height)
  return {
    imageSize: long > 2600 ? '4K' : long > 1400 ? '2K' : '1K',
    xaiResolution: long > 1400 ? '2k' : '1k',
    matchSize: { width: image.width, height: image.height },
    format: 'png',
  }
}
