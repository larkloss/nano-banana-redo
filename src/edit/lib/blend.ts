// Seamless blending math (canvas-free, unit-testable).
//
// A pasted region looks "stuck on" for two reasons: the model re-renders the
// whole frame with its own global tone (exposure/WB shift), and local lighting
// at the seam doesn't line up. Feathering alone cannot hide a tonal step.
// Fix in two stages, both computed at a low working resolution:
//   1. global per-channel linear fit  orig ≈ a·res + b  over OUTSIDE-mask
//      pixels (which should be identical content);
//   2. membrane (Laplace) interpolation of the residual difference sampled on
//      the mask boundary ring, diffused smoothly across the interior — the
//      corrected result then matches the original exactly at the seam
//      (Poisson-style seamless cloning).

export interface CorrectionField {
  a: Float32Array // per-channel gain, length 3
  b: Float32Array // per-channel offset, length 3
  field: Float32Array[] // per-channel smooth correction, wL*hL each
  wL: number
  hL: number
}

const MIN_FIT_SAMPLES = 64
const GAIN_MIN = 0.6
const GAIN_MAX = 1.7
const OFFSET_MAX = 80
const FIELD_MAX = 120

export function computeCorrection(
  origRgba: Uint8ClampedArray,
  resRgba: Uint8ClampedArray,
  maskBits: Uint8Array,
  w: number,
  h: number,
): CorrectionField {
  const orig = splitChannels(origRgba, w * h)
  const res = splitChannels(resRgba, w * h)

  const { a, b } = linearFitOutside(orig, res, maskBits)

  // Residual after the global fit, fixed on the boundary ring, diffused inward
  const field = solveMembraneCascade(orig, res, maskBits, w, h, a, b)

  return { a, b, field, wL: w, hL: h }
}

export function linearFitOutside(
  orig: Float32Array[],
  res: Float32Array[],
  maskBits: Uint8Array,
): { a: Float32Array; b: Float32Array } {
  const a = new Float32Array([1, 1, 1])
  const b = new Float32Array([0, 0, 0])
  for (let c = 0; c < 3; c++) {
    let n = 0
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    const o = orig[c]
    const r = res[c]
    for (let p = 0; p < maskBits.length; p++) {
      if (maskBits[p]) continue
      const x = r[p]
      const y = o[p]
      n++
      sx += x
      sy += y
      sxx += x * x
      sxy += x * y
    }
    if (n < MIN_FIT_SAMPLES) continue
    const denom = n * sxx - sx * sx
    if (Math.abs(denom) < 1e-6) continue
    let ga = (n * sxy - sx * sy) / denom
    ga = Math.min(GAIN_MAX, Math.max(GAIN_MIN, ga))
    let gb = (sy - ga * sx) / n
    gb = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, gb))
    a[c] = ga
    b[c] = gb
  }
  return { a, b }
}

// Coarse-to-fine Gauss-Seidel: solve at /4, upsample as the /2 init, then full.
function solveMembraneCascade(
  orig: Float32Array[],
  res: Float32Array[],
  maskBits: Uint8Array,
  w: number,
  h: number,
  a: Float32Array,
  b: Float32Array,
): Float32Array[] {
  const levels = [
    { div: 4, iters: 220 },
    { div: 2, iters: 110 },
    { div: 1, iters: 60 },
  ].filter((l) => Math.floor(w / l.div) >= 4 && Math.floor(h / l.div) >= 4)
  if (levels.length === 0) levels.push({ div: 1, iters: 200 })

  let prev: { field: Float32Array[]; w: number; h: number } | null = null
  for (const level of levels) {
    const lw = Math.max(4, Math.floor(w / level.div))
    const lh = Math.max(4, Math.floor(h / level.div))
    const maskL = downsampleBitsAny(maskBits, w, h, lw, lh)
    const ring = boundaryRing(maskL, lw, lh)

    const field: Float32Array[] = []
    for (let c = 0; c < 3; c++) {
      const origL = boxDownsample(orig[c], w, h, lw, lh)
      const resL = boxDownsample(res[c], w, h, lw, lh)
      const f = prev
        ? bilinearUpsample(prev.field[c], prev.w, prev.h, lw, lh)
        : new Float32Array(lw * lh)
      // Dirichlet values on the ring: residual diff after the global fit
      for (let p = 0; p < ring.length; p++) {
        if (ring[p]) f[p] = clampField(origL[p] - (a[c] * resL[p] + b[c]))
        else if (!maskL[p]) f[p] = 0
      }
      gaussSeidel(f, maskL, ring, lw, lh, level.iters)
      field.push(f)
    }
    prev = { field, w: lw, h: lh }
  }
  return prev!.field
}

export function boundaryRing(maskBits: Uint8Array, w: number, h: number): Uint8Array {
  const ring = new Uint8Array(maskBits.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (!maskBits[p]) continue
      const edge =
        (x > 0 && !maskBits[p - 1]) ||
        (x < w - 1 && !maskBits[p + 1]) ||
        (y > 0 && !maskBits[p - w]) ||
        (y < h - 1 && !maskBits[p + w]) ||
        x === 0 ||
        x === w - 1 ||
        y === 0 ||
        y === h - 1
      if (edge) ring[p] = 1
    }
  }
  return ring
}

function gaussSeidel(
  f: Float32Array,
  maskBits: Uint8Array,
  ring: Uint8Array,
  w: number,
  h: number,
  iters: number,
): void {
  for (let it = 0; it < iters; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (!maskBits[p] || ring[p]) continue
        let sum = 0
        let n = 0
        if (x > 0 && maskBits[p - 1]) {
          sum += f[p - 1]
          n++
        }
        if (x < w - 1 && maskBits[p + 1]) {
          sum += f[p + 1]
          n++
        }
        if (y > 0 && maskBits[p - w]) {
          sum += f[p - w]
          n++
        }
        if (y < h - 1 && maskBits[p + w]) {
          sum += f[p + w]
          n++
        }
        if (n > 0) f[p] = sum / n
      }
    }
  }
}

function splitChannels(rgba: Uint8ClampedArray, n: number): Float32Array[] {
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (let p = 0; p < n; p++) {
    out[0][p] = rgba[p * 4]
    out[1][p] = rgba[p * 4 + 1]
    out[2][p] = rgba[p * 4 + 2]
  }
  return out
}

export function boxDownsample(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh)
  const fx = sw / dw
  const fy = sh / dh
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy)
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((y + 1) * fy)))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx)
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((x + 1) * fx)))
      let sum = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += src[sy * sw + sx]
          n++
        }
      }
      out[y * dw + x] = sum / n
    }
  }
  return out
}

function downsampleBitsAny(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh)
  const fx = sw / dw
  const fy = sh / dh
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy)
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((y + 1) * fy)))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx)
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((x + 1) * fx)))
      let any = 0
      for (let sy = y0; sy < y1 && !any; sy++)
        for (let sx = x0; sx < x1; sx++)
          if (src[sy * sw + sx]) {
            any = 1
            break
          }
      out[y * dw + x] = any
    }
  }
  return out
}

export function bilinearUpsample(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh)
  for (let y = 0; y < dh; y++) {
    const fy = ((y + 0.5) * sh) / dh - 0.5
    const y0 = Math.max(0, Math.floor(fy))
    const y1 = Math.min(sh - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < dw; x++) {
      const fx = ((x + 0.5) * sw) / dw - 0.5
      const x0 = Math.max(0, Math.floor(fx))
      const x1 = Math.min(sw - 1, x0 + 1)
      const tx = fx - x0
      const top = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx
      const bot = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx
      out[y * dw + x] = top * (1 - ty) + bot * ty
    }
  }
  return out
}

function clampField(v: number): number {
  return Math.min(FIELD_MAX, Math.max(-FIELD_MAX, v))
}

// Robust noise sigma from horizontal pixel pairs: for Gaussian noise,
// sigma ≈ 1.4826 * median(|x[i] - x[i+1]|) / sqrt(2).
export function estimateNoiseSigma(samples: number[]): number {
  if (samples.length < 200) return 0
  samples.sort((x, y) => x - y)
  const median = samples[Math.floor(samples.length / 2)]
  return (1.4826 * median) / Math.SQRT2
}
