import type { OpenaiQuality, OpenaiSizeTier, ParsedImagePart, ParsedResponse, Settings } from '../types'
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

// Documented size constraints for GPT Image 2 and 2.5
const MAX_EDGE = 3840
const MAX_PIXELS = 8_294_400
const MIN_PIXELS = 655_360

// OpenAI's recommended sizes for the common ratios, plus fitted sizes for the
// rest at a similar ~1.3–1.8MP budget.
const STANDARD_SIZES: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '4:3': '1536x1152',
  '3:4': '1152x1536',
  '16:9': '1536x864',
  '9:16': '864x1536',
  '21:9': '2016x864',
}

const TIER_BUDGET: Record<Exclude<OpenaiSizeTier, 'standard'>, number> = {
  '2k': 2048 * 2048,
  '4k': MAX_PIXELS, // exactly 3840x2160
}

// Fits a ratio into a pixel budget under the documented rules: both edges
// multiples of 16, neither above 3840, total pixels within bounds.
export function openaiSizeFor(aspectRatio: string, tier: OpenaiSizeTier): string {
  if (aspectRatio === 'auto') return 'auto'
  if (tier === 'standard') return STANDARD_SIZES[aspectRatio] ?? 'auto'
  const [w, h] = aspectRatio.split(':').map(Number)
  if (!w || !h) return 'auto'
  const ratio = w / h
  let height = Math.floor(Math.sqrt(TIER_BUDGET[tier] / ratio) / 16) * 16
  while (height >= 16) {
    const width = Math.round((height * ratio) / 16) * 16
    const pixels = width * height
    if (width <= MAX_EDGE && height <= MAX_EDGE && pixels <= MAX_PIXELS && pixels >= MIN_PIXELS) {
      return `${width}x${height}`
    }
    height -= 16
  }
  return STANDARD_SIZES[aspectRatio] ?? 'auto'
}

// Same override field as xAI: a typed model ID beats the dropdown preset.
export function effectiveOpenaiModelId(settings: Settings): string {
  return settings.xaiModelId.trim() || settings.modelId
}

// xhigh/max are documented for the 2.5 models only; older ones stop at high
export function supportsExtendedQuality(modelId: string): boolean {
  return /gpt-image-(?:2\.5|[3-9])/i.test(modelId)
}

function clampQuality(quality: OpenaiQuality, modelId: string): OpenaiQuality {
  if ((quality === 'xhigh' || quality === 'max') && !supportsExtendedQuality(modelId)) return 'high'
  return quality
}

export const callGenerateOpenai: GenerateCaller = async ({ apiKey, settings, references }, signal) => {
  const modelId = effectiveOpenaiModelId(settings)
  const outputFormat = settings.format === 'jpg' ? 'jpeg' : 'png'
  const common: Record<string, string | number> = {
    model: modelId,
    prompt: settings.prompt,
    n: 1,
    size: openaiSizeFor(settings.aspectRatio, settings.openaiSizeTier),
    quality: clampQuality(settings.openaiQuality, modelId),
    output_format: outputFormat,
  }

  let response: Response
  // Only text-to-image accepts the moderation parameter, so the "lower the
  // filter" tip is only worth showing there
  const canLowerFilter = references.length === 0 && settings.openaiModeration !== 'low'
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
      canLowerFilter,
    )
  } else {
    // No input_fidelity: GPT Image 2 and later process every reference at high
    // fidelity automatically and reject the parameter outright.
    const form = new FormData()
    for (const [key, value] of Object.entries(common)) form.append(key, String(value))
    references.slice(0, MAX_OPENAI_SOURCES).forEach((ref, i) => {
      form.append('image[]', base64ToBlob(ref.base64, ref.mimeType), `reference-${i + 1}.${extensionFor(ref.mimeType)}`)
    })
    response = await send(
      EDIT_ENDPOINT,
      { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form },
      signal,
      canLowerFilter,
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
}

interface OpenaiErrorBody {
  error?: {
    message?: string
    type?: string
    code?: string
    moderation_details?: { moderation_stage?: 'input' | 'output' | 'unknown'; categories?: string[] }
  }
}

async function send(url: string, init: RequestInit, signal: AbortSignal, canLowerFilter = false): Promise<Response> {
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
    throw toApiError(response.status, detail, canLowerFilter)
  }
  return response
}

// Every moderation block is a retryable attempt — the same policy as Gemini
// and xAI, and what the user asked for. OpenAI's docs suggest an input-stage
// block will repeat for identical input, but in practice the vague "other"
// category trips on harmless character art and does clear on retry, and the
// attempts cap bounds the cost. The message says which stage and category so
// a genuinely stuck run is easy to recognise.
function toApiError(status: number, detail: string, canLowerFilter: boolean): Error {
  let body: OpenaiErrorBody | null = null
  try {
    body = JSON.parse(detail) as OpenaiErrorBody
  } catch {
    // not JSON — fall through to the generic form
  }
  const err = body?.error
  if (err?.code === 'moderation_blocked') {
    const stage = err.moderation_details?.moderation_stage
    const categories = err.moderation_details?.categories?.length
      ? `, flagged: ${err.moderation_details.categories.join(', ')}`
      : ''
    const where = stage === 'input' ? 'the prompt/reference images' : stage === 'output' ? 'the generated image' : 'the request'
    const tip = canLowerFilter
      ? ' Tip: Advanced → Content filter → Low.'
      : stage === 'input'
        ? ' If every attempt fails the same way, rephrase or swap a reference image.'
        : ''
    // Contains "content moderation" so the retry classifier keeps the lane alive
    return Object.assign(new Error(`Content moderation blocked ${where} (${stage ?? 'unknown'} stage${categories}).${tip}`), {
      status,
    })
  }
  return Object.assign(new Error(`OpenAI ${status}: ${truncate(detail, 300)}`), { status })
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
