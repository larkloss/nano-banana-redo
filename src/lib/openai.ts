import type { ParsedImagePart, ParsedResponse, Settings } from '../types'
import type { GenerateCaller } from './gemini'
import { base64ToBlob } from './imageUtils'

// OpenAI GPT Image models. Text-to-image is a JSON POST; anything with
// reference images goes through the edits endpoint as multipart/form-data
// (the API insists on real file parts there). Both always answer with
// base64 in data[].b64_json — there is no URL mode for GPT Image models.

const GENERATE_ENDPOINT = 'https://api.openai.com/v1/images/generations'
const EDIT_ENDPOINT = 'https://api.openai.com/v1/images/edits'
const MODELS_ENDPOINT = 'https://api.openai.com/v1/models'
// Documented ceiling for source images on the edits endpoint
export const MAX_OPENAI_SOURCES = 16

// GPT Image 2+ accepts any WIDTHxHEIGHT with both sides divisible by 16 and an
// aspect ratio between 1:3 and 3:1, so the app's ratio chips map to concrete
// sizes at roughly 1.3–1.7 MP (the model's standard tier).
const RATIO_SIZES: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '4:3': '1536x1152',
  '3:4': '1152x1536',
  '16:9': '1536x864',
  '9:16': '864x1536',
  '21:9': '2016x864',
}

export function openaiSizeFor(aspectRatio: string): string {
  return aspectRatio === 'auto' ? 'auto' : (RATIO_SIZES[aspectRatio] ?? 'auto')
}

// Same override field as xAI: a typed model ID beats the dropdown preset, so a
// model whose exact ID isn't in the presets yet can still be used.
export function effectiveOpenaiModelId(settings: Settings): string {
  return settings.xaiModelId.trim() || settings.modelId
}

export const callGenerateOpenai: GenerateCaller = async ({ apiKey, settings, references }, signal) => {
  const outputFormat = settings.format === 'jpg' ? 'jpeg' : 'png'
  const common: Record<string, string | number> = {
    model: effectiveOpenaiModelId(settings),
    prompt: settings.prompt,
    n: 1,
    size: openaiSizeFor(settings.aspectRatio),
    quality: settings.openaiQuality,
    output_format: outputFormat,
  }

  let response: Response
  if (references.length === 0) {
    // moderation is a generations-only parameter
    response = await send(
      GENERATE_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ ...common, moderation: settings.openaiModeration }),
      },
      signal,
    )
  } else {
    const form = new FormData()
    for (const [key, value] of Object.entries(common)) form.append(key, String(value))
    // High fidelity is what keeps a reference face/outfit recognizable
    form.append('input_fidelity', settings.openaiInputFidelity)
    references.slice(0, MAX_OPENAI_SOURCES).forEach((ref, i) => {
      form.append('image[]', base64ToBlob(ref.base64, ref.mimeType), `reference-${i + 1}.${extensionFor(ref.mimeType)}`)
    })
    response = await send(
      EDIT_ENDPOINT,
      { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form },
      signal,
    )
  }

  const json = (await response.json()) as OpenaiImagesResponse
  const mimeType = `image/${json.output_format ?? outputFormat}`
  const images: ParsedImagePart[] = (json.data ?? [])
    .map((entry) => entry.b64_json)
    .filter((b64): b64 is string => typeof b64 === 'string' && b64.length > 0)
    .map((base64) => ({ base64, mimeType }))

  return {
    images,
    finishReason: images.length > 0 ? 'STOP' : undefined,
    text: images.length === 0 ? 'OpenAI returned no image' : undefined,
  } satisfies ParsedResponse
}

// Asks the account which models it can use — the reliable way to learn the
// exact ID of a model released after this app was built.
export async function listOpenaiModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const response = await send(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${apiKey}` } }, signal ?? new AbortController().signal)
  const json = (await response.json()) as { data?: { id?: unknown }[] }
  return (json.data ?? [])
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .sort()
}

interface OpenaiImagesResponse {
  data?: { b64_json?: string; revised_prompt?: string }[]
  output_format?: 'png' | 'jpeg' | 'webp'
  error?: { message?: string; code?: string }
}

async function send(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    // Indistinguishable from a CORS refusal in the browser; not worth retrying
    throw new Error(
      'The browser could not reach api.openai.com. Check the connection, or — if this keeps happening — OpenAI ' +
        'may be refusing direct browser calls (CORS) from this page. See the browser console for details.',
      { cause: err },
    )
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw Object.assign(new Error(`OpenAI ${response.status}: ${truncate(detail, 300)}`), {
      status: response.status,
    })
  }
  return response
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
