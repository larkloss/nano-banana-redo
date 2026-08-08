import type { ParsedImagePart, Settings } from '../types'
import type { GenerateCaller } from './gemini'

const ENDPOINT = 'https://api.x.ai/v1/images/generations'

// The dropdown preset can be overridden by a typed model ID so a newly
// released xAI model works without a code change.
export function effectiveXaiModelId(settings: Settings): string {
  return settings.xaiModelId.trim() || settings.modelId
}

export const callGenerateXai: GenerateCaller = async ({ apiKey, settings }, signal) => {
  const body = {
    model: effectiveXaiModelId(settings),
    prompt: settings.prompt,
    n: 1,
    response_format: 'b64_json',
    aspect_ratio: settings.aspectRatio,
    resolution: settings.xaiResolution,
  }

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
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

interface XaiImageEntry {
  b64_json?: string
  url?: string
  revised_prompt?: string
}

interface XaiImageResponse {
  data?: XaiImageEntry[]
  error?: { message?: string }
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
