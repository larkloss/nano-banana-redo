import type { VideoResult } from '../types'
import type { VideoCaller } from './veo'

// Dev-only fake caller (enable with ?mock=1) that exercises every outcome the
// video engine must handle — including the multi-phase submit/poll/download
// flow — without spending real Veo quota. Mock "videos" are 2-second webm
// clips recorded from an animated canvas, so the whole blob/objectURL/download
// pipeline runs for real.
let step = 0

export const mockCallGenerateVideo: VideoCaller = async (_params, signal, onPhase) => {
  onPhase('submitting')
  await sleep(600, signal)
  throwIfAborted(signal)

  const current = step % 4
  step += 1

  if (current === 2) {
    throw Object.assign(new Error('mock rate limit {"retryDelay": "2s"}'), { status: 429 })
  }

  onPhase('polling')
  await sleep(2500, signal)
  throwIfAborted(signal)

  if (current === 1) {
    return { kind: 'filtered', reason: 'Filtered by safety: mock RAI reason' }
  }

  onPhase('downloading')
  const blob = await recordMockClip(signal)
  throwIfAborted(signal)
  return { kind: 'video', blob, mimeType: blob.type || 'video/webm' } satisfies VideoResult
}

let clipHue = 200

async function recordMockClip(signal: AbortSignal): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const ctx = canvas.getContext('2d')!
  clipHue = (clipHue + 67) % 360

  const stream = canvas.captureStream(30)
  const recorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => chunks.push(e.data)
  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }))
  })
  recorder.start()

  const startedAt = performance.now()
  await new Promise<void>((resolve) => {
    const frame = (now: number) => {
      const t = (now - startedAt) / 1000
      ctx.fillStyle = `hsl(${clipHue}, 45%, 18%)`
      ctx.fillRect(0, 0, 640, 360)
      ctx.fillStyle = `hsl(${(clipHue + 40) % 360}, 70%, 60%)`
      ctx.beginPath()
      ctx.arc(80 + ((t * 240) % 480), 180 + Math.sin(t * 4) * 80, 36, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 44px sans-serif'
      ctx.fillText('MOCK VIDEO', 180, 190)
      if (now - startedAt < 2000 && !signal.aborted) requestAnimationFrame(frame)
      else resolve()
    }
    requestAnimationFrame(frame)
  })
  recorder.stop()
  stream.getTracks().forEach((track) => track.stop())
  return stopped
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
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
