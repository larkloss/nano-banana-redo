import type { AttemptOutcome, EngineEvent, LaneStatus, ReferenceImage, RunSummary, Settings } from '../types'
import type { GenerateCaller, GenerateParams } from './gemini'
import { classifyError, classifyResponse } from './errors'

// Consecutive transient failures (429/5xx/network) before a lane gives up.
const MAX_CONSECUTIVE_TRANSIENT = 6
const BACKOFF_BASE_MS = 2000
const BACKOFF_MAX_MS = 60000

export interface RunParams {
  keys: string[]
  settings: Settings
  references: ReferenceImage[]
}

type LaneExit = 'done' | 'cap' | 'fatal' | 'stopped'

// One worker lane per API key, all racing against shared counters:
// `collected` (target) and `attemptsStarted` (cap). attempts count completed
// generation calls (success + moderation + empty); transient errors (429/5xx)
// back off per-lane without consuming the cap. Near the target both lanes may
// have a call in flight, so a run can overshoot by up to keys.length-1 images.
export async function runGeneration(
  call: GenerateCaller,
  params: RunParams,
  signal: AbortSignal,
  onEvent: (event: EngineEvent) => void,
): Promise<RunSummary> {
  const { targetCount, attemptsCap } = params.settings
  const shared = { collected: 0, attemptsStarted: 0, attemptsCompleted: 0 }
  const fatalMessages: string[] = []

  const laneEvent = (lane: number, status: LaneStatus, reason?: string, backoffUntil?: number) =>
    onEvent({ type: 'lane', lane, status, reason, backoffUntil })

  async function worker(lane: number, apiKey: string): Promise<LaneExit> {
    let consecutiveTransient = 0
    const callParams: GenerateParams = { apiKey, settings: params.settings, references: params.references }

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
      laneEvent(lane, 'running')

      let outcome: AttemptOutcome
      try {
        const parsed = await call(callParams, signal)
        outcome = classifyResponse(parsed)
      } catch (err) {
        outcome = classifyError(err)
      }

      switch (outcome.kind) {
        case 'success': {
          shared.attemptsCompleted += 1
          consecutiveTransient = 0
          for (const image of outcome.images) {
            shared.collected += 1
            onEvent({ type: 'image', image, attempt: shared.attemptsCompleted, lane })
          }
          onEvent({
            type: 'progress',
            collected: shared.collected,
            attempts: shared.attemptsCompleted,
            cap: attemptsCap,
          })
          break
        }
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
