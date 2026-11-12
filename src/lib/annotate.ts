import type { ParsedImagePart } from '../types'
import { mentionedNumbers, nameMentions } from './mentions'

// ---------------------------------------------------------------------------
// Marked edits: the user pins spots (or drags boxes) on the picture and gives
// each its own instruction. Models can't take coordinates reliably on their
// own, so the request carries a second "guide" image — the same picture with
// numbered, colour-coded marks drawn on — and a prompt that refers to each
// mark by number, colour and rough position. The guide is only a reference;
// the prompt insists the result is a clean edit of the original.
// ---------------------------------------------------------------------------

export interface EditMark {
  id: string
  // The spot the arrow points at, normalised 0–1 within the picture
  x: number
  y: number
  text: string
}

export const MARK_COLORS = [
  { css: '#ff2d55', name: 'red' },
  { css: '#0a84ff', name: 'blue' },
  { css: '#30d158', name: 'green' },
  { css: '#ff9f0a', name: 'orange' },
  { css: '#bf5af2', name: 'purple' },
  { css: '#00c7be', name: 'teal' },
] as const

export const MAX_MARKS = MARK_COLORS.length

export function markColor(index: number) {
  return MARK_COLORS[index % MARK_COLORS.length]
}

// Each arrow comes in from the side facing the picture's centre, so it never
// runs off the edge. Returns the tail (where the number sits), normalised.
// `aspect` is width / height of the picture.
export function arrowTail(mark: { x: number; y: number }, aspect: number): { x: number; y: number } {
  // Work in a square space so the arrow has the same length on any ratio
  const px = mark.x * aspect
  const py = mark.y
  let dx = 0.5 * aspect - px
  let dy = 0.5 - py
  const len = Math.hypot(dx, dy)
  if (len < 0.05) {
    // Near the centre: come in from the upper right
    dx = 0.7
    dy = -0.7
  } else {
    dx /= len
    dy /= len
  }
  const L = 0.16 * Math.min(1, aspect)
  return { x: (px + dx * L) / aspect, y: py + dy * L }
}

// Quick instructions for a mark
export const MARK_ACTIONS = [
  { key: 'remove', label: 'Remove', text: 'Remove this and fill the area in naturally' },
  { key: 'position', label: 'Position', text: 'This is in the wrong place — move it ' },
  { key: 'pose', label: 'Pose', text: 'Change the pose: ' },
  { key: 'color', label: 'Color', text: 'Change the color to ' },
  { key: 'fix', label: 'Fix', text: 'Fix this so it looks natural and correct' },
] as const

// ---------------------------------------------------------------------------
// Guide image
// ---------------------------------------------------------------------------

// The guide only has to show where things are, so it is capped in size and
// sent as a JPEG to keep the request small
const GUIDE_MAX_EDGE = 1600

export async function renderGuide(source: Blob, marks: EditMark[]): Promise<ParsedImagePart & { blob: Blob }> {
  const bitmap = await createImageBitmap(source)
  const scale = Math.min(1, GUIDE_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const W = Math.round(bitmap.width * scale)
  const H = Math.round(bitmap.height * scale)
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, W, H)
  bitmap.close()

  const unit = Math.min(W, H)
  const line = Math.max(3, unit * 0.008)
  const fontSize = Math.max(16, unit * 0.04)
  marks.forEach((mark, i) => drawMark(ctx, mark, i, W, H, unit, line, fontSize))

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  return { blob, mimeType: 'image/jpeg', base64: await blobToBase64(blob) }
}

function drawMark(
  ctx: OffscreenCanvasRenderingContext2D,
  mark: EditMark,
  index: number,
  W: number,
  H: number,
  unit: number,
  line: number,
  fontSize: number,
): void {
  const color = markColor(index).css
  const tail = arrowTail(mark, W / H)
  const tx = mark.x * W
  const ty = mark.y * H
  const sx = tail.x * W
  const sy = tail.y * H
  const angle = Math.atan2(ty - sy, tx - sx)
  const head = Math.max(14, unit * 0.035)

  // Shaft and head, with a dark halo so the arrow reads on any background
  const path = () => {
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(tx - Math.cos(angle) * head * 0.6, ty - Math.sin(angle) * head * 0.6)
  }
  ctx.save()
  ctx.lineCap = 'round'
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'
  ctx.lineWidth = line + 3
  path()
  ctx.stroke()
  ctx.strokeStyle = color
  ctx.lineWidth = line
  path()
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(tx, ty)
  ctx.lineTo(tx - head * Math.cos(angle - 0.42), ty - head * Math.sin(angle - 0.42))
  ctx.lineTo(tx - head * Math.cos(angle + 0.42), ty - head * Math.sin(angle + 0.42))
  ctx.closePath()
  ctx.fillStyle = color
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'
  ctx.lineWidth = 1.5
  ctx.fill()
  ctx.stroke()

  // Number tag at the tail
  const tagR = fontSize * 0.75
  const px = Math.min(Math.max(sx, tagR + 2), W - tagR - 2)
  const py = Math.min(Math.max(sy, tagR + 2), H - tagR - 2)
  ctx.beginPath()
  ctx.arc(px, py, tagR, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${Math.round(fontSize)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(index + 1), px, py + 1)
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

// Builds the edit instruction. Image order in the request: the picture to
// edit, then (with marks) the guide, then any reference photos. "@2" in an
// instruction points at reference photo 2, which the prompt ties to its place
// among the attached images.
export function buildEditPrompt(text: string, marks: EditMark[], referenceCount: number): string {
  const firstReference = marks.length > 0 ? 3 : 2
  const texts = [text, ...marks.map((m) => m.text)]
  const pointed = texts.some((t) => mentionedNumbers(t).some((n) => n <= referenceCount))
  // A mention of a photo that isn't attached still reads as plain words
  const named = (t: string) =>
    nameMentions(t.trim(), 99, (n) =>
      n <= referenceCount ? `reference photo ${n} (image ${firstReference + n - 1})` : `reference photo ${n}`,
    )
  const numbering = pointed
    ? ` They are numbered in the order attached: ${Array.from(
        { length: referenceCount },
        (_, i) => `reference photo ${i + 1} is image ${firstReference + i}`,
      ).join(', ')}.`
    : ''
  const use = pointed
    ? ' Use them the way the instructions say; apart from that, only to keep the character’s face and likeness consistent.'
    : " Use them only to keep the character's face and likeness consistent"
  const general = named(text)
  if (marks.length === 0) {
    if (referenceCount === 0) return general
    return (
      `Edit the first image: ${general}\n\nThe other images are reference photos of the same character.` +
      numbering +
      (pointed ? `${use} Change` : `${use}; change`) +
      " nothing else that wasn't asked for."
    )
  }

  const lines = marks.map((mark, i) => `${i + 1} — ${describeMark(mark, i)}: ${named(mark.text)}`)
  const refNote =
    referenceCount > 0
      ? `\nThe images after the second are reference photos of the same character.${numbering}${use}${pointed ? '' : '.'}`
      : ''
  return [
    'Edit the first image.',
    'The second image is the same picture with numbered, coloured arrows. Each arrow points at the exact thing ' +
      'a change is about. It is only a guide: the result must be a clean edit of the first image, with no ' +
      'arrows, numbers or marks drawn on it.' +
      refNote,
    '',
    'Changes:',
    ...lines,
    ...(general ? ['', `Also: ${general}`] : []),
    '',
    'Change only what is listed. Keep everything else exactly as it is — the same person, face, outfit, ' +
      'background, lighting and framing.',
  ].join('\n')
}

// The same request for when only the picture itself can be sent (no guide
// image): each spot is described by position alone
export function buildSingleSourcePrompt(text: string, marks: EditMark[]): string {
  // No reference photo travels with this one: a mention is just words
  const plain = (t: string) => nameMentions(t.trim(), 99, (n) => `reference photo ${n}`)
  const general = plain(text)
  const lines = marks.map(
    (mark, i) =>
      `${i + 1} — the thing at ${region(mark.x, mark.y)}, about ${pct(mark.x)} from the left and ` +
      `${pct(mark.y)} from the top: ${plain(mark.text)}`,
  )
  return [
    'Edit this image. Changes:',
    ...lines,
    ...(general ? ['', `Also: ${general}`] : []),
    '',
    'Change only what is listed. Keep everything else exactly as it is — the same person, face, outfit, ' +
      'background, lighting and framing.',
  ].join('\n')
}

function describeMark(mark: EditMark, index: number): string {
  const color = markColor(index).name
  return (
    `what the ${color} arrow numbered ${index + 1} points at (${region(mark.x, mark.y)}, about ` +
    `${pct(mark.x)} from the left and ${pct(mark.y)} from the top)`
  )
}

function region(x: number, y: number): string {
  const v = y < 1 / 3 ? 'top' : y > 2 / 3 ? 'bottom' : 'middle'
  const h = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center'
  if (v === 'middle' && h === 'center') return 'center'
  if (v === 'middle') return `middle ${h}`
  return h === 'center' ? `${v} center` : `${v} ${h}`
}

function pct(n: number): string {
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`
}

// A one-line summary of a marked turn, for tooltips and gallery badges
export function summarizeEdit(text: string, marks: EditMark[]): string {
  const parts = marks.map((m, i) => `${i + 1}: ${m.text.trim()}`)
  if (text.trim()) parts.push(text.trim())
  return parts.join(' · ')
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
