import { useCallback, useRef, useState } from 'react'
import type { EngineEvent, GeneratedImage, LaneState, ReferenceImage, RunState, Settings } from '../types'
import { callGenerate } from '../lib/gemini'
import { callGenerateXai } from '../lib/xai'
import { mockCallGenerate, isMockMode } from '../lib/mockGemini'
import { runGeneration } from '../lib/retryEngine'
import { processImagePart } from '../lib/imageUtils'
import { getProvider } from '../lib/models'

const IDLE_STATE: RunState = {
  status: 'idle',
  collected: 0,
  target: 0,
  attempts: 0,
  cap: 0,
  lanes: [],
  lastFailure: null,
  errorMessage: null,
}

export function useGenerationEngine() {
  const [runState, setRunState] = useState<RunState>(IDLE_STATE)
  const [images, setImages] = useState<GeneratedImage[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const runningRef = useRef(false)

  const start = useCallback(async (keys: string[], settings: Settings, references: ReferenceImage[]) => {
    if (runningRef.current || keys.length === 0) return
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

    const onEvent = (event: EngineEvent) => {
      if (event.type === 'image') {
        void processImagePart(event.image, settings.format, {
          attempt: event.attempt,
          modelId: settings.modelId,
        }).then((img) => setImages((prev) => [img, ...prev]))
        setRunState((prev) => ({ ...prev, collected: prev.collected + 1 }))
      } else if (event.type === 'progress') {
        setRunState((prev) => ({ ...prev, attempts: event.attempts }))
      } else if (event.type === 'failure') {
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

    const caller = isMockMode()
      ? mockCallGenerate
      : getProvider(settings.modelId) === 'xai'
        ? callGenerateXai
        : callGenerate
    try {
      const summary = await runGeneration(caller, { keys, settings, references }, controller.signal, onEvent)
      setRunState((prev) => ({
        ...prev,
        status: summary.result,
        attempts: summary.attempts,
        errorMessage: summary.errorMessage ?? null,
      }))
    } catch (err) {
      setRunState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      runningRef.current = false
      abortRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const clearImages = useCallback(() => {
    setImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.objectUrl))
      return []
    })
    setRunState(IDLE_STATE)
  }, [])

  const isRunning = runState.status === 'running'

  return { runState, images, start, stop, clearImages, isRunning }
}
