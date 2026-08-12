import type { ParsedImagePart, ParsedResponse, Settings } from '../types'
import type { GenerateCaller } from './gemini'
import { base64ToBlob } from './imageUtils'
import { isModerationMessage } from './errors'

const GENERATE_ENDPOINT = 'https://api.x.ai/v1/images/generations'
const EDIT_ENDPOINT = 'https://api.x.ai/v1/images/edits'
// xAI accepts jpg/jpeg and png source images only
const XAI_INPUT_TYPES = new Set(['image/png', 'image/jpeg'])
// Documented ceiling for multi-image editing
export const MAX_XAI_SOURCES = 3

// The dropdown preset can be overridden by a typed model ID so a newly
// released xAI model works without a code change.
export function effectiveXaiModelId(settings: Settings): string {
  return settings.xaiModelId.trim() || settings.modelId
}

// The quality parameter is documented as 2.0-only, so it is keyed off the
// model ID actually being sent (which may come from the override field).
export function supportsXaiQuality(modelId: string): boolean {
  return /image-2(?:[.\-_]|$)/i.test(modelId)
}

// Asks the account itself which models it can use, so a model released after
// this app was built can be selected without knowing its ID in advance.
// Tries the image-specific listing first, then the generic one.
export async function listXaiModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const endpoints = ['https://api.x.ai/v1/image-generation-models', 'https://api.x.ai/v1/models']
  const ids = new Set<string>()
  let lastError: Error | null = null

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}` }, signal })
      if (!res.ok) {
        lastError = new Error(`${res.status} ${truncate(await res.text().catch(() => ''), 200)}`)
        continue
      }
      extractModelIds(await res.json()).forEach((id) => ids.add(id))
      // The image-specific endpoint is authoritative when it answers
      if (ids.size > 0) return [...ids].sort()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  if (ids.size === 0 && lastError) throw lastError
  return [...ids].sort()
}

function extractModelIds(json: unknown): string[] {
  const root = json as { data?: unknown; models?: unknown }
  const rows = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : []
  return rows
    .map((row) => {
      if (typeof row === 'string') return row
      const r = row as { id?: unknown; name?: unknown }
      return typeof r?.id === 'string' ? r.id : typeof r?.name === 'string' ? r.name : null
    })
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

export const callGenerateXai: GenerateCaller = async ({ apiKey, settings, references }, signal) => {
  const modelId = effectiveXaiModelId(settings)
  const base = {
    model: modelId,
    prompt: settings.prompt,
    response_format: 'b64_json',
    resolution: settings.xaiResolution,
    ...(supportsXaiQuality(modelId) ? { quality: settings.xaiQuality } : {}),
  }
  // "Auto" means "let the default apply": the model picks a ratio when
  // generating, and edits keep the (first) source image's ratio.
  const ratioOverride = settings.aspectRatio === 'auto' ? {} : { aspect_ratio: settings.aspectRatio }
  const sources = await Promise.all(references.slice(0, MAX_XAI_SOURCES).map(normalizeSource))
  const part = (ref: ParsedImagePart) => ({
    url: `data:${ref.mimeType};base64,${ref.base64}`,
    type: 'image_url',
  })

  if (sources.length === 0) {
    return post(GENERATE_ENDPOINT, { ...base, n: 1, aspect_ratio: settings.aspectRatio }, apiKey, signal)
  }

  const singleBody = { ...base, ...ratioOverride, image: part(sources[0]) }
  if (sources.length === 1) return post(EDIT_ENDPOINT, singleBody, apiKey, signal)

  try {
    return await post(EDIT_ENDPOINT, { ...base, ...ratioOverride, images: sources.map(part) }, apiKey, signal)
  } catch (err) {
    // Multi-source editing is documented separately from the single-image
    // form; if this shape is rejected, still produce an image from the first
    // reference rather than failing the attempt. Moderation and auth errors
    // must propagate — retrying them would just bill twice.
    if (!isRejectedRequestShape(err)) throw err
    return post(EDIT_ENDPOINT, singleBody, apiKey, signal)
  }
}

async function post(
  endpoint: string,
  body: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal,
): Promise<ParsedResponse> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    // A browser cannot tell a CORS rejection from an offline connection —
    // both surface as the same opaque failure. Treated as fatal (not retried)
    // because hammering a blocked endpoint six times helps nobody.
    throw new Error(
      'The browser could not reach api.x.ai. Most likely xAI does not allow direct browser calls (CORS) ' +
        'from this page, in which case the request has to go through a server. Check the browser console for details.',
      { cause: err },
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw Object.assign(new Error(`xAI ${response.status}: ${truncate(detail, 300)}`), {
      status: response.status,
    })
  }

  const json = (await response.json()) as XaiImageResponse
  const entries = Array.isArray(json.data) ? json.data : []
  const images: ParsedImagePart[] = []
  for (const entry of entries) {
    const parsed = await toImagePart(entry, signal)
    if (parsed) images.push(parsed)
  }

  return {
    images,
    finishReason: images.length > 0 ? 'STOP' : undefined,
    text: images.length === 0 ? describeEmpty(json) : undefined,
  }
}

// True only for "the server didn't understand this request body" — never for
// moderation, auth or rate limits.
function isRejectedRequestShape(err: unknown): boolean {
  const status = err && typeof err === 'object' && 'status' in err ? (err as { status?: unknown }).status : undefined
  if (status !== 400 && status !== 404 && status !== 422) return false
  return !isModerationMessage(err instanceof Error ? err.message : String(err))
}

interface XaiImageEntry {
  b64_json?: string
  url?: string
  revised_prompt?: string
}

interface XaiImageResponse {
  data?: XaiImageEntry[]
  error?: { message?: string }
}

// Re-encodes anything that isn't png/jpeg (e.g. a dropped webp) so the API
// doesn't reject an otherwise valid reference image.
async function normalizeSource(ref: ParsedImagePart): Promise<ParsedImagePart> {
  if (XAI_INPUT_TYPES.has(ref.mimeType)) return ref
  const bitmap = await createImageBitmap(base64ToBlob(ref.base64, ref.mimeType))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return { base64: await blobToBase64(blob), mimeType: 'image/png' }
}

async function toImagePart(entry: XaiImageEntry, signal: AbortSignal): Promise<ParsedImagePart | null> {
  if (typeof entry.b64_json === 'string' && entry.b64_json) {
    // Docs return raw base64, but tolerate a data: URI wrapper
    const match = entry.b64_json.match(/^data:([^;]+);base64,(.*)$/)
    const base64 = match ? match[2] : entry.b64_json
    return { base64, mimeType: match ? match[1] : sniffMimeType(base64) }
  }
  // Fallback if a model ignores response_format and returns a temporary URL
  if (typeof entry.url === 'string' && entry.url) {
    const res = await fetch(entry.url, { signal })
    if (!res.ok) return null
    const blob = await res.blob()
    return { base64: await blobToBase64(blob), mimeType: blob.type || 'image/jpeg' }
  }
  return null
}

function sniffMimeType(base64: string): string {
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return 'image/jpeg'
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function describeEmpty(json: XaiImageResponse): string {
  return json.error?.message ?? 'xAI returned no image (possibly filtered by moderation)'
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
