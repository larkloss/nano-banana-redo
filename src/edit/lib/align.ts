// Model outputs are frequently shifted a few pixels relative to the input
// (well-documented nano banana quirk). Estimate the integer translation by
// minimizing mean abs grayscale diff over OUTSIDE-mask pixels — the region
// that should be unchanged — with a coarse-to-fine grid search.

export interface AnalysisContext {
  aw: number // analysis width
  ah: number
  scaleToOriginal: number // multiply analysis px by this to get original px
  origGray: Uint8Array
  maskBits: Uint8Array // 1 = inside selection
}

export interface AlignResult {
  dx: number // offset in ORIGINAL pixels to apply to the result layer
  dy: number
  insideDiff: number // mean abs diff inside the mask after alignment (0-255)
}

const ANALYSIS_MAX = 2048
const COARSE_FACTOR = 4
const SEARCH_RADIUS = 3 // ±3 at each level → covers ±15 analysis px overall

export function buildAnalysisContext(
  original: ImageBitmap,
  maskBitsAtFn: (w: number, h: number) => Uint8Array,
): AnalysisContext {
  const longSide = Math.max(original.width, original.height)
  const scale = Math.min(1, ANALYSIS_MAX / longSide)
  const aw = Math.max(1, Math.round(original.width * scale))
  const ah = Math.max(1, Math.round(original.height * scale))
  return {
    aw,
    ah,
    scaleToOriginal: original.width / aw,
    origGray: toGray(original, aw, ah),
    maskBits: maskBitsAtFn(aw, ah),
  }
}

export function analyzeResult(ctx: AnalysisContext, result: ImageBitmap): AlignResult {
  const resGray = toGray(result, ctx.aw, ctx.ah)
  const { dx, dy, insideDiff } = estimateOffset(ctx.origGray, resGray, ctx.maskBits, ctx.aw, ctx.ah)
  return {
    dx: Math.round(dx * ctx.scaleToOriginal),
    dy: Math.round(dy * ctx.scaleToOriginal),
    insideDiff,
  }
}

// Pure (canvas-free) core, exported for tests: coarse-to-fine translation
// search over outside-mask pixels + post-alignment inside-mask diff.
export function estimateOffset(
  origGray: Uint8Array,
  resGray: Uint8Array,
  maskBits: Uint8Array,
  w: number,
  h: number,
): { dx: number; dy: number; insideDiff: number } {
  const cw = Math.max(1, Math.floor(w / COARSE_FACTOR))
  const ch = Math.max(1, Math.floor(h / COARSE_FACTOR))
  const origCoarse = boxDownsample(origGray, w, h, cw, ch)
  const resCoarse = boxDownsample(resGray, w, h, cw, ch)
  const maskCoarse = boxDownsampleBits(maskBits, w, h, cw, ch)
  const coarse = searchOffset(origCoarse, resCoarse, maskCoarse, cw, ch, 0, 0, SEARCH_RADIUS)

  // Fine search around the coarse minimum AND around (0,0): true shifts are
  // usually tiny, and this guards against the coarse pass aliasing onto a
  // wrong minimum on high-frequency content.
  const fineFromCoarse = searchOffset(
    origGray,
    resGray,
    maskBits,
    w,
    h,
    coarse.dx * COARSE_FACTOR,
    coarse.dy * COARSE_FACTOR,
    SEARCH_RADIUS,
  )
  const fineFromZero = searchOffset(origGray, resGray, maskBits, w, h, 0, 0, SEARCH_RADIUS)
  const fine = fineFromZero.cost <= fineFromCoarse.cost ? fineFromZero : fineFromCoarse

  const insideDiff = meanDiff(origGray, resGray, maskBits, w, h, fine.dx, fine.dy, true)
  return { dx: fine.dx, dy: fine.dy, insideDiff }
}

export function toGray(bitmap: ImageBitmap, w: number, h: number): Uint8Array {
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const gray = new Uint8Array(w * h)
  for (let i = 0; i < gray.length; i++) {
    const j = i * 4
    gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8
  }
  return gray
}

// Box-average downsample (anti-aliased — nearest-neighbor aliases badly on
// high-frequency content and can send the coarse search to a wrong minimum).
function boxDownsample(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh)
  const fx = sw / dw
  const fy = sh / dh
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy)
    const y1 = Math.min(sh, Math.ceil((y + 1) * fy))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx)
      const x1 = Math.min(sw, Math.ceil((x + 1) * fx))
      let sum = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += src[sy * sw + sx]
          n++
        }
      }
      out[y * dw + x] = n > 0 ? Math.round(sum / n) : 0
    }
  }
  return out
}

function boxDownsampleBits(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const avg = boxDownsample(src, sw, sh, dw, dh)
  const out = new Uint8Array(avg.length)
  // Any selected coverage marks the coarse cell as inside, so the outside-mask
  // cost never samples edited pixels
  for (let i = 0; i < avg.length; i++) out[i] = avg[i] > 0 ? 1 : 0
  return out
}

function searchOffset(
  orig: Uint8Array,
  res: Uint8Array,
  maskBits: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
): { dx: number; dy: number; cost: number } {
  let best = { dx: cx, dy: cy, cost: Infinity }
  for (let dy = cy - radius; dy <= cy + radius; dy++) {
    for (let dx = cx - radius; dx <= cx + radius; dx++) {
      const cost = meanDiff(orig, res, maskBits, w, h, dx, dy, false)
      if (cost < best.cost) best = { dx, dy, cost }
    }
  }
  return best
}

// Mean abs diff between orig[p] and res[p - (dx,dy)] over pixels where the mask
// matches `inside` (the result layer is later drawn shifted BY (dx,dy), so the
// result pixel that lands on p originates at p - (dx,dy)). Stride-2 sampling.
function meanDiff(
  orig: Uint8Array,
  res: Uint8Array,
  maskBits: Uint8Array,
  w: number,
  h: number,
  dx: number,
  dy: number,
  inside: boolean,
): number {
  let sum = 0
  let count = 0
  const want = inside ? 1 : 0
  for (let y = Math.max(0, dy); y < Math.min(h, h + dy); y += 2) {
    const sy = y - dy
    for (let x = Math.max(0, dx); x < Math.min(w, w + dx); x += 2) {
      const p = y * w + x
      if (maskBits[p] !== want) continue
      sum += Math.abs(orig[p] - res[sy * w + (x - dx)])
      count++
    }
  }
  return count > 0 ? sum / count : 0
}
