import type { RunSummary, VideoEngineEvent, VideoLaneStatus, VideoResult, VideoSettings } from '../types'
import type { VideoCaller, VideoGenerateParams } from './veo'
import { classifyError } from './errors'

// Consecutive transient failures (429/5xx/network) before a lane gives up.
const MAX_CONSECUTIVE_TRANSIENT = 6
const BACKOFF_BASE_MS = 2000
const BACKOFF_MAX_MS = 60000

export interface VideoRunParams {
  keys: string[]
  settings: VideoSettings
  prompt: string
  references: VideoGenerateParams['references']
  firstFrame: VideoGenerateParams['firstFrame']
  lastFrame: VideoGenerateParams['lastFrame']
}

type LaneExit = 'done' | 'cap' | 'fatal' | 'stopped'

// Same lane model as the image retryEngine — one worker per API key racing
// shared collected/attempts counters — but each attempt is a long-running
// operation, so the caller reports its phase (submitting/polling/downloading)
// which is forwarded as lane events for the UI.
export async function runVideoGeneration(
  call: VideoCaller,
  params: VideoRunParams,
  signal: AbortSignal,
  onEvent: (event: VideoEngineEvent) => void,
): Promise<RunSummary> {
  const { targetCount, attemptsCap } = params.settings
  const shared = { collected: 0, attemptsStarted: 0, attemptsCompleted: 0 }
  const fatalMessages: string[] = []

  const laneEvent = (lane: number, status: VideoLaneStatus, reason?: string, backoffUntil?: number) =>
    onEvent({ type: 'lane', lane, status, reason, backoffUntil })

  async function worker(lane: number, apiKey: string): Promise<LaneExit> {
    let consecutiveTransient = 0
    const callParams: VideoGenerateParams = {
      apiKey,
      settings: params.settings,
      prompt: params.prompt,
      references: params.references,
      firstFrame: params.firstFrame,
      lastFrame: params.lastFrame,
    }

    while (true) {
      if (signal.aborted) return 'stopped'
      if (shared.collected >= targetCount) {
        laneEvent(lane, 'done')
        return 'done'
      }
      if (shared.attemptsStarted >= attemptsCap) {
        laneEvent(lane, 'done')
        return 'cap'
      }

      shared.attemptsStarted += 1

      let outcome: VideoResult | ReturnType<typeof classifyError>
      try {
        outcome = await call(callParams, signal, (phase) => laneEvent(lane, phase))
      } catch (err) {
        outcome = classifyError(err)
      }

      switch (outcome.kind) {
        case 'video': {
          shared.attemptsCompleted += 1
          shared.collected += 1
          consecutiveTransient = 0
          onEvent({
            type: 'video',
            blob: outcome.blob,
            mimeType: outcome.mimeType,
            attempt: shared.attemptsCompleted,
            lane,
          })
          onEvent({
            type: 'progress',
            collected: shared.collected,
            attempts: shared.attemptsCompleted,
            cap: attemptsCap,
          })
          break
        }
        case 'filtered':
        case 'moderation':
        case 'empty': {
          shared.attemptsCompleted += 1
          consecutiveTransient = 0
          onEvent({
            type: 'failure',
            reason: outcome.reason,
            attempts: shared.attemptsCompleted,
            cap: attemptsCap,
            lane,
          })
          break
        }
        case 'transient': {
          // Refund the reservation — transient errors don't consume the cap
          shared.attemptsStarted -= 1
          consecutiveTransient += 1
          if (consecutiveTransient > MAX_CONSECUTIVE_TRANSIENT) {
            const message = `Key ${lane + 1}: giving up after repeated errors (${outcome.reason})`
            fatalMessages.push(message)
            laneEvent(lane, 'dead', message)
            return 'fatal'
          }
          const delayMs =
            outcome.retryDelayMs ??
            Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveTransient - 1) + Math.random() * 500, BACKOFF_MAX_MS)
          laneEvent(lane, 'backoff', outcome.reason, Date.now() + delayMs)
          await sleep(delayMs, signal)
          break
        }
        case 'fatal': {
          const message = `Key ${lane + 1}: ${outcome.message}`
          fatalMessages.push(message)
          laneEvent(lane, 'dead', message)
          return 'fatal'
        }
        case 'aborted':
          return 'stopped'
        // classifyError never returns 'success' for a thrown error, but the
        // union includes it — treat as empty to satisfy exhaustiveness
        case 'success': {
          shared.attemptsCompleted += 1
          break
        }
      }
    }
  }

  const exits = await Promise.all(params.keys.map((key, i) => worker(i, key)))

  let result: RunSummary['result']
  if (signal.aborted) result = 'stopped'
  else if (shared.collected >= targetCount) result = 'complete'
  else if (exits.length > 0 && exits.every((e) => e === 'fatal' || e === 'stopped')) result = 'error'
  else result = 'cap-reached'

  return {
    result,
    collected: shared.collected,
    attempts: shared.attemptsCompleted,
    errorMessage: result === 'error' ? fatalMessages.join(' · ') || 'No usable API key' : undefined,
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}
