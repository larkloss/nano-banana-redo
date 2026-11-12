import type { GeneratedImage } from '../types'
import type { EditMark } from './annotate'
import { getModel } from './models'

// "Only around the arrows" pastes part of the answer back into the picture,
// so the answer has to come back in the picture's own shape. Image models
// only answer in a fixed set of shapes, though (1:1, 3:4, 16:9, …) — fine for
// pictures they made themselves, not for an uploaded photo or screenshot of
// any shape. Such a picture is sent inside a frame: padded out, centred, to
// the nearest shape the model can answer in, and the answer is cropped back
// to where the picture sat.

// How far a picture may be from a model's shape and still go as it is (the
// compositor takes up a difference this small as a slight stretch)
const FIT_TOLERANCE = 0.03

export interface Frame {
  // The padded picture, as sent
  blob: Blob
  width: number
  height: number
  // Where the real picture sits inside it
  left: number
  top: number
  innerWidth: number
  innerHeight: number
  // The model's name for the frame's shape, e.g. "16:9"
  ratio: string
}

// The shape to pad a width×height picture out to for this model, or null
// when the model can answer in the picture's own shape
export function frameShape(modelId: string, width: number, height: number): { ratio: string; value: number } | null {
  const model = getModel(modelId)
  const shape = width / height
  if (model.provider === 'openai') {
    // GPT Image takes any size between 1:3 and 3:1
    if (shape > 3) return { ratio: '3:1', value: 3 }
    if (shape < 1 / 3) return { ratio: '1:3', value: 1 / 3 }
    return null
  }
  let best: { ratio: string; value: number } | null = null
  for (const ratio of model.aspectRatios) {
    const [w, h] = ratio.split(':').map(Number)
    if (!(w > 0 && h > 0)) continue
    const value = w / h
    if (!best || Math.abs(Math.log(value / shape)) < Math.abs(Math.log(best.value / shape))) best = { ratio, value }
  }
  if (!best || Math.abs(best.value / shape - 1) <= FIT_TOLERANCE) return null
  return best
}

export async function frameForModel(image: GeneratedImage, modelId: string): Promise<Frame | null> {
  const shape = frameShape(modelId, image.width, image.height)
  if (!shape) return null
  const wider = shape.value > image.width / image.height
  const width = wider ? Math.round(image.height * shape.value) : image.width
  const height = wider ? image.height : Math.round(image.width / shape.value)
  const left = Math.floor((width - image.width) / 2)
  const top = Math.floor((height - image.height) / 2)

  const bitmap = await createImageBitmap(image.blob)
  try {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    // The padding continues the picture as its own mirror image, so the
    // model sees plausible surroundings rather than a hard border (a
    // stretched copy underneath covers whatever the mirrors don't reach)
    ctx.drawImage(bitmap, 0, 0, width, height)
    const mirror = (x: number, y: number, flipX: boolean) => {
      ctx.save()
      ctx.translate(x, y)
      ctx.scale(flipX ? -1 : 1, flipX ? 1 : -1)
      ctx.drawImage(bitmap, 0, 0, image.width, image.height)
      ctx.restore()
    }
    if (wider) {
      mirror(left, 0, true)
      mirror(left + 2 * image.width, 0, true)
    } else {
      mirror(0, top, false)
      mirror(0, top + 2 * image.height, false)
    }
    ctx.drawImage(bitmap, left, top, image.width, image.height)
    const blob = await canvas.convertToBlob(
      image.format === 'jpg' ? { type: 'image/jpeg', quality: 0.95 } : { type: 'image/png' },
    )
    return { blob, width, height, left, top, innerWidth: image.width, innerHeight: image.height, ratio: shape.ratio }
  } finally {
    bitmap.close()
  }
}

// The part of an answer to a framed picture that is the picture itself
export async function cropFromFrame(answer: Blob, frame: Frame): Promise<Blob> {
  const bitmap = await createImageBitmap(answer)
  try {
    const kx = bitmap.width / frame.width
    const ky = bitmap.height / frame.height
    const width = Math.max(1, Math.round(frame.innerWidth * kx))
    const height = Math.max(1, Math.round(frame.innerHeight * ky))
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, frame.left * kx, frame.top * ky, frame.innerWidth * kx, frame.innerHeight * ky, 0, 0, width, height)
    return await canvas.convertToBlob({ type: 'image/png' })
  } finally {
    bitmap.close()
  }
}

// Arrow positions as they fall in the framed picture
export function marksInFrame(marks: EditMark[], frame: Frame): EditMark[] {
  return marks.map((mark) => ({
    ...mark,
    x: (frame.left + mark.x * frame.innerWidth) / frame.width,
    y: (frame.top + mark.y * frame.innerHeight) / frame.height,
  }))
}
