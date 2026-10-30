import { useEffect, useState } from 'react'
import type { LaneState, RunState } from '../../types'
import { friendlyReason } from '../../lib/friendly'

interface Props {
  runState: RunState
  isRunning: boolean
  canRun: boolean
  runDisabledHint: string | null
  // What the run collects — "image" for the image models, "video" for Omni
  noun?: string
  // Button text; defaults to "Run"
  runLabel?: string
  onRun: () => void
  onStop: () => void
}

export function RunBar({
  runState,
  isRunning,
  canRun,
  runDisabledHint,
  noun = 'image',
  runLabel = 'Run',
  onRun,
  onStop,
}: Props) {
  return (
    <div className="soft-shadow space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {isRunning ? (
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-2 rounded-full bg-red-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-red-500"
          >
            <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-white" />
            Stop
          </button>
        ) : (
          <span title={runDisabledHint ?? undefined}>
            <button
              type="button"
              onClick={onRun}
              disabled={!canRun}
              className="flex items-center gap-2 rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="inline-block h-0 w-0 border-y-[6px] border-l-[9px] border-y-transparent border-l-white" />
              {runLabel}
            </button>
          </span>
        )}
        <StatusLine runState={runState} isRunning={isRunning} noun={noun} />
      </div>
      {isRunning && runState.lanes.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {runState.lanes.map((laneState, i) => (
            <LaneChip key={i} index={i} lane={laneState} />
          ))}
        </div>
      )}
      <ProgressBar runState={runState} isRunning={isRunning} />
      {!canRun && !isRunning && runDisabledHint && (
        <p className="text-xs text-amber-400/90">{runDisabledHint}</p>
      )}
    </div>
  )
}

function StatusLine({ runState, isRunning, noun }: { runState: RunState; isRunning: boolean; noun: string }) {
  if (runState.status === 'idle') {
    return (
      <span className="text-xs text-zinc-500">
        Ready when you are — refused attempts are retried automatically until every {noun} is in.
      </span>
    )
  }

  const singleLaneBackoff = runState.lanes.length === 1 ? runState.lanes[0] : null
  const counters = (
    <>
      <b className="text-zinc-200">
        {runState.collected} of {runState.target}
      </b>{' '}
      ready
      <span className="mx-2 text-zinc-600">·</span>
      {runState.attempts} {runState.attempts === 1 ? 'try' : 'tries'}{' '}
      <span className="text-zinc-500">(max {runState.cap})</span>
    </>
  )

  if (isRunning) {
    return (
      <span className="text-xs text-zinc-400">
        <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400 align-middle" />
        {counters}
        {singleLaneBackoff?.status === 'backoff' ? (
          <>
            <span className="mx-2 text-zinc-700">·</span>
            <BackoffText lane={singleLaneBackoff} />
          </>
        ) : (
          runState.lastFailure && (
            <>
              <span className="mx-2 text-zinc-700">·</span>
              <span className="text-amber-400/90" title={runState.lastFailure}>
                last try {friendlyReason(runState.lastFailure)} — trying again
              </span>
            </>
          )
        )}
      </span>
    )
  }

  const banner = {
    complete: (
      <span className="text-emerald-400">
        All {runState.target} {runState.target === 1 ? noun : `${noun}s`} are ready 🎉
      </span>
    ),
    'cap-reached': (
      <span className="text-amber-400">
        Hit the try limit with {runState.collected} of {runState.target}. Raise “Max attempts” or soften the
        prompt, then go again.
      </span>
    ),
    stopped: (
      <span className="text-zinc-400">
        Stopped — kept {runState.collected} {noun}(s).
      </span>
    ),
    error: <span className="text-red-400">{runState.errorMessage ?? 'Unknown error'}</span>,
  }[runState.status as 'complete' | 'cap-reached' | 'stopped' | 'error']

  return (
    <span className="text-xs">
      <span className="mr-3 text-zinc-500">{counters}</span>
      {banner}
    </span>
  )
}

function LaneChip({ index, lane }: { index: number; lane: LaneState }) {
  const style = {
    idle: 'border-zinc-700 text-zinc-500',
    running: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
    backoff: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    done: 'border-zinc-700 text-zinc-500',
    dead: 'border-red-500/40 bg-red-500/10 text-red-300',
  }[lane.status]

  return (
    <span className={`rounded-full border px-2.5 py-1 text-[10px] ${style}`} title={lane.lastReason ?? undefined}>
      Key {index + 1}:{' '}
      {lane.status === 'running' && 'generating…'}
      {lane.status === 'idle' && 'waiting'}
      {lane.status === 'done' && 'finished'}
      {lane.status === 'backoff' && <BackoffText lane={lane} />}
      {lane.status === 'dead' && `stopped — ${lane.lastReason ?? 'error'}`}
    </span>
  )
}

function BackoffText({ lane }: { lane: LaneState }) {
  const seconds = useCountdown(lane.backoffUntil)
  return (
    <span className="text-amber-400">
      {lane.lastReason ?? 'Rate limited'} — retrying{seconds !== null ? ` in ${seconds}s` : '…'}
    </span>
  )
}

function ProgressBar({ runState, isRunning }: { runState: RunState; isRunning: boolean }) {
  if (runState.status === 'idle') return null
  const pct = runState.target > 0 ? Math.min(100, (runState.collected / runState.target) * 100) : 0
  return (
    <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
      <div
        className={`h-full rounded-full transition-all duration-500 ${
          runState.status === 'complete'
            ? 'bg-emerald-500'
            : runState.status === 'error'
              ? 'bg-red-500'
              : isRunning
                ? 'bg-blue-500'
                : 'bg-amber-500'
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function useCountdown(until: number | null): number | null {
  const [seconds, setSeconds] = useState<number | null>(null)
  useEffect(() => {
    if (until === null) return
    const update = () => setSeconds(Math.max(0, Math.ceil((until - Date.now()) / 1000)))
    const timer = setInterval(update, 100)
    return () => clearInterval(timer)
  }, [until])
  return until === null ? null : seconds
}
