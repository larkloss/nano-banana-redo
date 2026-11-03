// Dense alignment between an original picture and a model's repaint of it.
//
// A model's answer is the original moved, slightly scaled and gently warped
// — never by more than a few pixels, but not uniformly either. One global
// shift leaves edges far from where it was measured misaligned, which then
// look like changes. This estimates a smooth displacement field instead:
//   - overlapping blocks each find their best small shift (sub-pixel);
//   - blocks that can't be trusted — flat (any shift fits) or whose best
//     match is still poor (the content really changed there) — are dropped
//     and filled in from their neighbours;
//   - the grid is median-filtered and smoothed, then interpolated per pixel.
// Displacement (u, v) at (x, y) means: the answer's pixel at (x+u, y+v)
// shows what the original has at (x, y).

const BLOCK = 40 // block size, px
const STEP = 20 // grid spacing, px
const SAMPLE = 3 // pixel stride inside a block
const FLAT_STD = 3 // below this contrast a block can't be aligned
const BAD_MATCH = 2.5 // × the typical block error: content changed

export interface FlowField {
  u: Float32Array
  v: Float32Array
}

// Raw per-block measurements, before filling and smoothing
export interface BlockGrid {
  gx: number
  gy: number
  // block centres, px
  cx: Float32Array
  cy: Float32Array
  u: Float32Array
  v: Float32Array
  // 1 = a trustworthy measurement
  usable: Uint8Array
}

// `gray` is w×h; `grayP`/`validP` are the answer, drawn (after the global
// placement) into a (w+2M)×(h+2M) canvas so shifts up to ±(M-1) stay inside.
export function measureBlocks(
  gray: Float32Array,
  w: number,
  h: number,
  grayP: Float32Array,
  validP: Uint8Array,
  M: number,
): BlockGrid {
  const R = M - 1
  const pw = w + 2 * M
  const gx = Math.max(1, Math.ceil((w - BLOCK) / STEP) + 1)
  const gy = Math.max(1, Math.ceil((h - BLOCK) / STEP) + 1)
  const gu = new Float32Array(gx * gy)
  const gv = new Float32Array(gx * gy)
  const err = new Float32Array(gx * gy).fill(Infinity)
  const usable = new Uint8Array(gx * gy)

  for (let by = 0; by < gy; by++) {
    for (let bx = 0; bx < gx; bx++) {
      const x0 = Math.min(Math.max(0, w - BLOCK), bx * STEP)
      const y0 = Math.min(Math.max(0, h - BLOCK), by * STEP)
      const pts: number[] = []
      let sum = 0
      let sum2 = 0
      for (let y = y0; y < Math.min(h, y0 + BLOCK); y += SAMPLE) {
        for (let x = x0; x < Math.min(w, x0 + BLOCK); x += SAMPLE) {
          const p = y * w + x
          pts.push(p)
          sum += gray[p]
          sum2 += gray[p] * gray[p]
        }
      }
      const k = by * gx + bx
      const mean = sum / pts.length
      const std = Math.sqrt(Math.max(0, sum2 / pts.length - mean * mean))
      if (std < FLAT_STD) continue

      const cost = (sx: number, sy: number) => {
        let e = 0
        let m = 0
        for (const p of pts) {
          const x = p % w
          const y = (p - x) / w
          const q = (y + M + sy) * pw + (x + M + sx)
          if (!validP[q]) continue
          e += Math.min(40, Math.abs(gray[p] - grayP[q]))
          m++
        }
        return m > pts.length / 2 ? e / m : Infinity
      }
      let best = { sx: 0, sy: 0, e: cost(0, 0) }
      for (let sy = -R; sy <= R; sy++) {
        for (let sx = -R; sx <= R; sx++) {
          if (sx === 0 && sy === 0) continue
          const e = cost(sx, sy)
          if (e < best.e) best = { sx, sy, e }
        }
      }
      // A best match at the edge of the search may really lie beyond it
      if (!Number.isFinite(best.e) || Math.abs(best.sx) >= R || Math.abs(best.sy) >= R) continue
      const sub = (a: number, b: number, c: number) => {
        const den = a - 2 * b + c
        return Number.isFinite(den) && den > 1e-6 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0
      }
      const fx = sub(cost(best.sx - 1, best.sy), best.e, cost(best.sx + 1, best.sy))
      const fy = sub(cost(best.sx, best.sy - 1), best.e, cost(best.sx, best.sy + 1))
      gu[k] = best.sx + fx
      gv[k] = best.sy + fy
      err[k] = best.e
      usable[k] = 1
    }
  }

  // Drop blocks whose best match is still poor: their content changed
  const errs: number[] = []
  for (let k = 0; k < err.length; k++) if (usable[k]) errs.push(err[k])
  errs.sort((a, b) => a - b)
  const typical = errs.length > 0 ? errs[Math.floor(errs.length / 2)] : 0
  for (let k = 0; k < err.length; k++) if (usable[k] && err[k] > BAD_MATCH * Math.max(typical, 1)) usable[k] = 0

  const cxs = new Float32Array(gx * gy)
  const cys = new Float32Array(gx * gy)
  for (let by = 0; by < gy; by++) {
    for (let bx = 0; bx < gx; bx++) {
      cxs[by * gx + bx] = Math.min(Math.max(0, w - BLOCK), bx * STEP) + BLOCK / 2
      cys[by * gx + bx] = Math.min(Math.max(0, h - BLOCK), by * STEP) + BLOCK / 2
    }
  }
  return { gx, gy, cx: cxs, cy: cys, u: gu, v: gv, usable }
}

export function blockFlow(
  gray: Float32Array,
  w: number,
  h: number,
  grayP: Float32Array,
  validP: Uint8Array,
  M: number,
): FlowField {
  const { gx, gy, u: gu, v: gv, usable } = measureBlocks(gray, w, h, grayP, validP, M)

  // Median filter over trusted neighbours (removes stray matches)
  const mu = gu.slice()
  const mv = gv.slice()
  for (let by = 0; by < gy; by++) {
    for (let bx = 0; bx < gx; bx++) {
      const k = by * gx + bx
      if (!usable[k]) continue
      const us: number[] = []
      const vs: number[] = []
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = bx + dx
          const y = by + dy
          if (x < 0 || y < 0 || x >= gx || y >= gy) continue
          const j = y * gx + x
          if (usable[j]) {
            us.push(gu[j])
            vs.push(gv[j])
          }
        }
      }
      us.sort((a, b) => a - b)
      vs.sort((a, b) => a - b)
      mu[k] = us[us.length >> 1]
      mv[k] = vs[vs.length >> 1]
    }
  }

  // Fill untrusted blocks from trusted ones (repeated neighbour averaging),
  // then smooth everything a little
  const filled = fillGrid(mu, mv, usable, gx, gy)
  const su = smoothGrid(filled.u, gx, gy)
  const sv = smoothGrid(filled.v, gx, gy)

  // Per-pixel bilinear interpolation of the grid (block centres)
  const u = new Float32Array(w * h)
  const v = new Float32Array(w * h)
  const centre = (b: number, size: number) => Math.min(Math.max(0, size - BLOCK), b * STEP) + BLOCK / 2
  for (let y = 0; y < h; y++) {
    let by = 0
    while (by < gy - 2 && centre(by + 1, h) < y) by++
    const cy0 = centre(by, h)
    const cy1 = gy > 1 ? centre(Math.min(gy - 1, by + 1), h) : cy0
    const ty = cy1 > cy0 ? Math.min(1, Math.max(0, (y - cy0) / (cy1 - cy0))) : 0
    const by1 = Math.min(gy - 1, by + 1)
    let bx = 0
    for (let x = 0; x < w; x++) {
      while (bx < gx - 2 && centre(bx + 1, w) < x) bx++
      const cx0 = centre(bx, w)
      const cx1 = gx > 1 ? centre(Math.min(gx - 1, bx + 1), w) : cx0
      const tx = cx1 > cx0 ? Math.min(1, Math.max(0, (x - cx0) / (cx1 - cx0))) : 0
      const bx1 = Math.min(gx - 1, bx + 1)
      const k00 = by * gx + bx
      const k01 = by * gx + bx1
      const k10 = by1 * gx + bx
      const k11 = by1 * gx + bx1
      const p = y * w + x
      u[p] = (su[k00] * (1 - tx) + su[k01] * tx) * (1 - ty) + (su[k10] * (1 - tx) + su[k11] * tx) * ty
      v[p] = (sv[k00] * (1 - tx) + sv[k01] * tx) * (1 - ty) + (sv[k10] * (1 - tx) + sv[k11] * tx) * ty
    }
  }
  return { u, v }
}

// The answer's overall zoom: models sometimes redraw the picture a few
// percent larger or smaller (or come back in a slightly different shape that
// is then stretched to fit), which moves the content by more than the block
// search can follow near the edges. Fits, per axis, displacement = scale ×
// (position − centre) + shift to the trusted blocks, ignoring outliers (the
// edit itself, mismatched blocks). Returns null when the blocks don't say
// anything reliable.
export function fitAxisScale(
  grid: BlockGrid,
  w: number,
  h: number,
  skip: (x: number, y: number) => boolean,
): { ax: number; bx: number; ay: number; by: number; xc: number; yc: number } | null {
  const xs: number[] = []
  const ys: number[] = []
  const us: number[] = []
  const vs: number[] = []
  for (let k = 0; k < grid.usable.length; k++) {
    if (!grid.usable[k] || skip(grid.cx[k], grid.cy[k])) continue
    xs.push(grid.cx[k])
    ys.push(grid.cy[k])
    us.push(grid.u[k])
    vs.push(grid.v[k])
  }
  if (xs.length < 8) return null
  const xc = w / 2
  const yc = h / 2
  // A model zooms evenly far more often than it stretches: measure one zoom
  // from both directions together, and only treat the axes separately when
  // they clearly disagree (a picture that came back in a slightly different
  // shape and was stretched to fit)
  const both = robustLine(
    [...xs.map((x) => x - xc), ...ys.map((y) => y - yc)],
    [...us, ...vs],
    0,
    Math.max(w, h),
    [...xs.map(() => 0), ...ys.map(() => 1)],
  )
  const fx = robustLine(xs, us, xc, w)
  const fy = robustLine(ys, vs, yc, h)
  if (both && (!fx || !fy || Math.abs(fx.slope - fy.slope) < 0.008)) {
    // shared slope; each axis keeps its own shift
    const atX = median(us.map((u, i) => u - both.slope * (xs[i] - xc)))
    const atY = median(vs.map((v, i) => v - both.slope * (ys[i] - yc)))
    return { ax: both.slope, bx: atX, ay: both.slope, by: atY, xc, yc }
  }
  if (!fx || !fy) return null
  return { ax: fx.slope, bx: fx.at, ay: fy.slope, by: fy.at, xc, yc }
}

// y ≈ slope·(x − centre) + at, by Theil–Sen (the median of the slopes
// between point pairs — unmoved by a large share of outliers). Only trusted
// when the points spread over a good part of the picture and the slope
// clearly beats a constant; otherwise the slope is 0. `group` keeps pairs
// within one series (the two axes of a joint fit each have their own shift).
function robustLine(
  x: number[],
  y: number[],
  centre: number,
  size: number,
  group?: number[],
): { slope: number; at: number } | null {
  const n = x.length
  const sortedX = x.slice().sort((a, b) => a - b)
  if (sortedX[Math.floor(n * 0.9)] - sortedX[Math.floor(n * 0.1)] < size / 3) return null
  const slopes: number[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (group && group[i] !== group[j]) continue
      const dx = x[j] - x[i]
      if (Math.abs(dx) >= size / 8) slopes.push((y[j] - y[i]) / dx)
    }
  }
  if (slopes.length < 10) return null
  const slope = median(slopes)
  const offsets = y.map((yi, i) => yi - slope * (x[i] - centre))
  // per-series shift (one series unless grouped)
  const shiftOf = (g: number) => median(offsets.filter((_, i) => (group ? group[i] : 0) === g))
  const flatOf = (g: number) => median(y.filter((_, i) => (group ? group[i] : 0) === g))
  const at0 = shiftOf(0)
  const shifts = group ? [at0, shiftOf(1)] : [at0]
  const flats = group ? [flatOf(0), flatOf(1)] : [flatOf(0)]
  const g = (i: number) => (group ? group[i] : 0)
  const spreadWith = median(y.map((yi, i) => Math.abs(yi - (slope * (x[i] - centre) + shifts[g(i)]))))
  const spreadFlat = median(y.map((yi, i) => Math.abs(yi - flats[g(i)])))
  if (spreadWith > 0.85 * spreadFlat) return { slope: 0, at: flats[0] }
  return { slope, at: at0 }
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function fillGrid(
  gu: Float32Array,
  gv: Float32Array,
  usable: Uint8Array,
  gx: number,
  gy: number,
): { u: Float32Array; v: Float32Array } {
  const u = gu.slice()
  const v = gv.slice()
  const known = usable.slice()
  let any = false
  for (let k = 0; k < known.length; k++) any ||= known[k] === 1
  if (!any) return { u: new Float32Array(gx * gy), v: new Float32Array(gx * gy) }
  for (let iter = 0; iter < gx + gy; iter++) {
    let changed = false
    const nk = known.slice()
    for (let by = 0; by < gy; by++) {
      for (let bx = 0; bx < gx; bx++) {
        const k = by * gx + bx
        if (known[k]) continue
        let su = 0
        let sv = 0
        let m = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = bx + dx
            const y = by + dy
            if (x < 0 || y < 0 || x >= gx || y >= gy) continue
            const j = y * gx + x
            if (known[j]) {
              su += u[j]
              sv += v[j]
              m++
            }
          }
        }
        if (m > 0) {
          u[k] = su / m
          v[k] = sv / m
          nk[k] = 1
          changed = true
        }
      }
    }
    known.set(nk)
    if (!changed) break
  }
  return { u, v }
}

function smoothGrid(src: Float32Array, gx: number, gy: number): Float32Array {
  const out = new Float32Array(src.length)
  const k = [0.25, 0.5, 0.25]
  const tmp = new Float32Array(src.length)
  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      let a = 0
      let s = 0
      for (let d = -1; d <= 1; d++) {
        const xx = x + d
        if (xx < 0 || xx >= gx) continue
        a += src[y * gx + xx] * k[d + 1]
        s += k[d + 1]
      }
      tmp[y * gx + x] = a / s
    }
  }
  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      let a = 0
      let s = 0
      for (let d = -1; d <= 1; d++) {
        const yy = y + d
        if (yy < 0 || yy >= gy) continue
        a += tmp[yy * gx + x] * k[d + 1]
        s += k[d + 1]
      }
      out[y * gx + x] = a / s
    }
  }
  return out
}

// Resamples padded answer planes through the field: out(x, y) = answer at
// (x+u, y+v), bilinear. `valid` marks pixels whose sample was fully covered.
export function warpPlanes(
  planesP: Float32Array[],
  validP: Uint8Array,
  w: number,
  h: number,
  M: number,
  flow: FlowField,
): { planes: Float32Array[]; valid: Uint8Array } {
  const pw = w + 2 * M
  const ph = h + 2 * M
  const planes = planesP.map(() => new Float32Array(w * h))
  const valid = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const fx = x + M + flow.u[p]
      const fy = y + M + flow.v[p]
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      if (x0 < 0 || y0 < 0 || x0 + 1 >= pw || y0 + 1 >= ph) continue
      const tx = fx - x0
      const ty = fy - y0
      const q00 = y0 * pw + x0
      const q01 = q00 + 1
      const q10 = q00 + pw
      const q11 = q10 + 1
      if (!validP[q00] || !validP[q01] || !validP[q10] || !validP[q11]) continue
      valid[p] = 1
      for (let c = 0; c < planes.length; c++) {
        const s = planesP[c]
        planes[c][p] = (s[q00] * (1 - tx) + s[q01] * tx) * (1 - ty) + (s[q10] * (1 - tx) + s[q11] * tx) * ty
      }
    }
  }
  return { planes, valid }
}
