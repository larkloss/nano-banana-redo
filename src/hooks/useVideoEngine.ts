import { useCallback, useRef, useState } from 'react'
import type { GeneratedVideo, VideoEngineEvent, VideoLaneState, VideoRunState } from '../types'
import { callGenerateVideo } from '../lib/veo'
import { mockCallGenerateVideo } from '../lib/mockVeo'
import { isMockMode } from '../lib/mockGemini'
import { runVideoGeneration, type VideoRunParams } from '../lib/videoEngine'

const IDLE_STATE: VideoRunState = {
  status: 'idle',
  collected: 0,
  target: 0,
  attempts: 0,
  cap: 0,
  lanes: [],
  lastFailure: null,
  errorMessage: null,
}

const IDLE_LANE: VideoLaneState = { status: 'idle', lastReason: null, backoffUntil: null, phaseStartedAt: null }

export function useVideoEngine() {
  const [runState, setRunState] = useState<VideoRunState>(IDLE_STATE)
  const [videos, setVideos] = useState<GeneratedVideo[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const runningRef = useRef(false)

  const start = useCallback(async (params: VideoRunParams) => {
    if (runningRef.current || params.keys.length === 0) return
    runningRef.current = true
    const controller = new AbortController()
    abortRef.current = controller
    const { settings } = params

    setRunState({
      status: 'running',
      collected: 0,
      target: settings.targetCount,
      attempts: 0,
      cap: settings.attemptsCap,
      lanes: params.keys.map(() => IDLE_LANE),
      lastFailure: null,
      errorMessage: null,
    })

    const onEvent = (event: VideoEngineEvent) => {
      if (event.type === 'video') {
        const objectUrl = URL.createObjectURL(event.blob)
        setVideos((prev) => [
          {
            id: crypto.randomUUID(),
            blob: event.blob,
            objectUrl,
            mimeType: event.mimeType,
            modelId: settings.modelId,
            durationSeconds: settings.durationSeconds,
            resolution: settings.resolution,
            aspectRatio: settings.aspectRatio,
            attempt: event.attempt,
            createdAt: Date.now(),
          },
          ...prev,
        ])
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
                  phaseStartedAt: event.status === laneState.status ? laneState.phaseStartedAt : Date.now(),
                }
              : laneState,
          ),
        }))
      }
    }

    const caller = isMockMode() ? mockCallGenerateVideo : callGenerateVideo
    try {
      const summary = await runVideoGeneration(caller, params, controller.signal, onEvent)
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

  const removeVideo = useCallback((id: string) => {
    setVideos((prev) => {
      const target = prev.find((v) => v.id === id)
      if (target) URL.revokeObjectURL(target.objectUrl)
      return prev.filter((v) => v.id !== id)
    })
  }, [])

  const clearVideos = useCallback(() => {
    setVideos((prev) => {
      prev.forEach((v) => URL.revokeObjectURL(v.objectUrl))
      return []
    })
    setRunState(IDLE_STATE)
  }, [])

  const isRunning = runState.status === 'running'

  return { runState, videos, start, stop, removeVideo, clearVideos, isRunning }
}
