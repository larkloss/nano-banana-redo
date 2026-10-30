import { useCallback, useMemo, useRef, useState } from 'react'
import type { GeneratedImage, ReferenceImage, RunStatus, Settings } from '../types'
import { useRetryRun } from './useRetryRun'
import { imageToReference } from '../lib/imageUtils'
import { getModel } from '../lib/models'
import { loadApiKeys } from '../lib/storage'
import { isMockMode } from '../lib/mockGemini'
import { MAX_XAI_SOURCES } from '../lib/xai'
import { MAX_OPENAI_SOURCES } from '../lib/openai'

// One picture's edit history. Version 0 is the picture the chain started
// from; every successful edit adds a version, and any version can be the
// starting point of the next edit — so a chain can branch and back up.
export interface EditVersion {
  id: string
  number: number
  image: GeneratedImage
  // The turn that produced it; null for the original
  turnId: string | null
}

export type TurnStatus = Exclude<RunStatus, 'idle'>

export interface EditTurn {
  id: string
  prompt: string
  sourceVersionId: string
  withReferences: boolean
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
  candidates: number
  withReferences: boolean
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
      const extras = turn.withReferences ? references.slice(0, Math.max(0, maxSources - 1)) : []
      const prompt =
        extras.length > 0
          ? `Edit the first image: ${turn.prompt}\n\nThe other images are reference photos of the same character. ` +
            "Use them only to keep the character's face and likeness consistent; change nothing else that wasn't asked for."
          : turn.prompt

      busyRef.current = true
      cancelledRef.current = false
      setPreparing(true)
      patchSession(sessionId, (s) => ({ ...s, turns: [...s.turns.filter((t) => t.id !== turn.id), turn] }))
      setRunningTurn({ sessionId, turnId: turn.id })
      try {
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
          aspectRatio: 'auto',
        }

        let firstResult = true
        let delivered = 0
        const prepareSources = async () => {
          const sources = [
            await imageToReference(source.image),
            ...extras.map(({ base64, mimeType }) => ({ base64, mimeType })),
          ]
          if (cancelledRef.current) throw new StoppedBeforeStart()
          setPreparing(false)
          return sources
        }
        const finished = await run.start(keys, runSettings, await prepareSources(), (image) => {
          // Numbered outside the state updater so StrictMode's double call
          // can't skip a number or add the picture to the gallery twice
          const number = versionCounters.current[sessionId] ?? 1
          versionCounters.current[sessionId] = number + 1
          const tagged: GeneratedImage = { ...image, edit: { sessionId, version: number, prompt: turn.prompt } }
          const version: EditVersion = { id: crypto.randomUUID(), number, image: tagged, turnId: turn.id }
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
        })

        if (!finished) {
          finishTurn({ status: 'error', errorMessage: 'Another edit was already running.' })
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
      if (!session || busy || !request.prompt.trim()) return
      void runTurn(sessionId, {
        id: crypto.randomUUID(),
        prompt: request.prompt.trim(),
        sourceVersionId: session.selectedVersionId,
        withReferences: request.withReferences,
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
        status: 'running',
        resultVersionIds: [],
        attempts: 0,
        lastFailure: null,
        errorMessage: null,
      })
    },
    [sessions, busy, runTurn],
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
