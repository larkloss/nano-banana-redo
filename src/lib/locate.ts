import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import type { EditMark } from './annotate'
import { renderGuide } from './annotate'
import type { Area, ObjectExtent } from './localEdit'
import { base64ToBlob } from './imageUtils'
import { blobToBase64 } from '../edit/lib/mask'
import { isMockMode } from './mockGemini'

// "Find the object": before an "only around arrows" edit, a Gemini model that
// understands pictures is asked where the thing each arrow points at is — all
// of it — and where the faces are. The compositor then keeps even faint
// change inside that thing (an arm that looks like the torso behind it), and
// never takes a face on the strength of it. One extra request per edit, with
// the Google key; any failure just leaves the edit as it would be without.

// The model Google's own image-understanding guide uses; any Gemini model
// that understands pictures will do (the stronger gemini-4-carbon included)
export const DEFAULT_LOCATOR_MODEL = 'gemini-4-hydrogen'
export const LOCATOR_MODELS = ['gemini-4-hydrogen', 'gemini-4-carbon']

export interface Located {
  // Per arrow, in the arrows' order
  extents: (ObjectExtent | null)[]
  labels: (string | null)[]
  // Faces
  guarded: Area[]
}

// Long side of the pictures sent: enough to tell things apart, and boxes come
// back normalised, so nothing depends on it
const LOCATE_MAX_EDGE = 1280

export async function locateObjects(
  apiKey: string,
  modelId: string,
  picture: Blob,
  marks: EditMark[],
  signal: AbortSignal,
): Promise<Located> {
  if (isMockMode()) return mockLocated(marks)

  const [plain, guide] = await Promise.all([smallCopy(picture), renderGuide(picture, marks)])
  const ai = new GoogleGenAI({ apiKey })
  const prompt = locatePrompt(marks)
  // Gemini 4 Carbon thinks at "medium" unless told otherwise, and bills every
  // thinking token; finding a box is what its guide calls a "low" job. Other
  // models are left at their defaults (not all take a thinking level).
  const quick = /carbon/i.test(modelId)
  let text: string
  try {
    // The Interactions API: what Google's image-understanding guide uses for
    // the Gemini 4 models
    const interaction = await ai.interactions.create(
      {
        model: modelId,
        input: [
          { type: 'image', data: plain.base64, mime_type: 'image/jpeg' },
          { type: 'image', data: guide.base64, mime_type: 'image/jpeg' },
          { type: 'text', text: prompt },
        ],
        response_format: { type: 'text', mime_type: 'application/json' },
        ...(quick ? { generation_config: { thinking_level: 'low' as const } } : {}),
      },
      { signal },
    )
    text = interactionText(interaction)
    if (!text.trim()) throw new Error('the model gave no answer')
  } catch (first) {
    if (signal.aborted) throw first
    // Models that are only served the older way
    try {
      const response = await ai.models.generateContent({
        model: modelId,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: plain.mimeType, data: plain.base64 } },
              { inlineData: { mimeType: guide.mimeType, data: guide.base64 } },
              { text: prompt },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          ...(quick ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
          abortSignal: signal,
        },
      })
      text = (response.candidates?.[0]?.content?.parts ?? [])
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('')
    } catch {
      // Neither way worked: the first failure is the one worth reporting
      throw first
    }
  }
  return parseLocated(text, marks.length)
}

// The answer's text: as the SDK sums it up, or read from the answer's own
// parts (whose layout has changed between revisions of the API)
function interactionText(interaction: unknown): string {
  if (!isRecord(interaction)) return ''
  if (typeof interaction.output_text === 'string' && interaction.output_text.trim()) return interaction.output_text
  const texts: string[] = []
  const collect = (content: unknown) => {
    if (!Array.isArray(content)) return
    for (const item of content) if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
  }
  collect(interaction.outputs)
  if (Array.isArray(interaction.steps))
    for (const step of interaction.steps) if (isRecord(step) && step.type !== 'user_input') collect(step.content)
  return texts.join('')
}

function locatePrompt(marks: EditMark[]): string {
  return [
    'You are given two images. Image 1 is a picture. Image 2 is the same picture with numbered, coloured arrows ' +
      'drawn on it; the arrows are only pointers and are not part of the picture.',
    'At each arrow the user wants something changed:',
    ...marks.map((m, i) => `${i + 1}: ${m.text}`),
    'For each arrow, find in image 1 the whole thing that instruction is about and that the arrow’s tip points at: ' +
      'the complete object, garment or body part — all of it, also where it looks like what is behind it. ' +
      'Then find every human face in image 1.',
    'Answer with JSON only, in this form: ' +
      '{"objects":[{"arrow":1,"label":"a few words","box_2d":[ymin,xmin,ymax,xmax]}],' +
      '"faces":[{"box_2d":[ymin,xmin,ymax,xmax]}]}. ' +
      'Coordinates are normalised to 0-1000 over image 1. If you can, also give each object a "mask": a base64 PNG ' +
      'segmentation mask of the thing within its box. One entry per arrow; leave out an arrow whose thing you ' +
      'cannot find. "faces" is an empty list if there are none.',
  ].join('\n')
}

// Exported for tests. Anything that isn't a usable box is dropped rather
// than guessed at.
export function parseLocated(text: string, arrows: number): Located {
  const raw = parseJson(text)
  const extents: (ObjectExtent | null)[] = Array.from({ length: arrows }, () => null)
  const labels: (string | null)[] = Array.from({ length: arrows }, () => null)
  const objects = isRecord(raw) && Array.isArray(raw.objects) ? raw.objects : []
  for (const entry of objects) {
    if (!isRecord(entry)) continue
    const index = typeof entry.arrow === 'number' ? Math.round(entry.arrow) - 1 : -1
    const box = toArea(entry.box_2d)
    if (index < 0 || index >= arrows || !box || extents[index]) continue
    const mask = typeof entry.mask === 'string' ? toMask(entry.mask) : undefined
    extents[index] = mask ? { box, mask } : { box }
    labels[index] = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 40) : null
  }
  const faces = isRecord(raw) && Array.isArray(raw.faces) ? raw.faces : []
  const guarded = faces
    .map((f) => (isRecord(f) ? toArea(f.box_2d) : null))
    .filter((a): a is Area => a !== null)
    .slice(0, 12)
  return { extents, labels, guarded }
}

// The JSON in an answer: as it is, inside a ``` fence, or with words around it
function parseJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const candidates = [trimmed]
  const from = trimmed.indexOf('{')
  const to = trimmed.lastIndexOf('}')
  if (from >= 0 && to > from) candidates.push(trimmed.slice(from, to + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next reading
    }
  }
  throw new Error('the answer was not readable')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// [ymin, xmin, ymax, xmax] on 0–1000 → fractions of the picture
function toArea(value: unknown): Area | null {
  if (!Array.isArray(value) || value.length !== 4 || value.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
    return null
  const [ya, xa, yb, xb] = (value as number[]).map((v) => Math.min(1, Math.max(0, v / 1000)))
  const area = { x0: Math.min(xa, xb), y0: Math.min(ya, yb), x1: Math.max(xa, xb), y1: Math.max(ya, yb) }
  return area.x1 - area.x0 > 0.005 && area.y1 - area.y0 > 0.005 ? area : null
}

function toMask(value: string): Blob | undefined {
  const base64 = value.replace(/^data:image\/[a-z+]+;base64,/i, '').replace(/\s+/g, '')
  if (base64.length < 40 || !/^[A-Za-z0-9+/]+=*$/.test(base64)) return undefined
  try {
    return base64ToBlob(base64, 'image/png')
  } catch {
    return undefined
  }
}

async function smallCopy(picture: Blob): Promise<{ base64: string; mimeType: string }> {
  const bitmap = await createImageBitmap(picture)
  const scale = Math.min(1, LOCATE_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 })
  return { base64: await blobToBase64(blob), mimeType: 'image/jpeg' }
}

// Dev-only (?mock=1): a box around each arrow, no faces
function mockLocated(marks: EditMark[]): Located {
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return {
    extents: marks.map((m) => ({
      box: { x0: clamp(m.x - 0.18), y0: clamp(m.y - 0.18), x1: clamp(m.x + 0.18), y1: clamp(m.y + 0.18) },
    })),
    labels: marks.map(() => 'mock object'),
    guarded: [],
  }
}
