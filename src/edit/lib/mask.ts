import type { Shape } from '../types'

// Mask lives in the ALPHA channel: transparent background, opaque white fills.
// Overlapping shapes union automatically.
export function rasterizeAlphaMask(shapes: Shape[], width: number, height: number, scale = 1): OffscreenCanvas {
  const canvas = new OffscreenCanvas(Math.round(width), Math.round(height))
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.fillStyle = '#ffffff'
  for (const shape of shapes) {
    ctx.beginPath()
    tracePath(ctx, shape)
    ctx.fill()
  }
  return canvas
}

export function tracePath(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, shape: Shape): void {
  if (shape.kind === 'rect') {
    const x = Math.min(shape.x0, shape.x1)
    const y = Math.min(shape.y0, shape.y1)
    ctx.rect(x, y, Math.abs(shape.x1 - shape.x0), Math.abs(shape.y1 - shape.y0))
  } else if (shape.kind === 'ellipse') {
    ctx.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, Math.PI * 2)
  } else {
    // lasso and polygon: closed point path
    const [first, ...rest] = shape.points
    if (!first) return
    ctx.moveTo(first.x, first.y)
    for (const p of rest) ctx.lineTo(p.x, p.y)
    ctx.closePath()
  }
}

// Black/white PNG (white = edit region) sent to the model as the mask part.
export async function maskToBWPngBase64(alphaMask: OffscreenCanvas): Promise<string> {
  const canvas = new OffscreenCanvas(alphaMask.width, alphaMask.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(alphaMask, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return blobToBase64(blob)
}

// Feather that ramps alpha INWARD only: blur the mask, then intersect with the
// binary mask (destination-in keys on alpha). Outside the selection alpha stays
// exactly 0, so composited pixels outside the region are bit-identical to the
// original.
export function featherAlphaInward(alphaMask: OffscreenCanvas, featherPx: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(alphaMask.width, alphaMask.height)
  const ctx = canvas.getContext('2d')!
  if (featherPx > 0 && supportsCanvasFilter(ctx)) {
    ctx.filter = `blur(${featherPx}px)`
    ctx.drawImage(alphaMask, 0, 0)
    ctx.filter = 'none'
  } else {
    ctx.drawImage(alphaMask, 0, 0)
  }
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(alphaMask, 0, 0)
  return canvas
}

function supportsCanvasFilter(ctx: OffscreenCanvasRenderingContext2D): boolean {
  return typeof ctx.filter === 'string'
}

// Fraction of pixels selected (0..1); Run is disabled at 0.
export function maskCoverage(alphaMask: OffscreenCanvas): number {
  // Sample at reduced resolution — we only need "is anything selected" + rough size
  const w = Math.max(1, Math.min(256, alphaMask.width))
  const h = Math.max(1, Math.round((alphaMask.height / alphaMask.width) * w))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(alphaMask, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  let sum = 0
  for (let i = 3; i < data.length; i += 4) sum += data[i] > 127 ? 1 : 0
  return sum / (w * h)
}

// Binary outside/inside lookup at an analysis resolution, for align + no-op checks.
export function maskBitsAt(alphaMask: OffscreenCanvas, w: number, h: number): Uint8Array {
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(alphaMask, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const bits = new Uint8Array(w * h)
  for (let i = 0; i < bits.length; i++) bits[i] = data[i * 4 + 3] > 127 ? 1 : 0
  return bits
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
