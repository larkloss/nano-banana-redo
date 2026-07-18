import { GoogleGenAI } from '@google/genai'
import type { ParsedImagePart, VideoResult, VideoSettings } from '../types'

export interface VideoGenerateParams {
  apiKey: string
  settings: VideoSettings
  // Effective prompt (assembled from modules or the simple textarea)
  prompt: string
  // inputMode 'references': up to 3 asset images; ignored otherwise
  references: ParsedImagePart[]
  // inputMode 'frames': required first frame + optional last frame
  firstFrame: ParsedImagePart | null
  lastFrame: ParsedImagePart | null
}

export type VideoPhase = 'submitting' | 'polling' | 'downloading'

export type VideoCaller = (
  params: VideoGenerateParams,
  signal: AbortSignal,
  onPhase: (phase: VideoPhase) => void,
) => Promise<VideoResult>

const POLL_INTERVAL_MS = 8000
// Veo operations normally finish in 1–6 minutes; treat anything longer as lost
const OPERATION_TIMEOUT_MS = 10 * 60_000

let cachedClient: GoogleGenAI | null = null
let cachedKey = ''

function getClient(apiKey: string): GoogleGenAI {
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new GoogleGenAI({ apiKey })
    cachedKey = apiKey
  }
  return cachedClient
}

export const callGenerateVideo: VideoCaller = async (params, signal, onPhase) => {
  const { apiKey, settings, prompt } = params
  const ai = getClient(apiKey)
  onPhase('submitting')

  const config: Record<string, unknown> = {
    numberOfVideos: 1,
    aspectRatio: settings.aspectRatio,
    resolution: settings.resolution,
    durationSeconds: settings.durationSeconds,
    generateAudio: settings.generateAudio,
    personGeneration: settings.personGeneration,
    abortSignal: signal,
  }
  if (settings.negativePrompt.trim()) config.negativePrompt = settings.negativePrompt.trim()
  if (settings.seed !== null) config.seed = settings.seed
  // Prompt rewriting defaults to ON server-side; only send an explicit opt-out
  if (!settings.enhancePrompt) config.enhancePrompt = false

  let image: { imageBytes: string; mimeType: string } | undefined
  if (settings.inputMode === 'references') {
    if (params.references.length > 0) {
      config.referenceImages = params.references.slice(0, 3).map((r) => ({
        image: { imageBytes: r.base64, mimeType: r.mimeType },
        referenceType: 'ASSET',
      }))
    }
  } else if (params.firstFrame) {
    image = { imageBytes: params.firstFrame.base64, mimeType: params.firstFrame.mimeType }
    if (params.lastFrame) {
      config.lastFrame = { imageBytes: params.lastFrame.base64, mimeType: params.lastFrame.mimeType }
    }
  }

  let operation = await ai.models.generateVideos({
    model: settings.modelId,
    prompt,
    ...(image ? { image } : {}),
    config,
  })

  onPhase('polling')
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  while (!operation.done) {
    throwIfAborted(signal)
    if (Date.now() > deadline) throw new Error('Video operation timed out after 10 minutes')
    await sleep(POLL_INTERVAL_MS, signal)
    throwIfAborted(signal)
    operation = await ai.operations.getVideosOperation({ operation })
  }

  if (operation.error) {
    const message =
      typeof operation.error.message === 'string' ? operation.error.message : JSON.stringify(operation.error)
    throw new Error(message)
  }

  const response = operation.response
  const video = response?.generatedVideos?.[0]?.video
  if (!video || (!video.uri && !video.videoBytes)) {
    const raiReasons = response?.raiMediaFilteredReasons?.join('; ')
    return {
      kind: 'filtered',
      reason: raiReasons ? `Filtered by safety: ${raiReasons}` : 'No video in response',
    }
  }

  onPhase('downloading')
  const mimeType = video.mimeType ?? 'video/mp4'
  if (video.videoBytes) {
    return { kind: 'video', blob: base64ToVideoBlob(video.videoBytes, mimeType), mimeType }
  }
  // The result URI requires the API key as a query parameter
  const url = new URL(video.uri!)
  url.searchParams.set('key', apiKey)
  const res = await fetch(url.toString(), { signal })
  if (!res.ok) {
    throw Object.assign(new Error(`Video download failed (${res.status})`), { status: res.status })
  }
  const blob = await res.blob()
  return { kind: 'video', blob, mimeType: blob.type || mimeType }
}

function base64ToVideoBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
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
