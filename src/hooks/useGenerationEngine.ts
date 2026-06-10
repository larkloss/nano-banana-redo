import { useCallback, useRef, useState } from 'react'
import type { EngineEvent, GeneratedImage, ReferenceImage, RunState, Settings } from '../types'
import { callGenerate } from '../lib/gemini'
import { mockCallGenerate, isMockMode } from '../lib/mockGemini'
import { runGeneration } from '../lib/retryEngine'
import { processImagePart } from '../lib/imageUtils'

const IDLE_STATE: RunState = {
  status: 'idle',
  collected: 0,
  target: 0,
  attempts: 0,
  cap: 0,
  lastFailure: null,
  backoffUntil: null,
  errorMessage: null,
}

export function useGenerationEngine() {
  const [runState, setRunState] = useState<RunState>(IDLE_STATE)
  const [images, setImages] = useState<GeneratedImage[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const runningRef = useRef(false)

  const start = useCallback(async (apiKey: string, settings: Settings, references: ReferenceImage[]) => {
    if (runningRef.current) return
    runningRef.current = true
    const controller = new AbortController()
    abortRef.current = controller

    setRunState({
      status: 'running',
      collected: 0,
      target: settings.targetCount,
      attempts: 0,
      cap: settings.attemptsCap,
      lastFailure: null,
      backoffUntil: null,
      errorMessage: null,
    })

    const onEvent = (event: EngineEvent) => {
      if (event.type === 'image') {
        void processImagePart(event.image, settings.format, {
          attempt: event.attempt,
          modelId: settings.modelId,
        }).then((img) => setImages((prev) => [img, ...prev]))
        setRunState((prev) => ({
          ...prev,
          status: 'running',
          collected: prev.collected + 1,
          backoffUntil: null,
        }))
      } else if (event.type === 'progress') {
        setRunState((prev) => ({
          ...prev,
          status: 'running',
          attempts: event.attempts,
          backoffUntil: null,
        }))
      } else if (event.type === 'failure') {
        setRunState((prev) => ({
          ...prev,
          status: 'running',
          attempts: event.attempts,
          lastFailure: event.reason,
          backoffUntil: null,
        }))
      } else if (event.type === 'backoff') {
        setRunState((prev) => ({
          ...prev,
          status: 'backoff',
          lastFailure: event.reason,
          backoffUntil: Date.now() + event.delayMs,
        }))
      }
    }

    const caller = isMockMode() ? mockCallGenerate : callGenerate
    try {
      const summary = await runGeneration(caller, { apiKey, settings, references }, controller.signal, onEvent)
      setRunState((prev) => ({
        ...prev,
        status: summary.result,
        attempts: summary.attempts,
        backoffUntil: null,
        errorMessage: summary.errorMessage ?? null,
      }))
    } catch (err) {
      setRunState((prev) => ({
        ...prev,
        status: 'error',
        backoffUntil: null,
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

  const isRunning = runState.status === 'running' || runState.status === 'backoff'

  return { runState, images, start, stop, clearImages, isRunning }
}
