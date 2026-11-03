// Pure compositing: no network, no UI. Runs in a Web Worker when it can
// (see localEditClient.ts), so a multi-second composite never freezes the page.
import type { OutputFormat } from '../types'
import type { EditMark } from './annotate'
import { analyzeResult, buildAnalysisContext, type AnalysisContext } from '../edit/lib/align'
import { computeCorrection, estimateNoiseSigma, linearFitOutside } from '../edit/lib/blend'
import {
  dilate,
  distanceToSet,
  erode,
  fillSmallHoles,
  fitNoiseModel,
  gaussianBlur,
  gradientMagnitude,
  labDistance,
  labelComponents,
  open,
  paintDisc,
  quantile,
  toOklab,
  toYcc,
  tolerantLabDistance,
} from './imageMath'
import { optimalSeamRegion } from './seamCut'
import { blockFlow, warpPlanes } from './flow'

// ---------------------------------------------------------------------------
// "Only change around the arrows."
//
// Image models repaint the whole picture even for a small edit, so faces,
// eyes, skin and micro-expressions drift. This keeps only what the model
// actually changed around the arrows and takes every other pixel from the
// original, bit for bit (PNG output).
//
//  1. Align the answer to the original (global shift), and undo its global
//     colour drift — both measured away from the arrows, where nothing
//     should have changed.
//  2. Find the change: a perceptual (OKLab) difference that forgives the
//     1px jitter of a redraw, thresholded against the redraw noise measured
//     just around each arrow. Changes must start at the arrow's tip and may
//     grow outward (hysteresis) up to a limit; small enclosed holes are
//     filled, big ones (a face inside a recoloured hood) are not.
//  3. Per changed area: refine the alignment on the band where the seam will
//     go, then pick the seam itself with a minimum cut through the pixels
//     where the two pictures agree most, leaving room for the blend.
//  4. Blend at full resolution: local tone match + boundary correction
//     (Poisson-style) + grain match, alpha ramping from exactly 0 at the
//     seam to 1 inside, so nothing outside the area moves at all.
//
// An answer with no change at any arrow is reported as a failed attempt, so
// the retry loop just tries again.
// ---------------------------------------------------------------------------

// Sizes are shares of the picture's shorter side
const ZONE_RADIUS = 0.22 // kept out of alignment / colour-drift estimates
const NOISE_OUTER = 0.45 // redraw noise is sampled between ZONE and this
const CORE_RADIUS = 0.06 // a change has to show up this close to the tip
const MAX_REACH = 0.5 // and may spread this far through any real change
const FAR_REACH = 0.95 // or this far through unmistakable change
const CLOSE_RADIUS = 0.008 // joins fragments of one changed object
const FEATHER = 0.012 // width of the blend ramp
const SEAM_ROOM = 0.035 // how far out the seam may wander to find agreement

const WORK_MAX = 768 // long side for change detection
const CROP_MAX = 900 // long side for seam search per changed area
const BLEND_MAX = 256 // long side for the boundary-correction field
const DETECT_BLUR = 1.0 // px at work size: averages away redrawn texture
const SEAM_BLUR = 0.7
const LOCAL_ALIGN = 3 // ± px at crop size

// Thresholds on the Y'CbCr difference (0–255 units), scaled with the redraw
// noise model next to each arrow
const HIGH_MIN = 14
const HIGH_K = 5
const LOW_MIN = 7
const LOW_K = 3
const CLEAR_CHANGE = 6 // × noise: certainly a change, kept out of noise samples
const MIN_SEED_SHARE = 0.03 // of the core disc
const FLOW_MARGIN = 8 // ± px at work size the dense alignment may shift
const LOCAL_NOISE_CAP = 3 // local noise ≤ this × picture-wide noise
const AR_TOLERANCE = 0.03

export interface LocalEditInfo {
  // Per arrow: did the model change anything at its tip?
  arrowsChanged: boolean[]
  // Share of the picture taken from the model
  coverage: number
  // The change ran into the size limit — it may be bigger than what was kept
  reachedLimit: boolean
}

// Detection numbers per arrow, for tuning and diagnostics
export interface ArrowStats {
  offset: [number, number]
  // redraw noise model: a + b·edge strength
  noise: [number, number]
  seeds: number
  changed: boolean
}
let lastStats: ArrowStats[] = []
let lastDebug: { w: number; h: number; grown: Uint8Array; globalNoise?: [number, number] } | null = null
export function lastLocalEditStats(): ArrowStats[] {
  return lastStats
}
export function lastLocalEditDebug() {
  return lastDebug
}

export interface LocalEditJob {
  original: ImageBitmap
  marks: EditMark[]
  format: OutputFormat
  W: number
  H: number
  w: number
  h: number
  analysis: AnalysisContext
  origRgb: Float32Array[]
  // Detection planes (Y'CbCr, lightly blurred) and edge strength of the original
  origDet: Float32Array[]
  origGrad: Float32Array
  zones: Uint8Array
}

export async function prepareLocalEdit(source: Blob, marks: EditMark[], format: OutputFormat): Promise<LocalEditJob> {
  const original = await createImageBitmap(source)
  const W = original.width
  const H = original.height
  const s = Math.min(1, WORK_MAX / Math.max(W, H))
  const w = Math.max(16, Math.round(W * s))
  const h = Math.max(16, Math.round(H * s))
  const zones = discs(marks, w, h, ZONE_RADIUS)
  const analysis = buildAnalysisContext(original, (aw, ah) => discs(marks, aw, ah, ZONE_RADIUS))
  const origRgb = readRgb(original, W, H, w, h, 0, 0).rgb
  const origDet = toYcc(origRgb, w * h).map((c) => gaussianBlur(c, w, h, DETECT_BLUR))
  return {
    original,
    marks,
    format,
    W,
    H,
    w,
    h,
    analysis,
    origRgb,
    origDet,
    origGrad: gradientMagnitude(origDet[0], w, h),
    zones,
  }
}

export function releaseLocalEdit(job: LocalEditJob): void {
  job.original.close()
}

export type LocalComposite =
  | { kind: 'ok'; blob: Blob; mask: Blob; info: LocalEditInfo }
  | { kind: 'reject'; reason: string }

export async function composeLocalEdit(job: LocalEditJob, result: ImageBitmap): Promise<LocalComposite> {
  const { W, H, w, h, marks } = job
  const n = w * h
  const s = w / W
  const unitW = Math.min(w, h)

  const arO = W / H
  const arR = result.width / result.height
  if (Math.abs(arR - arO) / arO > AR_TOLERANCE)
    return { kind: 'reject', reason: 'the model changed the picture’s shape' }

  // 1. Global alignment and colour drift, measured away from the arrows
  const global = analyzeResult(job.analysis, result)
  const res = readRgb(result, W, H, w, h, global.dx * s, global.dy * s)
  const exclude = new Uint8Array(n)
  for (let p = 0; p < n; p++) exclude[p] = job.zones[p] || !res.valid[p] ? 1 : 0
  const fit = robustColourFit(job.origRgb, res.rgb, exclude, n)

  // 2. Where did it change?
  //
  // Compare every pixel at its own alignment: a dense displacement field
  // follows the slight scale and warp of a repaint, so redrawn edges don't
  // pass for changes.
  const M = FLOW_MARGIN
  const pn = (w + 2 * M) * (h + 2 * M)
  const padded = readRgb(result, W, H, w + 2 * M, h + 2 * M, global.dx * s + M, global.dy * s + M, w, h)
  const paddedDet = toYcc(applyFit(padded.rgb, fit, pn), pn).map((c) =>
    gaussianBlur(c, w + 2 * M, h + 2 * M, DETECT_BLUR),
  )
  const flow = blockFlow(job.origDet[0], w, h, paddedDet[0], padded.valid, M)
  const aligned = warpPlanes(paddedDet, padded.valid, w, h, M, flow)
  const diff = tolerantLabDistance(job.origDet, aligned.planes, w, h, 1)
  for (let p = 0; p < n; p++) if (!aligned.valid[p]) diff[p] = 0

  // Redraw noise: how different the answer is where nothing changed, as a
  // function of edge strength. Picture-wide first (with anything that is
  // clearly a real change set aside), then next to each arrow if there's
  // enough clean ground there to say.
  const globalModel = robustNoiseModel(diff, job.origGrad, (p) => aligned.valid[p] === 1 && !job.zones[p], n)

  const reach = Math.max(8, MAX_REACH * unitW)
  const core = Math.max(4, CORE_RADIUS * unitW)
  const arrowsChanged: boolean[] = []
  const arrowOffsets: { dx: number; dy: number }[] = []
  const stats: ArrowStats[] = []
  const seeds = new Uint8Array(n)
  const candidate = new Uint8Array(n)
  const reachMask = new Uint8Array(n)

  for (const mark of marks) {
    const cx = mark.x * w
    const cy = mark.y * h
    const tip = Math.min(n - 1, Math.max(0, Math.round(cy) * w + Math.round(cx)))
    // Answer pixel (x+u, y+v) shows original (x, y): move it back by that
    arrowOffsets.push({ dx: global.dx - flow.u[tip] / s, dy: global.dy - flow.v[tip] / s })

    const x0 = Math.max(0, Math.floor(cx - reach))
    const y0 = Math.max(0, Math.floor(cy - reach))
    const x1 = Math.min(w - 1, Math.ceil(cx + reach))
    const y1 = Math.min(h - 1, Math.ceil(cy + reach))

    const inner = ZONE_RADIUS * unitW
    const outer = Math.min(NOISE_OUTER * unitW, reach)
    const ringDiff: number[] = []
    const ringGrad: number[] = []
    for (let y = y0; y <= y1; y += 2) {
      for (let x = x0; x <= x1; x += 2) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2
        if (d2 < inner * inner || d2 > outer * outer) continue
        const p = y * w + x
        if (!aligned.valid[p]) continue
        if (diff[p] > CLEAR_CHANGE * (globalModel.a + globalModel.b * job.origGrad[p])) continue
        ringDiff.push(diff[p])
        ringGrad.push(job.origGrad[p])
      }
    }
    // Never more than a few times the picture-wide noise: a big edit that
    // fills the ring must not raise its own bar
    const local = ringDiff.length >= 400 ? fitNoiseModel(ringDiff, ringGrad) : globalModel
    const model = {
      a: Math.min(local.a, LOCAL_NOISE_CAP * globalModel.a),
      b: Math.min(local.b, LOCAL_NOISE_CAP * Math.max(globalModel.b, 0.02)),
    }

    let seedCount = 0
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2
        if (d2 > reach * reach) continue
        const p = y * w + x
        if (!aligned.valid[p]) continue
        reachMask[p] = 1
        const noise = model.a + model.b * job.origGrad[p]
        if (diff[p] > Math.max(LOW_MIN, LOW_K * noise)) candidate[p] = 1
        if (d2 <= core * core && diff[p] > Math.max(HIGH_MIN, HIGH_K * noise)) {
          seeds[p] = 1
          seedCount++
        }
      }
    }
    const changed = seedCount >= Math.max(6, MIN_SEED_SHARE * Math.PI * core * core)
    arrowsChanged.push(changed)
    stats.push({ offset: [flow.u[tip], flow.v[tip]], noise: [model.a, model.b], seeds: seedCount, changed })
  }
  lastStats = stats
  lastDebug = { w, h, grown: new Uint8Array(0), globalNoise: [globalModel.a, globalModel.b] }
  if (!arrowsChanged.some(Boolean)) return { kind: 'reject', reason: 'no change near the arrows' }

  // Grow from the tips over connected change. Opening first drops the thin
  // lines a redraw leaves along edges; closing then joins the fragments of
  // one changed object.
  const closeR = Math.max(1, Math.round(CLOSE_RADIUS * unitW))
  const joined = erode(dilate(open(candidate, w, h, 1), w, h, closeR), w, h, closeR)
  for (let p = 0; p < n; p++) joined[p] = (joined[p] || seeds[p]) && reachMask[p] ? 1 : 0

  // Beyond that radius a change may keep growing, but only where it is
  // unmistakable — so a big, obvious edit (a whole recoloured saucer) is
  // taken whole while faint redraw noise still can't spread.
  const farReach = Math.max(reach, FAR_REACH * unitW)
  const strong = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    if (!aligned.valid[p]) continue
    const noise = globalModel.a + globalModel.b * job.origGrad[p]
    if (diff[p] > Math.max(HIGH_MIN, HIGH_K * noise)) strong[p] = 1
  }
  const farMask = discsAround(marks, arrowsChanged, w, h, farReach)
  const strongJoined = erode(dilate(open(strong, w, h, 1), w, h, closeR), w, h, closeR)
  for (let p = 0; p < n; p++) if (strongJoined[p] && farMask[p]) joined[p] = 1
  const grown = growFrom(seeds, joined, w, h)
  const grownArea = count(grown)
  fillSmallHoles(grown, w, h, Math.min(0.2 * grownArea, 0.01 * n))
  const reachedLimit = touchesReachEdge(grown, marks, arrowsChanged, w, h, farReach)
  lastDebug = { w, h, grown: grown.slice(), globalNoise: [globalModel.a, globalModel.b] }

  // 3. Seam per changed area, at a finer crop resolution
  const featherFull = Math.max(2, FEATHER * Math.min(W, H))
  const roomFull = Math.max(6, SEAM_ROOM * Math.min(W, H))
  const mayWork = dilate(grown, w, h, (featherFull + roomFull) * s)
  for (let p = 0; p < n; p++) mayWork[p] = mayWork[p] && aligned.valid[p] ? 1 : 0
  const { labels, count: clusters } = labelComponents(mayWork, w, h)

  const out = new OffscreenCanvas(W, H)
  const octx = out.getContext('2d', { willReadFrequently: true })!
  octx.drawImage(job.original, 0, 0)
  const overlay = new OffscreenCanvas(w, h)
  const ovctx = overlay.getContext('2d')!
  let takenFull = 0

  for (let k = 1; k <= clusters; k++) {
    // Crop box (original px) around this area, with room for the blend fit
    let bx0 = w
    let by0 = h
    let bx1 = -1
    let by1 = -1
    for (let p = 0; p < n; p++) {
      if (labels[p] !== k) continue
      const x = p % w
      const y = (p - x) / w
      if (x < bx0) bx0 = x
      if (x > bx1) bx1 = x
      if (y < by0) by0 = y
      if (y > by1) by1 = y
    }
    const pad = roomFull
    const cx0 = Math.max(0, Math.floor(bx0 / s - pad))
    const cy0 = Math.max(0, Math.floor(by0 / s - pad))
    const cx1 = Math.min(W, Math.ceil((bx1 + 1) / s + pad))
    const cy1 = Math.min(H, Math.ceil((by1 + 1) / s + pad))
    const cropW = cx1 - cx0
    const cropH = cy1 - cy0
    if (cropW < 4 || cropH < 4) continue

    const c = Math.min(1, CROP_MAX / Math.max(cropW, cropH))
    const cw = Math.max(4, Math.round(cropW * c))
    const ch = Math.max(4, Math.round(cropH * c))

    // This area's share of the detected change, at crop resolution
    const grownK = new Uint8Array(n)
    for (let p = 0; p < n; p++) grownK[p] = grown[p] && labels[p] === k ? 1 : 0
    const changeC = resampleMask(grownK, w, h, cx0 * s, cy0 * s, cropW * s, cropH * s, cw, ch)

    const origC = readRgb(job.original, W, H, cw, ch, -cx0 * c, -cy0 * c, W * c, H * c)
    const offset = refineOffset(
      origC.rgb,
      result,
      W,
      H,
      cw,
      ch,
      cx0,
      cy0,
      c,
      nearestOffset(marks, arrowsChanged, arrowOffsets, (cx0 + cropW / 2) / W, (cy0 + cropH / 2) / H, global),
      changeC,
      featherFull * c,
      roomFull * c,
    )
    const resC = readRgb(result, W, H, cw, ch, (offset.dx - cx0) * c, (offset.dy - cy0) * c, W * c, H * c)

    // Seam cost: how different the two pictures are, after the colour fit
    const nc = cw * ch
    const origLabC = toOklab(origC.rgb, nc).map((ch0) => gaussianBlur(ch0, cw, ch, SEAM_BLUR))
    const resLabC = toOklab(applyFit(resC.rgb, fit, nc), nc).map((ch0) => gaussianBlur(ch0, cw, ch, SEAM_BLUR))
    const d = labDistance(origLabC, resLabC, nc)
    const cost = new Float32Array(nc)
    for (let p = 0; p < nc; p++) {
      const v = Math.min(d[p], 60)
      cost[p] = v + (v * v) / 16
    }
    const must = dilate(changeC, cw, ch, featherFull * c)
    const may = dilate(changeC, cw, ch, (featherFull + roomFull) * c)
    for (let p = 0; p < nc; p++) {
      if (!resC.valid[p]) {
        may[p] = 0
        must[p] = 0
      }
    }
    const region = optimalSeamRegion(must, may, cost, cw, ch)

    // 4. Blend at full resolution
    takenFull += blendArea(
      octx,
      job.original,
      result,
      W,
      H,
      cx0,
      cy0,
      cropW,
      cropH,
      region,
      cw,
      ch,
      offset,
      fit,
      featherFull,
    )

    // Overlay for the UI: the area taken from the model, at work resolution
    const regionCanvas = new OffscreenCanvas(cw, ch)
    const rimg = new ImageData(cw, ch)
    for (let p = 0; p < nc; p++) {
      rimg.data[p * 4] = rimg.data[p * 4 + 1] = rimg.data[p * 4 + 2] = 255
      rimg.data[p * 4 + 3] = region[p] ? 255 : 0
    }
    regionCanvas.getContext('2d')!.putImageData(rimg, 0, 0)
    ovctx.drawImage(regionCanvas, cx0 * s, cy0 * s, cropW * s, cropH * s)
  }

  if (takenFull === 0) return { kind: 'reject', reason: 'no change near the arrows' }

  const blob = await out.convertToBlob(
    job.format === 'jpg' ? { type: 'image/jpeg', quality: 0.92 } : { type: 'image/png' },
  )
  const mask = await overlay.convertToBlob({ type: 'image/png' })
  return {
    kind: 'ok',
    blob,
    mask,
    info: { arrowsChanged, coverage: takenFull / (W * H), reachedLimit },
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function growFrom(seeds: Uint8Array, allowed: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const stack: number[] = []
  for (let p = 0; p < seeds.length; p++) {
    if (seeds[p] && !out[p]) {
      out[p] = 1
      stack.push(p)
    }
  }
  while (stack.length > 0) {
    const p = stack.pop()!
    const x = p % w
    const y = (p - x) / w
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= h) continue
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= w) continue
        const q = yy * w + xx
        if (allowed[q] && !out[q]) {
          out[q] = 1
          stack.push(q)
        }
      }
    }
  }
  return out
}

function touchesReachEdge(
  grown: Uint8Array,
  marks: EditMark[],
  changed: boolean[],
  w: number,
  h: number,
  reach: number,
): boolean {
  for (let p = 0; p < grown.length; p++) {
    if (!grown[p]) continue
    const x = p % w
    const y = (p - x) / w
    let inside = false
    let nearEdge = false
    marks.forEach((m, i) => {
      if (!changed[i]) return
      const d = Math.hypot(x - m.x * w, y - m.y * h)
      if (d < reach - 2) inside = true
      else if (d <= reach) nearEdge = true
    })
    if (nearEdge && !inside) return true
  }
  return false
}

// The model's global colour drift (per-channel gain and offset), fitted so
// that real changes don't skew it: a big recolour is a lot of pixels that
// disagree, so after each fit the worst-matching 35% are set aside and the
// fit is redone.
function robustColourFit(
  orig: Float32Array[],
  res: Float32Array[],
  exclude: Uint8Array,
  n: number,
): { a: Float32Array; b: Float32Array } {
  const step = Math.max(1, Math.floor(n / 80000))
  const pts: number[] = []
  for (let p = 0; p < n; p += step) if (!exclude[p]) pts.push(p)
  let keep = pts
  let fit: { a: Float32Array; b: Float32Array } = { a: new Float32Array([1, 1, 1]), b: new Float32Array([0, 0, 0]) }
  for (let iter = 0; iter < 4; iter++) {
    const mask = new Uint8Array(n).fill(1)
    for (const p of keep) mask[p] = 0
    fit = linearFitOutside(orig, res, mask)
    if (iter === 3) break
    const resid = pts.map((p) => {
      let m = 0
      for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(orig[c][p] - (fit.a[c] * res[c][p] + fit.b[c])))
      return m
    })
    const cut = quantile(resid, 0.65)
    keep = pts.filter((_, i) => resid[i] <= cut)
  }
  return fit
}

// Picture-wide noise model, refitted once without the pixels the first fit
// calls a clear change (so a big edit doesn't hide itself in the noise)
function robustNoiseModel(
  diff: Float32Array,
  grad: Float32Array,
  include: (p: number) => boolean,
  n: number,
): { a: number; b: number } {
  const step = Math.max(1, Math.floor(n / 60000))
  const sample = (exclude: { a: number; b: number } | null) => {
    const ds: number[] = []
    const gs: number[] = []
    for (let p = 0; p < n; p += step) {
      if (!include(p)) continue
      if (exclude && diff[p] > CLEAR_CHANGE * (exclude.a + exclude.b * grad[p])) continue
      ds.push(diff[p])
      gs.push(grad[p])
    }
    return [ds, gs] as const
  }
  // A low quantile first: even if a big smooth edit fills most of the flat
  // areas, the lower quarter of the differences is still redraw noise.
  // (Median ≈ 2.1 × lower quartile for this kind of noise.)
  const [d0, g0] = sample(null)
  const rough = fitNoiseModel(d0, g0, 0.25)
  let model = { a: rough.a * 2.1, b: rough.b * 2.1 }
  for (let pass = 0; pass < 2; pass++) {
    const [ds, gs] = sample(model)
    model = fitNoiseModel(ds, gs)
  }
  return model
}

function nearestOffset(
  marks: EditMark[],
  changed: boolean[],
  offsets: { dx: number; dy: number }[],
  x: number,
  y: number,
  fallback: { dx: number; dy: number },
): { dx: number; dy: number } {
  let best = -1
  let bestD = Infinity
  marks.forEach((m, i) => {
    if (!changed[i]) return
    const d = (m.x - x) ** 2 + (m.y - y) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best >= 0 ? offsets[best] : fallback
}

// Fine alignment where the seam will be: try small shifts of the answer and
// keep the one that matches the original best on the band around the change
function refineOffset(
  origRgb: Float32Array[],
  result: ImageBitmap,
  W: number,
  H: number,
  cw: number,
  ch: number,
  cx0: number,
  cy0: number,
  c: number,
  global: { dx: number; dy: number },
  changeC: Uint8Array,
  featherC: number,
  roomC: number,
): { dx: number; dy: number } {
  const R = LOCAL_ALIGN
  // Draw the answer with a margin so shifted reads stay inside
  const pw = cw + 2 * R
  const ph = ch + 2 * R
  const resP = readRgb(result, W, H, pw, ph, (global.dx - cx0) * c + R, (global.dy - cy0) * c + R, W * c, H * c)
  const near = dilate(changeC, cw, ch, featherC + roomC)
  const inner = dilate(changeC, cw, ch, featherC)
  const ring: number[] = []
  for (let p = 0; p < cw * ch; p++) if (near[p] && !inner[p]) ring.push(p)
  if (ring.length < 50) return global
  const stride = Math.max(1, Math.floor(ring.length / 20000))
  const gray = (rgb: Float32Array[], p: number) => 0.299 * rgb[0][p] + 0.587 * rgb[1][p] + 0.114 * rgb[2][p]

  let best = { sx: 0, sy: 0, err: Infinity }
  for (let sy = -R; sy <= R; sy++) {
    for (let sx = -R; sx <= R; sx++) {
      let err = 0
      let m = 0
      for (let i = 0; i < ring.length; i += stride) {
        const p = ring[i]
        const x = p % cw
        const y = (p - x) / cw
        const q = (y + R + sy) * pw + (x + R + sx)
        if (!resP.valid[q]) continue
        err += Math.abs(gray(origRgb, p) - gray(resP.rgb, q))
        m++
      }
      if (m === 0) continue
      err /= m
      // Prefer no extra shift unless it clearly helps
      if (sx !== 0 || sy !== 0) err += 0.15
      if (err < best.err) best = { sx, sy, err }
    }
  }
  // The answer's pixel at (x+sx, y+sy) matches the original at (x, y):
  // move the answer back by that much
  return { dx: global.dx - best.sx / c, dy: global.dy - best.sy / c }
}

// Pastes one area at full resolution; returns how many pixels were taken
function blendArea(
  octx: OffscreenCanvasRenderingContext2D,
  original: ImageBitmap,
  result: ImageBitmap,
  W: number,
  H: number,
  x0: number,
  y0: number,
  cw: number,
  ch: number,
  regionC: Uint8Array,
  rw: number,
  rh: number,
  offset: { dx: number; dy: number },
  fit: { a: Float32Array; b: Float32Array },
  feather: number,
): number {
  const n = cw * ch
  // Region at full resolution (smooth upscale, then re-binarised)
  const region = resampleMask(regionC, rw, rh, 0, 0, rw, rh, cw, ch)

  // Alpha: 0 exactly at the seam, 1 once `feather` px inside
  const outside = new Uint8Array(n)
  for (let p = 0; p < n; p++) outside[p] = region[p] ? 0 : 1
  const depth = distanceToSet(outside, cw, ch)
  const alpha = new Float32Array(n)
  let taken = 0
  for (let p = 0; p < n; p++) {
    if (!region[p]) continue
    const t = Math.min(1, depth[p] / feather)
    alpha[p] = t * t * (3 - 2 * t)
    if (alpha[p] > 0) taken++
  }
  if (taken === 0) return 0

  const base = octx.getImageData(x0, y0, cw, ch)
  const layerCanvas = new OffscreenCanvas(cw, ch)
  const lctx = layerCanvas.getContext('2d', { willReadFrequently: true })!
  lctx.imageSmoothingQuality = 'high'
  lctx.drawImage(result, 0, 0, result.width, result.height, offset.dx - x0, offset.dy - y0, W, H)
  const layer = lctx.getImageData(0, 0, cw, ch)

  // Local tone match + boundary correction, estimated on a small copy
  const bs = Math.min(1, BLEND_MAX / Math.max(cw, ch))
  const bw = Math.max(4, Math.round(cw * bs))
  const bh = Math.max(4, Math.round(ch * bs))
  const origSmall = smallCopy(original, x0, y0, cw, ch, bw, bh)
  const layerSmall = smallCopyOf(layerCanvas, bw, bh)
  const maskSmall = resampleMask(region, cw, ch, 0, 0, cw, ch, bw, bh)
  const corr = computeCorrection(origSmall, layerSmall, maskSmall, bw, bh)
  const field = corr.field.map((f) => upsample(f, bw, bh, cw, ch))
  // Fall back to the global colour fit when the crop has too little outside
  const a = corr.a[0] === 1 && corr.a[1] === 1 && corr.a[2] === 1 && corr.b[0] === 0 ? fit.a : corr.a
  const b = a === fit.a ? fit.b : corr.b

  // Grain: add noise where the answer is smoother than the original around it
  const sigmaOrig = sampleSigma(base.data, region, cw, ch, false)
  const sigmaRes = sampleSigma(layer.data, region, cw, ch, true)
  const addSigma = Math.min(12, Math.sqrt(Math.max(0, sigmaOrig * sigmaOrig - sigmaRes * sigmaRes)))
  let seed = 0x2545f491
  const rand = () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const bd = base.data
  const ld = layer.data
  for (let p = 0; p < n; p++) {
    const al = alpha[p]
    // Skip pixels the shifted answer doesn't fully cover (picture edges)
    if (al <= 0 || ld[p * 4 + 3] < 250) continue
    const noise = addSigma > 0.5 ? (rand() + rand() + rand() - 1.5) * (addSigma / 0.5) : 0
    const j = p * 4
    for (let k = 0; k < 3; k++) {
      let v = a[k] * ld[j + k] + b[k] + field[k][p] + noise
      v = v < 0 ? 0 : v > 255 ? 255 : v
      bd[j + k] = Math.round(bd[j + k] + (v - bd[j + k]) * al)
    }
  }
  octx.putImageData(base, x0, y0)
  return taken
}

// ---------------------------------------------------------------------------
// Pixel plumbing
// ---------------------------------------------------------------------------

// Draws `source` (scaled to the W×H frame of the original) into a w×h canvas
// at (ox, oy) with size (dw, dh), returning planar RGB and which pixels the
// source actually covered.
function readRgb(
  source: ImageBitmap,
  W: number,
  H: number,
  w: number,
  h: number,
  ox: number,
  oy: number,
  dw = w,
  dh = h,
): { rgb: Float32Array[]; valid: Uint8Array } {
  void W
  void H
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, source.width, source.height, ox, oy, dw, dh)
  const data = ctx.getImageData(0, 0, w, h).data
  const n = w * h
  const rgb = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  const valid = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    const a = data[p * 4 + 3]
    valid[p] = a >= 250 ? 1 : 0
    // un-premultiply edge pixels so a half-covered border isn't darkened
    const k = a > 0 ? 255 / a : 0
    rgb[0][p] = data[p * 4] * k
    rgb[1][p] = data[p * 4 + 1] * k
    rgb[2][p] = data[p * 4 + 2] * k
  }
  return { rgb, valid }
}

function applyFit(rgb: Float32Array[], fit: { a: Float32Array; b: Float32Array }, n: number): Float32Array[] {
  return rgb.map((ch, c) => {
    const out = new Float32Array(n)
    for (let p = 0; p < n; p++) out[p] = Math.min(255, Math.max(0, fit.a[c] * ch[p] + fit.b[c]))
    return out
  })
}

// Mask crop/resample: the (sx, sy, sw, sh) window of a w×h mask, scaled to
// dw×dh with smoothing and re-binarised at half coverage
function resampleMask(
  mask: Uint8Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array {
  const src = new OffscreenCanvas(w, h)
  const img = new ImageData(w, h)
  for (let p = 0; p < w * h; p++) img.data[p * 4 + 3] = mask[p] ? 255 : 0
  src.getContext('2d')!.putImageData(img, 0, 0)
  const dst = new OffscreenCanvas(dw, dh)
  const ctx = dst.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh)
  const data = ctx.getImageData(0, 0, dw, dh).data
  const out = new Uint8Array(dw * dh)
  for (let p = 0; p < out.length; p++) out[p] = data[p * 4 + 3] >= 128 ? 1 : 0
  return out
}

function smallCopy(
  source: ImageBitmap,
  x0: number,
  y0: number,
  cw: number,
  ch: number,
  bw: number,
  bh: number,
): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(bw, bh)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, x0, y0, cw, ch, 0, 0, bw, bh)
  return ctx.getImageData(0, 0, bw, bh).data
}

function smallCopyOf(source: OffscreenCanvas, bw: number, bh: number): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(bw, bh)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, bw, bh)
  return ctx.getImageData(0, 0, bw, bh).data
}

// Bilinear upsample of a small float field
function upsample(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh)
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / dh - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / dw - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const tx = fx - x0
      const top = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx
      const bottom = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx
      out[y * dw + x] = top * (1 - ty) + bottom * ty
    }
  }
  return out
}

// Robust noise estimate from neighbouring green pixels, inside or outside
// the region
function sampleSigma(data: Uint8ClampedArray, region: Uint8Array, w: number, h: number, inside: boolean): number {
  const diffs: number[] = []
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)))
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x + 1 < w; x += step) {
      const p = y * w + x
      const ok = inside ? region[p] && region[p + 1] : !region[p] && !region[p + 1]
      if (!ok) continue
      diffs.push(Math.abs(data[p * 4 + 1] - data[(p + 1) * 4 + 1]))
    }
  }
  return estimateNoiseSigma(diffs)
}

function discsAround(marks: EditMark[], changed: boolean[], w: number, h: number, r: number): Uint8Array {
  const mask = new Uint8Array(w * h)
  marks.forEach((m, i) => {
    if (changed[i]) paintDisc(mask, w, h, m.x * w, m.y * h, r)
  })
  return mask
}

function discs(marks: EditMark[], w: number, h: number, radius: number): Uint8Array {
  const mask = new Uint8Array(w * h)
  const r = radius * Math.min(w, h)
  for (const m of marks) paintDisc(mask, w, h, m.x * w, m.y * h, r)
  return mask
}

function count(mask: Uint8Array): number {
  let c = 0
  for (let p = 0; p < mask.length; p++) c += mask[p]
  return c
}
