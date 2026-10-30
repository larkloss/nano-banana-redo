import type { GenerateCaller } from './gemini'

// Gemini Omni video generation goes through the Interactions API — a different
// surface from generateContent (images) and from Veo's long-running operations.
// Generation is synchronous, so the existing retry engine drives it unchanged.

const BASE = 'https://generativelanguage.googleapis.com/v1beta'
// Inline base64 is capped around 4MB, so bigger outputs come back as a URI
// that has to be polled until the file is ACTIVE.
const INLINE_RESOLUTIONS = new Set(['360p', '720p'])
const FILE_POLL_INTERVAL_MS = 4000
const FILE_POLL_TIMEOUT_MS = 6 * 60_000

type InputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mime_type: string }

interface InteractionContent {
  type?: string
  text?: string
  data?: string
  uri?: string
  mime_type?: string
}

interface Interaction {
  id?: string
  status?: string
  steps?: { type?: string; content?: InteractionContent[] }[]
  output_video?: { data?: string; uri?: string; mime_type?: string }
  error?: { message?: string }
}

export const callGenerateOmni: GenerateCaller = async ({ apiKey, settings, references }, signal) => {
  const delivery = INLINE_RESOLUTIONS.has(settings.omniResolution) ? 'inline' : 'uri'
  const parts: InputPart[] = [
    ...references.map((r) => ({ type: 'image' as const, data: r.base64, mime_type: r.mimeType })),
    { type: 'text' as const, text: settings.prompt },
  ]

  const body: Record<string, unknown> = {
    model: settings.modelId,
    // A lone text prompt may be sent as a plain string; parts otherwise
    input: references.length === 0 ? settings.prompt : parts,
    response_format: {
      type: 'video',
      resolution: settings.omniResolution,
      delivery,
      ...(settings.aspectRatio === 'auto' ? {} : { aspect_ratio: settings.aspectRatio }),
    },
  }

  let interaction = await post<Interaction>('/interactions', body, apiKey, signal)

  // Defensive: if the service ever answers asynchronously, wait it out rather
  // than reporting an empty result
  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS
  while (interaction.status && !['completed', 'succeeded'].includes(interaction.status) && interaction.id) {
    if (interaction.status === 'failed') {
      throw new Error(interaction.error?.message ?? 'Omni reported a failed interaction')
    }
    if (Date.now() > deadline) throw new Error('Omni video generation timed out')
    await sleep(FILE_POLL_INTERVAL_MS, signal)
    throwIfAborted(signal)
    interaction = await get<Interaction>(`/interactions/${interaction.id}`, apiKey, signal)
  }

  const video = extractVideo(interaction)
  if (!video) {
    return { images: [], finishReason: 'STOP', text: describeEmpty(interaction) }
  }
  if (video.data) {
    return { images: [{ base64: video.data, mimeType: video.mimeType ?? 'video/mp4' }], finishReason: 'STOP' }
  }

  const base64 = await downloadWhenReady(video.uri!, apiKey, signal)
  return { images: [{ base64, mimeType: video.mimeType ?? 'video/mp4' }], finishReason: 'STOP' }
}

function extractVideo(interaction: Interaction): { data?: string; uri?: string; mimeType?: string } | null {
  // SDK-style convenience field first, then the raw steps array
  const convenience = interaction.output_video
  if (convenience?.data || convenience?.uri) {
    return { data: convenience.data, uri: convenience.uri, mimeType: convenience.mime_type }
  }
  for (const step of interaction.steps ?? []) {
    for (const content of step.content ?? []) {
      if (content.type === 'video' && (content.data || content.uri)) {
        return { data: content.data, uri: content.uri, mimeType: content.mime_type }
      }
    }
  }
  return null
}

// A URI result points at a Files API entry that may still be processing.
async function downloadWhenReady(uri: string, apiKey: string, signal: AbortSignal): Promise<string> {
  const fileId = uri.match(/files\/([^/:?]+)/)?.[1]
  if (!fileId) throw new Error(`Omni returned an unrecognized video URI: ${uri}`)

  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS
  for (;;) {
    throwIfAborted(signal)
    const info = await get<{ state?: string | { name?: string } }>(`/files/${fileId}`, apiKey, signal)
    const state = typeof info.state === 'string' ? info.state : info.state?.name
    if (state === 'ACTIVE') break
    if (state === 'FAILED') throw new Error('Omni video processing failed')
    if (Date.now() > deadline) throw new Error('Timed out waiting for the Omni video to finish processing')
    await sleep(FILE_POLL_INTERVAL_MS, signal)
  }

  const response = await request(`/files/${fileId}:download?alt=media`, { method: 'GET' }, apiKey, signal)
  const blob = await response.blob()
  return blobToBase64(blob)
}

async function post<T>(path: string, body: unknown, apiKey: string, signal: AbortSignal): Promise<T> {
  const response = await request(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    apiKey,
    signal,
  )
  return (await response.json()) as T
}

async function get<T>(path: string, apiKey: string, signal: AbortSignal): Promise<T> {
  const response = await request(path, { method: 'GET' }, apiKey, signal)
  return (await response.json()) as T
}

async function request(path: string, init: RequestInit, apiKey: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-goog-api-key': apiKey },
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw Object.assign(new Error(`Omni ${response.status}: ${truncate(detail, 300)}`), {
      status: response.status,
    })
  }
  return response
}

function describeEmpty(interaction: Interaction): string {
  if (interaction.error?.message) return interaction.error.message
  const thought = interaction.steps
    ?.flatMap((s) => s.content ?? [])
    .map((c) => c.text)
    .filter(Boolean)
    .join(' ')
  return thought ? `No video in response ("${truncate(thought, 120)}")` : 'No video in response'
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
