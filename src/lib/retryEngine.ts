import type { AttemptOutcome, EngineEvent, RunSummary } from '../types'
import type { GenerateCaller, GenerateParams } from './gemini'
import { classifyError, classifyResponse } from './errors'

// Consecutive transient failures (429/5xx/network) before giving up entirely.
const MAX_CONSECUTIVE_TRANSIENT = 6
const BACKOFF_BASE_MS = 2000
const BACKOFF_MAX_MS = 60000

export async function runGeneration(
  call: GenerateCaller,
  params: GenerateParams,
  signal: AbortSignal,
  onEvent: (event: EngineEvent) => void,
): Promise<RunSummary> {
  const { targetCount, attemptsCap } = params.settings
  let collected = 0
  // attempts counts completed generation calls (success + moderation + empty);
  // transient errors (429/5xx) have their own consecutive budget and don't consume the cap.
  let attempts = 0
  let consecutiveTransient = 0

  while (collected < targetCount && attempts < attemptsCap) {
    if (signal.aborted) return summary('stopped', collected, attempts)

    let outcome: AttemptOutcome
    try {
      const parsed = await call(params, signal)
      outcome = classifyResponse(parsed)
    } catch (err) {
      outcome = classifyError(err)
    }

    switch (outcome.kind) {
      case 'success': {
        attempts += 1
        consecutiveTransient = 0
        for (const image of outcome.images) {
          if (collected >= targetCount) break
          collected += 1
          onEvent({ type: 'image', image, attempt: attempts })
        }
        onEvent({ type: 'progress', collected, attempts, cap: attemptsCap })
        break
      }
      case 'moderation':
      case 'empty': {
        attempts += 1
        consecutiveTransient = 0
        onEvent({ type: 'failure', reason: outcome.reason, attempts, cap: attemptsCap })
        break
      }
      case 'transient': {
        consecutiveTransient += 1
        if (consecutiveTransient > MAX_CONSECUTIVE_TRANSIENT) {
          return summary('error', collected, attempts, `Giving up after repeated errors: ${outcome.reason}`)
        }
        const delayMs =
          outcome.retryDelayMs ??
          Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveTransient - 1) + Math.random() * 500, BACKOFF_MAX_MS)
        onEvent({ type: 'backoff', delayMs, reason: outcome.reason })
        await sleep(delayMs, signal)
        break
      }
      case 'fatal':
        return summary('error', collected, attempts, outcome.message)
      case 'aborted':
        return summary('stopped', collected, attempts)
    }
  }

  return summary(collected >= targetCount ? 'complete' : 'cap-reached', collected, attempts)
}

function summary(
  result: RunSummary['result'],
  collected: number,
  attempts: number,
  errorMessage?: string,
): RunSummary {
  return { result, collected, attempts, errorMessage }
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
