import type { OutputFormat, ParsedImagePart } from '../../types'
import { base64ToBlob } from '../../lib/imageUtils'
import { featherAlphaInward, maskBitsAt } from './mask'
import { computeCorrection, estimateNoiseSigma } from './blend'

const BLEND_WORKING_MAX = 256
const GRAIN_MAX_SIGMA = 12

// Composite the model result over the original: the result layer is scaled to
// the original size, shifted by the alignment offset, optionally tone-matched
// and seam-corrected (seamless blend), clipped by the inward-feathered mask,
// then drawn over the untouched original. Every pixel outside the selection
// comes from the original image.
export async function compositeResult(
  original: ImageBitmap,
  part: ParsedImagePart,
  alphaMask: OffscreenCanvas,
  featherPx: number,
  offset: { dx: number; dy: number },
  format: OutputFormat,
  seamless: boolean,
): Promise<Blob> {
  const W = original.width
  const H = original.height
  const result = await createImageBitmap(base64ToBlob(part.base64, part.mimeType))

  const layer = new OffscreenCanvas(W, H)
  const lctx = layer.getContext('2d')!
  lctx.imageSmoothingQuality = 'high'
  lctx.drawImage(result, 0, 0, result.width, result.height, offset.dx, offset.dy, W, H)
  result.close()

  if (seamless) applySeamlessCorrection(original, layer, alphaMask)

  lctx.globalCompositeOperation = 'destination-in'
  lctx.drawImage(featherAlphaInward(alphaMask, featherPx), 0, 0)

  const out = new OffscreenCanvas(W, H)
  const octx = out.getContext('2d')!
  octx.drawImage(original, 0, 0)
  octx.drawImage(layer, 0, 0)

  return out.convertToBlob(
    format === 'jpg' ? { type: 'image/jpeg', quality: 0.92 } : { type: 'image/png' },
  )
}

// Tone-match + seam-correct the layer in place (full opacity, before the mask
// clip): global per-channel linear fit estimated on outside-mask pixels, plus
// a membrane-interpolated residual field that makes the layer match the
// original exactly at the selection boundary. Finally match film grain so the
// edited region isn't conspicuously smoother than its surroundings.
function applySeamlessCorrection(original: ImageBitmap, layer: OffscreenCanvas, alphaMask: OffscreenCanvas): void {
  const W = layer.width
  const H = layer.height
  const scale = Math.min(1, BLEND_WORKING_MAX / Math.max(W, H))
  const lw = Math.max(4, Math.round(W * scale))
  const lh = Math.max(4, Math.round(H * scale))

  const origL = drawTo(original, lw, lh)
  const resL = drawTo(layer, lw, lh)
  const maskL = maskBitsAt(alphaMask, lw, lh)

  const corr = computeCorrection(origL, resL, maskL, lw, lh)

  // Upsample the smooth field via canvas bilinear filtering (encoded ±127
  // around 128 — the field is clamped well within that range)
  const enc = new ImageData(lw, lh)
  for (let p = 0; p < lw * lh; p++) {
    enc.data[p * 4] = Math.round(Math.min(255, Math.max(0, corr.field[0][p] + 128)))
    enc.data[p * 4 + 1] = Math.round(Math.min(255, Math.max(0, corr.field[1][p] + 128)))
    enc.data[p * 4 + 2] = Math.round(Math.min(255, Math.max(0, corr.field[2][p] + 128)))
    enc.data[p * 4 + 3] = 255
  }
  const fieldSmall = new OffscreenCanvas(lw, lh)
  fieldSmall.getContext('2d')!.putImageData(enc, 0, 0)
  const fieldFull = new OffscreenCanvas(W, H)
  const fctx = fieldFull.getContext('2d')!
  fctx.imageSmoothingQuality = 'high'
  fctx.drawImage(fieldSmall, 0, 0, W, H)
  const fieldData = fctx.getImageData(0, 0, W, H).data

  const lctx = layer.getContext('2d')!
  const layerImage = lctx.getImageData(0, 0, W, H)
  const layerData = layerImage.data
  const maskData = alphaMask.getContext('2d')!.getImageData(0, 0, W, H).data

  // Grain matching: estimate noise inside (layer) vs outside (original)
  const origFull = new OffscreenCanvas(W, H)
  const octx = origFull.getContext('2d')!
  octx.drawImage(original, 0, 0)
  const origData = octx.getImageData(0, 0, W, H).data
  const sigmaOrig = sampleSigma(origData, maskData, W, H, false)
  const sigmaRes = sampleSigma(layerData, maskData, W, H, true)
  const addSigma = Math.min(GRAIN_MAX_SIGMA, Math.sqrt(Math.max(0, sigmaOrig * sigmaOrig - sigmaRes * sigmaRes)))

  let seed = 0x9e3779b9
  const rand = () => {
    // mulberry32
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const a = corr.a
  const b = corr.b
  for (let p = 0; p < W * H; p++) {
    if (maskData[p * 4 + 3] === 0) continue
    // approx gaussian: sum of 3 uniforms, sigma 0.5 → scale to addSigma
    const noise = addSigma > 0.5 ? (rand() + rand() + rand() - 1.5) * (addSigma / 0.5) : 0
    const j = p * 4
    for (let c = 0; c < 3; c++) {
      const v = a[c] * layerData[j + c] + b[c] + (fieldData[j + c] - 128) + noise
      layerData[j + c] = v < 0 ? 0 : v > 255 ? 255 : v
    }
  }
  lctx.putImageData(layerImage, 0, 0)
}

function drawTo(source: ImageBitmap | OffscreenCanvas, w: number, h: number): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(source, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h).data
}

// Robust noise estimate from horizontal green-channel pixel pairs, sampled on
// a sparse grid, restricted to inside (alpha>200) or outside (alpha===0).
function sampleSigma(
  data: Uint8ClampedArray,
  maskData: Uint8ClampedArray,
  w: number,
  h: number,
  inside: boolean,
): number {
  const diffs: number[] = []
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 60000)))
  for (let y = 0; y < h && diffs.length < 60000; y += step) {
    for (let x = 0; x + 1 < w; x += step) {
      const p = y * w + x
      const aA = maskData[p * 4 + 3]
      const aB = maskData[(p + 1) * 4 + 3]
      const ok = inside ? aA > 200 && aB > 200 : aA === 0 && aB === 0
      if (!ok) continue
      diffs.push(Math.abs(data[p * 4 + 1] - data[(p + 1) * 4 + 1]))
    }
  }
  return estimateNoiseSigma(diffs)
}
