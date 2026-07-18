import { useEffect, useState } from 'react'
import type { VideoLaneState, VideoRunState } from '../../types'

interface Props {
  runState: VideoRunState
  isRunning: boolean
  canRun: boolean
  runDisabledHint: string | null
  costLine: string
  onRun: () => void
  onStop: () => void
}

export function VideoRunBar({ runState, isRunning, canRun, runDisabledHint, costLine, onRun, onStop }: Props) {
  return (
    <div className="space-y-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center gap-4">
        {isRunning ? (
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-red-500"
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
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="inline-block h-0 w-0 border-y-[6px] border-l-[9px] border-y-transparent border-l-white" />
              Run
            </button>
          </span>
        )}
        <StatusLine runState={runState} isRunning={isRunning} costLine={costLine} />
      </div>
      {isRunning && (
        <div className="flex flex-wrap gap-2">
          {runState.lanes.map((laneState, i) => (
            <LaneChip key={i} index={i} lane={laneState} solo={runState.lanes.length === 1} />
          ))}
        </div>
      )}
      {isRunning && (
        <p className="text-[10px] text-zinc-600">
          Stop halts polling and new submissions — operations already submitted keep running (and billing)
          server-side.
        </p>
      )}
      <ProgressBar runState={runState} isRunning={isRunning} />
      {!canRun && !isRunning && runDisabledHint && (
        <p className="text-xs text-amber-400/90">{runDisabledHint}</p>
      )}
    </div>
  )
}

function StatusLine({ runState, isRunning, costLine }: { runState: VideoRunState; isRunning: boolean; costLine: string }) {
  if (runState.status === 'idle') {
    return (
      <span className="text-xs text-zinc-500">
        Ready — each video takes 1–6 minutes to generate. {costLine}
      </span>
    )
  }

  const counters = (
    <>
      Collected <b className="text-zinc-200">{runState.collected}/{runState.target}</b>
      <span className="mx-2 text-zinc-700">·</span>
      Attempt <b className="text-zinc-200">{runState.attempts}/{runState.cap}</b>
    </>
  )

  if (isRunning) {
    return (
      <span className="text-xs text-zinc-400">
        <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400 align-middle" />
        {counters}
        {runState.lastFailure && (
          <>
            <span className="mx-2 text-zinc-700">·</span>
            <span className="text-amber-400/80">last: {runState.lastFailure}</span>
          </>
        )}
      </span>
    )
  }

  const banner = {
    complete: <span className="text-emerald-400">Done — all {runState.target} video(s) collected.</span>,
    'cap-reached': (
      <span className="text-amber-400">
        Attempt cap reached — collected {runState.collected}/{runState.target}. Raise "Max attempts" or adjust
        the prompt to continue.
      </span>
    ),
    stopped: <span className="text-zinc-400">Stopped — kept {runState.collected} video(s).</span>,
    error: <span className="text-red-400">{runState.errorMessage ?? 'Unknown error'}</span>,
  }[runState.status as 'complete' | 'cap-reached' | 'stopped' | 'error']

  return (
    <span className="text-xs">
      <span className="mr-3 text-zinc-500">{counters}</span>
      {banner}
    </span>
  )
}

function LaneChip({ index, lane, solo }: { index: number; lane: VideoLaneState; solo: boolean }) {
  const style = {
    idle: 'border-zinc-700 text-zinc-500',
    submitting: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
    polling: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
    downloading: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    backoff: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    done: 'border-zinc-700 text-zinc-500',
    dead: 'border-red-500/40 bg-red-500/10 text-red-300',
  }[lane.status]

  return (
    <span className={`rounded-md border px-2 py-1 text-[10px] ${style}`} title={lane.lastReason ?? undefined}>
      {solo ? 'Status' : `Key ${index + 1}`}:{' '}
      {lane.status === 'idle' && 'waiting'}
      {lane.status === 'submitting' && 'submitting…'}
      {lane.status === 'polling' && <PollingText lane={lane} />}
      {lane.status === 'downloading' && 'downloading video…'}
      {lane.status === 'done' && 'finished'}
      {lane.status === 'backoff' && <BackoffText lane={lane} />}
      {lane.status === 'dead' && `stopped — ${lane.lastReason ?? 'error'}`}
    </span>
  )
}

function PollingText({ lane }: { lane: VideoLaneState }) {
  const elapsed = useElapsed(lane.phaseStartedAt)
  return <span>generating… {elapsed !== null ? formatElapsed(elapsed) : ''}</span>
}

function BackoffText({ lane }: { lane: VideoLaneState }) {
  const seconds = useCountdown(lane.backoffUntil)
  return (
    <span className="text-amber-400">
      {lane.lastReason ?? 'Rate limited'} — retrying{seconds !== null ? ` in ${seconds}s` : '…'}
    </span>
  )
}

function ProgressBar({ runState, isRunning }: { runState: VideoRunState; isRunning: boolean }) {
  if (runState.status === 'idle') return null
  const pct = runState.target > 0 ? Math.min(100, (runState.collected / runState.target) * 100) : 0
  return (
    <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
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

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function useElapsed(since: number | null): number | null {
  const [seconds, setSeconds] = useState<number | null>(null)
  useEffect(() => {
    if (since === null) return
    const update = () => setSeconds(Math.max(0, Math.floor((Date.now() - since) / 1000)))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [since])
  return since === null ? null : seconds
}

function useCountdown(until: number | null): number | null {
  const [seconds, setSeconds] = useState<number | null>(null)
  useEffect(() => {
    if (until === null) return
    const update = () => setSeconds(Math.max(0, Math.ceil((until - Date.now()) / 1000)))
    update()
    const timer = setInterval(update, 100)
    return () => clearInterval(timer)
  }, [until])
  return until === null ? null : seconds
}
