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
import type { Area, LocalEditInfo, LocalEditOptions, Touch } from '../lib/localEdit'
import { locateObjects } from '../lib/locate'
import { createLocalEditor, makeLocalEditCaller, type Framing, type LocalEditor } from '../lib/localEditClient'
import { base64ToBlob, processImagePart } from '../lib/imageUtils'
import { blobToBase64 } from '../edit/lib/mask'
import { cropFromFrame, frameForModel, frameTo, learnShape, marksInFrame, type Frame } from '../lib/frame'

// One picture's edit history. Version 0 is the picture the chain started
// from; every successful edit adds a version, and any version can be the
// starting point of the next edit — so a chain can branch and back up.
export interface EditVersion {
  id: string
  number: number
  image: GeneratedImage
  // The turn that produced it; null for the original
  turnId: string | null
  // Made from another version (its model's whole picture, or the same answer
  // cut out again with the user's touch-ups), not a new answer
  derived?: boolean
  derivedFrom?: string
  recut?: boolean
  // For "only around the arrows" edits: the model's own whole-picture answer
  // (before everything away from the arrows was put back), the area that was
  // taken from it, what the change detection found, and what it was given to
  // go by (found objects, touch-ups) — enough to cut it out again
  local?: {
    whole: { blob: Blob; objectUrl: string }
    areaUrl: string
    info: LocalEditInfo
    options: LocalEditOptions
  }
}

// What "find the object" came back with for a turn
export interface FoundObjects {
  // Per arrow: what the thing was called and where it is (null: not found)
  labels: (string | null)[]
  boxes: (Area | null)[]
  faces: Area[]
  // Why nothing was found, when the question itself failed
  problem: string | null
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
  // … after asking a Gemini model where the things the arrows point at are
  findObject: boolean
  locatorModel: string
  found?: FoundObjects
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
  findObject: boolean
  locatorModel: string
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
  // The "find the object" question of the edit being prepared (Stop ends it)
  const locating = useRef<AbortController | null>(null)
  // A result being cut out again with touch-ups (no request involved)
  const [recutting, setRecutting] = useState(false)
  const busy = run.isRunning || preparing || recutting

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
      const extras = turn.withReferences
        ? references.slice(0, studioReferenceSlots(turn.modelId, turn.marks.length > 0))
        : []

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
        if (localJob && turn.findObject) {
          const abort = new AbortController()
          locating.current = abort
          const found = await findObjects(source.image.blob, turn, abort.signal)
          locating.current = null
          if (cancelledRef.current) throw new StoppedBeforeStart()
          localJob.options = {
            extents: found.extents,
            guarded: found.faces,
          }
          finishTurn({
            found: {
              labels: found.labels,
              boxes: found.extents.map((e) => e?.box ?? null),
              faces: found.faces,
              problem: found.problem,
            },
          })
        }
        // What is sent. A picture in a shape the model can't answer in (most
        // uploads) goes inside a frame of a shape it can, with the arrows
        // moved to match, and is cut back out of the answer.
        const requestFor = async (frame: Frame | null) => {
          const sent = frame
            ? { ...source.image, blob: frame.blob, mimeType: frame.blob.type, width: frame.width, height: frame.height }
            : source.image
          const sentMarks = frame ? marksInFrame(turn.marks, frame) : turn.marks
          const guide = turn.marks.length > 0 ? await renderGuide(sent.blob, sentMarks) : null
          const requestSettings: Settings = {
            ...settings,
            modelId: turn.modelId,
            // The typed model ID override belongs to the main settings' model;
            // picking a different model in the studio must actually switch
            xaiModelId: turn.modelId === settings.modelId ? settings.xaiModelId : '',
            prompt: buildEditPrompt(turn.prompt, sentMarks, extras.length),
            // (which already says which attached image is which)
            imagesExplained: true,
            targetCount: turn.candidates,
            // Edits keep the picture's own framing
            aspectRatio: frame ? frame.ratio : 'auto',
            ...(local ? localSettings(sent) : {}),
          }
          return {
            settings: requestSettings,
            singleSourcePrompt:
              turn.marks.length > 0 ? buildSingleSourcePrompt(turn.prompt, sentMarks) : undefined,
            references: [
              await imageToReference(sent),
              ...(guide ? [{ base64: guide.base64, mimeType: guide.mimeType }] : []),
              ...extras.map(({ base64, mimeType }) => ({ base64, mimeType })),
            ],
            guide,
          }
        }
        const framing: Framing | undefined = local
          ? {
              frame: await frameForModel(source.image, turn.modelId),
              request: requestFor,
              unframe: (answer, frame) => cropFromFrame(answer, frame, turn.modelId),
              reframe: async (width, height) => {
                const shape = learnShape(turn.modelId, width, height)
                return shape ? frameTo(source.image, shape) : null
              },
            }
          : undefined

        let firstResult = true
        let delivered = 0
        const prepare = async () => {
          const request = await requestFor(framing?.frame ?? null)
          // The bubble shows the arrows on the user's own picture, not on a frame
          const shown = framing?.frame ? await renderGuide(source.image.blob, turn.marks) : request.guide
          if (shown) {
            const guideUrl = URL.createObjectURL(shown.blob)
            patchSession(sessionId, (s) => ({
              ...s,
              turns: s.turns.map((t) => (t.id === turn.id ? { ...t, guideUrl } : t)),
            }))
          }
          if (cancelledRef.current) throw new StoppedBeforeStart()
          setPreparing(false)
          return request
        }
        const request = await prepare()
        const finished = await run.start(
          keys,
          request.settings,
          request.references,
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
              // held as a lossless PNG so further edits don't wear it down;
              // downloaded in the format the user asked for
              ...(extra && settings.format !== image.format ? { saveAs: settings.format } : {}),
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
                      options: localJob?.options ?? {},
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
            singleSourcePrompt: request.singleSourcePrompt,
            wrapCaller: localJob ? (caller) => makeLocalEditCaller(caller, localJob, framing) : undefined,
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
        findObject: request.findObject && request.localOnly && marks.length > 0,
        locatorModel: request.locatorModel,
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
        found: undefined,
        status: 'running',
        resultVersionIds: [],
        attempts: 0,
        lastFailure: null,
        errorMessage: null,
      })
    },
    [sessions, busy, runTurn],
  )

  // Cuts an "only around the arrows" result out of the same answer again,
  // with spots the user picked: taken from the model here, the original put
  // back there. No request is made. Adds a new version; resolves to what went
  // wrong, if anything.
  const recut = useCallback(
    async (sessionId: string, versionId: string, touches: Touch[]): Promise<string | null> => {
      const session = sessions[sessionId]
      const version = session?.versions.find((v) => v.id === versionId)
      const turn = session?.turns.find((t) => t.id === version?.turnId)
      const source = session?.versions.find((v) => v.id === turn?.sourceVersionId)
      if (!session || !version?.local || !turn || !source || touches.length === 0) return null
      if (busyRef.current) return 'Wait for the edit that is running to finish.'
      busyRef.current = true
      setRecutting(true)
      let editor: LocalEditor | null = null
      try {
        editor = await createLocalEditor(source.image.blob, turn.marks)
        const options: LocalEditOptions = {
          ...version.local.options,
          touches: [...(version.local.options.touches ?? []), ...touches],
        }
        const outcome = await editor.compose(version.local.whole.blob, options)
        if (outcome.kind === 'reject') return 'That left nothing of the edit — the picture would just be the one before it.'
        const image = await processImagePart(
          { base64: await blobToBase64(outcome.blob), mimeType: 'image/png' },
          'png',
          { attempt: version.image.attempt, modelId: version.image.modelId },
        )
        const number = versionCounters.current[sessionId] ?? 1
        versionCounters.current[sessionId] = number + 1
        const prompt = (version.image.edit?.prompt ?? '').replace(/ \(touched up\)$/, '')
        const tagged: GeneratedImage = {
          ...image,
          edit: { sessionId, version: number, prompt: `${prompt} (touched up)` },
          ...(settings.format !== image.format ? { saveAs: settings.format } : {}),
        }
        const added: EditVersion = {
          id: crypto.randomUUID(),
          number,
          image: tagged,
          turnId: version.turnId,
          derived: true,
          derivedFrom: version.id,
          recut: true,
          local: {
            whole: version.local.whole,
            areaUrl: URL.createObjectURL(outcome.mask),
            info: outcome.info,
            options,
          },
        }
        onResult(tagged)
        patchSession(sessionId, (s) => ({
          ...s,
          versions: [...s.versions, added],
          turns: s.turns.map((t) =>
            t.id === version.turnId ? { ...t, resultVersionIds: [...t.resultVersionIds, added.id] } : t,
          ),
          selectedVersionId: added.id,
        }))
        return null
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      } finally {
        editor?.release()
        busyRef.current = false
        setRecutting(false)
      }
    },
    [sessions, settings.format, onResult, patchSession],
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
    locating.current?.abort()
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
      recut,
      isRecutting: recutting,
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
      recut,
      recutting,
      stop,
      preparing,
      run.runState,
      busy,
      runningTurn,
    ],
  )
}

// Asks where the things the arrows point at are. Never fails the edit: any
// problem comes back as a note, and the edit goes on as it would without.
async function findObjects(
  picture: Blob,
  turn: EditTurn,
  signal: AbortSignal,
): Promise<{
  extents: NonNullable<LocalEditOptions['extents']>
  labels: (string | null)[]
  faces: Area[]
  problem: string | null
}> {
  const none = (problem: string) => ({
    extents: turn.marks.map(() => null),
    labels: turn.marks.map(() => null),
    faces: [],
    problem,
  })
  const key = loadApiKeys('gemini').find(Boolean) ?? (isMockMode() ? 'mock' : '')
  if (!key) return none('no Google AI Studio key is saved')
  try {
    const located = await locateObjects(key, turn.locatorModel, picture, turn.marks, signal)
    return { extents: located.extents, labels: located.labels, faces: located.guarded, problem: null }
  } catch (err) {
    if (signal.aborted) return none('stopped')
    // The SDK reports API errors as the response's JSON: say what it says
    let message = err instanceof Error ? err.message : String(err)
    const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message)
    if (inner) message = inner[1].replace(/\\(.)/g, '$1')
    return none(message.length > 140 ? `${message.slice(0, 140)}…` : message)
  }
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
function localSettings(image: { width: number; height: number }): Partial<Settings> {
  // By area, not by the longer side: a long thin picture is no bigger
  const megapixels = (image.width * image.height) / 1e6
  return {
    imageSize: megapixels > 5.5 ? '4K' : megapixels > 1.6 ? '2K' : '1K',
    xaiResolution: megapixels > 1.6 ? '2k' : '1k',
    matchSize: { width: image.width, height: image.height },
    format: 'png',
  }
}

// How many reference photos can travel with an edit: what the model takes,
// less the picture being edited and (with arrows) the arrow guide
export function studioReferenceSlots(modelId: string, withArrows: boolean): number {
  const model = getModel(modelId)
  const most =
    model.provider === 'xai' ? MAX_XAI_SOURCES : model.provider === 'openai' ? MAX_OPENAI_SOURCES : model.maxReferences
  return Math.max(0, most - 1 - (withArrows ? 1 : 0))
}
