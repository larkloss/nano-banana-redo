import { useCallback, useRef, useState } from 'react'
import type { EngineEvent, LaneState, RunState } from '../../types'
import type { BaseImage, Candidate, EditSettings, Shape } from '../types'
import { callGenerate } from '../../lib/gemini'
import { isMockMode } from '../../lib/mockGemini'
import { runGeneration } from '../../lib/retryEngine'
import { makeEditCaller, prepareEditJob, type EditJob } from '../lib/editPipeline'
import { mockEditCaller } from '../lib/mockEdit'
import { rasterizeAlphaMask } from '../lib/mask'
import { compositeResult } from '../lib/composite'

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

export function useEditEngine() {
  const [runState, setRunState] = useState<RunState>(IDLE_STATE)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const runningRef = useRef(false)
  const jobRef = useRef<EditJob | null>(null)

  const start = useCallback(
    async (keys: string[], base: BaseImage, shapes: Shape[], settings: EditSettings) => {
      if (runningRef.current || keys.length === 0) return
      runningRef.current = true
      const controller = new AbortController()
      abortRef.current = controller

      setCandidates((prev) => {
        prev.forEach((c) => URL.revokeObjectURL(c.compositeUrl))
        return []
      })
      setRunState({
        status: 'running',
        collected: 0,
        target: settings.candidates,
        attempts: 0,
        cap: settings.attemptsCap,
        lanes: keys.map<LaneState>(() => ({ status: 'idle', lastReason: null, backoffUntil: null })),
        lastFailure: null,
        errorMessage: null,
      })

      const fullMask = rasterizeAlphaMask(shapes, base.width, base.height)
      const job = await prepareEditJob(base, shapes, settings)
      jobRef.current = job

      const onEvent = (event: EngineEvent) => {
        if (event.type === 'image') {
          const analysis = job.analysisCache.get(event.image.base64) ?? { dx: 0, dy: 0, insideDiff: 0 }
          void compositeResult(
            base.bitmap,
            event.image,
            fullMask,
            settings.feather,
            analysis,
            settings.format,
          ).then((blob) => {
            setCandidates((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                part: event.image,
                offset: { dx: analysis.dx, dy: analysis.dy },
                insideDiff: analysis.insideDiff,
                compositeBlob: blob,
                compositeUrl: URL.createObjectURL(blob),
                attempt: event.attempt,
              },
            ])
          })
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

      const caller = makeEditCaller(isMockMode() ? mockEditCaller : callGenerate, job)
      try {
        const summary = await runGeneration(
          caller,
          { keys, settings: job.engineSettings, references: job.references },
          controller.signal,
          onEvent,
        )
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
    },
    [],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  // Re-composite a candidate with a new feather radius (offset already known)
  const recomposite = useCallback(
    async (candidate: Candidate, base: BaseImage, shapes: Shape[], settings: EditSettings): Promise<void> => {
      const fullMask = rasterizeAlphaMask(shapes, base.width, base.height)
      const blob = await compositeResult(
        base.bitmap,
        candidate.part,
        fullMask,
        settings.feather,
        candidate.offset,
        settings.format,
      )
      setCandidates((prev) =>
        prev.map((c) => {
          if (c.id !== candidate.id) return c
          URL.revokeObjectURL(c.compositeUrl)
          return { ...c, compositeBlob: blob, compositeUrl: URL.createObjectURL(blob) }
        }),
      )
    },
    [],
  )

  const reset = useCallback(() => {
    setCandidates((prev) => {
      prev.forEach((c) => URL.revokeObjectURL(c.compositeUrl))
      return []
    })
    setRunState(IDLE_STATE)
  }, [])

  const isRunning = runState.status === 'running'

  return { runState, candidates, start, stop, recomposite, reset, isRunning }
}
