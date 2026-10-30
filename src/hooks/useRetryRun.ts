import { useCallback, useRef, useState } from 'react'
import type { EngineEvent, GeneratedImage, LaneState, ParsedImagePart, RunState, RunSummary, Settings } from '../types'
import { callGenerate } from '../lib/gemini'
import type { GenerateCaller } from '../lib/gemini'
import { callGenerateXai } from '../lib/xai'
import { callGenerateOpenai } from '../lib/openai'
import { callGenerateOmni } from '../lib/omni'
import { mockCallGenerate, isMockMode } from '../lib/mockGemini'
import { runGeneration } from '../lib/retryEngine'
import { processImagePart, processVideoPart } from '../lib/imageUtils'
import { getModel, getProvider } from '../lib/models'

export const IDLE_RUN_STATE: RunState = {
  status: 'idle',
  collected: 0,
  target: 0,
  attempts: 0,
  cap: 0,
  lanes: [],
  lastFailure: null,
  errorMessage: null,
}

export type FinishedRun = RunSummary & { lastFailure: string | null }

export function pickCaller(settings: Settings): GenerateCaller {
  if (isMockMode()) return mockCallGenerate
  const provider = getProvider(settings.modelId)
  if (provider === 'xai') return callGenerateXai
  if (provider === 'openai') return callGenerateOpenai
  return getModel(settings.modelId).output === 'video' ? callGenerateOmni : callGenerate
}

// One retry run at a time: the shared auto-retry engine plus the live state
// the UI shows (counters, per-key lanes, last refusal). The generator gallery
// and the edit studio each own an instance, so they can run side by side.
export function useRetryRun() {
  const [runState, setRunState] = useState<RunState>(IDLE_RUN_STATE)
  const abortRef = useRef<AbortController | null>(null)
  const runningRef = useRef(false)

  const start = useCallback(
    async (
      keys: string[],
      settings: Settings,
      references: ParsedImagePart[],
      onImage: (image: GeneratedImage) => void,
    ): Promise<FinishedRun | null> => {
      if (runningRef.current || keys.length === 0) return null
      runningRef.current = true
      const controller = new AbortController()
      abortRef.current = controller

      setRunState({
        status: 'running',
        collected: 0,
        target: settings.targetCount,
        attempts: 0,
        cap: settings.attemptsCap,
        lanes: keys.map<LaneState>(() => ({ status: 'idle', lastReason: null, backoffUntil: null })),
        lastFailure: null,
        errorMessage: null,
      })

      const isVideoModel = getModel(settings.modelId).output === 'video'
      // Images are decoded/re-encoded asynchronously; the run only counts as
      // finished for the caller once every one of them has been delivered
      const pending: Promise<void>[] = []
      let lastFailure: string | null = null

      const onEvent = (event: EngineEvent) => {
        if (event.type === 'image') {
          const meta = { attempt: event.attempt, modelId: settings.modelId }
          const processed = isVideoModel
            ? processVideoPart(event.image, meta)
            : processImagePart(event.image, settings.format, meta)
          pending.push(processed.then(onImage, () => undefined))
          setRunState((prev) => ({ ...prev, collected: prev.collected + 1 }))
        } else if (event.type === 'progress') {
          setRunState((prev) => ({ ...prev, attempts: event.attempts }))
        } else if (event.type === 'failure') {
          lastFailure = event.reason
          setRunState((prev) => ({
            ...prev,
            attempts: event.attempts,
            lastFailure: prev.lanes.length > 1 ? `Key ${event.lane + 1}: ${event.reason}` : event.reason,
          }))
        } else if (event.type === 'lane') {
          setRunState((prev) => ({
            ...prev,
            lanes: prev.lanes.map((laneState, i) =>
              i === event.lane
                ? {
                    status: event.status,
                    lastReason: event.reason ?? laneState.lastReason,
                    backoffUntil: event.status === 'backoff' ? (event.backoffUntil ?? null) : null,
                  }
                : laneState,
            ),
          }))
        }
      }

      let summary: RunSummary
      try {
        summary = await runGeneration(pickCaller(settings), { keys, settings, references }, controller.signal, onEvent)
      } catch (err) {
        summary = {
          result: 'error',
          collected: 0,
          attempts: 0,
          errorMessage: err instanceof Error ? err.message : String(err),
        }
      }
      await Promise.all(pending)
      setRunState((prev) => ({
        ...prev,
        status: summary.result,
        attempts: summary.attempts || prev.attempts,
        errorMessage: summary.errorMessage ?? null,
      }))
      runningRef.current = false
      abortRef.current = null
      return { ...summary, lastFailure }
    },
    [],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const reset = useCallback(() => {
    if (!runningRef.current) setRunState(IDLE_RUN_STATE)
  }, [])

  return { runState, start, stop, reset, isRunning: runState.status === 'running' }
}
