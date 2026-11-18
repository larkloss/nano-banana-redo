// Pure compositing: no network, no UI. Runs in a Web Worker when it can
// (see localEditClient.ts), so a multi-second composite never freezes the page.
import type { EditMark } from './annotate'
import { analyzeResult, buildAnalysisContext, type AnalysisContext } from '../edit/lib/align'
import { computeCorrection, estimateNoiseSigma, linearFitOutside } from '../edit/lib/blend'
import {
  dilate,
  distanceToSet,
  enclosedHoles,
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
import { blockFlow, fitAxisScale, measureBlocks, warpPlanes, type FlowField } from './flow'

// ---------------------------------------------------------------------------
// "Only change around the arrows."
//
// Image models repaint the whole picture even for a small edit, so faces,
// eyes, skin and micro-expressions drift. This keeps only what the model
// actually changed around the arrows and takes every other pixel from the
// original, bit for bit (the result is always a PNG).
//
//  1. Place the answer on the original: its shift, its overall zoom (models
//     sometimes redraw a few percent larger or smaller), then a dense
//     alignment field for the gentle warp of a repaint. Undo its global
//     colour drift. All measured away from the arrows.
//  2. Find the change: a perceptual difference that forgives the 1px jitter
//     of a redraw, judged against the redraw noise measured around each
//     arrow. The edit is the changed object each arrow's tip points at —
//     not whatever else happens to have changed nearby, nor a face the model
//     re-toned right beside it — followed as far as the change is clear,
//     plus faint change right at its edges.
//  3. Per changed area: refine the alignment on the band where the seam will
//     go, then pick the seam itself with a minimum cut through the pixels
//     where the two pictures agree most, leaving room for the blend. Areas
//     the change only encloses (a face inside a recoloured hood, eyes behind
//     removed glasses) stay the original.
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
const MAX_REACH = 0.5 // each arrow's own noise level applies this far out
const FAR_REACH = 0.95 // clear change is followed this far from the tip
const CLOSE_RADIUS = 0.008 // joins fragments of one changed object
const WEAK_REACH = 2 // × CLOSE_RADIUS: faint change is only taken this close to clear change
const FEATHER = 0.012 // width of the blend ramp
const SEAM_ROOM = 0.035 // how far out the seam may wander to find agreement

const WORK_MAX = 768 // long side for change detection
const COARSE_MAX = 192 // long side for measuring the answer's zoom
const CROP_MAX = 900 // long side for seam search per changed area
const BLEND_MAX = 256 // long side for the boundary-correction field
const SHARP_MAX = 12e6 // px of one area resampled the careful way (memory, time)
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
// "The model changed it": at least this much clear change at the tip (work
// px), standing well out of the redraw noise somewhere (a redrawn texture —
// fine print, hair — can reach the size, never the contrast), or simply a
// lot of it
const SEED_FLOOR = 16
const SEED_PEAK = 12 // × noise
const SEED_PLENTY = 0.03 // of the core disc
const FLOW_MARGIN = 8 // ± px at work size the dense alignment may shift
const LOCAL_NOISE_CAP = 3 // local noise ≤ this × picture-wide noise
const NOISE_A_MAX = 6 // no redraw is noisier than this in flat areas
const NOISE_B_MAX = 0.3 // … or along edges (× edge strength)
const SCALE_MIN = 0.002 // smaller zooms are left to the dense alignment
const ZOOM_GAIN = 0.97 // a zoom must improve the match by this much to be used
const SCALE_MAX = 0.08
const AR_TOLERANCE = 0.03
const UNRELATED = 0.85 // share of detailed areas changed: a different picture
// Inside the extent of a thing (see ObjectExtent), an object that looks like
// what is behind it (an arm across a torso) changes clearly only along its
// outline, a thin line — the kind a redraw also leaves where an edge moved a
// little. The difference: a moved edge has its match a few pixels away in the
// other picture, an outline that appeared or disappeared has none.
//
// Outlines are only gone by inside such an extent. On their own they can't be
// told from fine lines of a face that the model erased or shifted, and faint
// change can't be told from a face it re-toned: followed without knowing where
// the thing is, they take faces.
const OUTLINE_TOLERANCE = 3 // px: no match this far around = not a moved edge
const OUTLINE_ONE_SIDED = 0.5 // one picture's edge there is at most this × the other's
// An extent a vision model gave for the thing an arrow points at
const EXTENT_MAX = 0.6 // of the picture: more than that is the scene, not a thing
const EXTENT_SLACK = 0.03 // the tip may be this far outside it (models are approximate)
// What an extent would take is "still there" — re-toned, not replaced — when
// the original's detail in its faint part came through with its strength:
// then the extent has taken in something else (a face no box was given for)
// and isn't used. A backstop, not a guarantee: it has nothing to go by on
// small or featureless faces.
// (see ownInGuard) px at work size of a thing outside a guard for its kind of
// change to be told
const OWN_THING = 2000
const STILL_AREA = 150 // px (work size) of faint change there has to be, to judge by
const STILL_DETAIL = 0.01 // of it: detail of the original there has to be, to judge by
const STILL_KEPT = 0.47 // of that detail that kept its strength (re-toned faces: 0.5 and up; things: under 0.45)
const STILL_MATCH = 0.35 // "kept": within this share of the original edge strength
const WIDESPREAD = 0.02 // share of the picture clearly changed away from the edit

export interface LocalEditInfo {
  // Per arrow: did the model change anything at its tip?
  arrowsChanged: boolean[]
  // Share of the picture taken from the model
  coverage: number
  // The change ran into the size limit — it may be bigger than what was kept
  reachedLimit: boolean
  // The model also clearly changed things away from the arrows (a new
  // lighting, a restyle): only the part around the arrows was kept
  widespread: boolean
  // Per arrow, when extents were given: was the arrow's extent gone by?
  // (false: none given, it didn't hold the tip, it was the whole scene, or
  // what it held at the tip was still there)
  extentsUsed?: boolean[]
}

// Detection numbers per arrow, for tuning and diagnostics
export interface ArrowStats {
  offset: [number, number]
  // redraw noise model: a + b·edge strength
  noise: [number, number]
  // clear-change pixels near the tip, and how many of them belong to the
  // object(s) taken as the edit
  seeds: number
  mass: number
  // distance from the tip to that object (work px), and its contrast
  near: number
  peak: number
  changed: boolean
  // With an extent: [share of what it would take that is detail of the
  // original, share of that detail that kept its strength] — see STILL_*
  still?: [number, number]
}
let lastStats: ArrowStats[] = []
let lastDebug: {
  w: number
  h: number
  grown: Uint8Array
  globalNoise?: [number, number]
  zoom?: [number, number]
  zoomCheck?: number[]
  widespread?: number
  maps?: Record<string, Uint8Array>
} | null = null
export function lastLocalEditStats(): ArrowStats[] {
  return lastStats
}
export function lastLocalEditDebug() {
  return lastDebug
}

export interface LocalEditJob {
  original: ImageBitmap
  marks: EditMark[]
  W: number
  H: number
  w: number
  h: number
  analysis: AnalysisContext
  origRgb: Float32Array[]
  // Pixels of the original that are opaque (only those can be compared)
  origValid: Uint8Array
  // Detection planes (Y'CbCr, lightly blurred) and edge strength of the original
  origDet: Float32Array[]
  origGrad: Float32Array
  zones: Uint8Array
  // Small luma copy for measuring the answer's zoom
  coarse: { w: number; h: number; gray: Float32Array; zones: Uint8Array }
}

export async function prepareLocalEdit(source: Blob, marks: EditMark[]): Promise<LocalEditJob> {
  const original = await createImageBitmap(source)
  const W = original.width
  const H = original.height
  const s = Math.min(1, WORK_MAX / Math.max(W, H))
  const w = Math.max(16, Math.round(W * s))
  const h = Math.max(16, Math.round(H * s))
  const zones = discs(marks, w, h, ZONE_RADIUS)
  const analysis = buildAnalysisContext(original, (aw, ah) => discs(marks, aw, ah, ZONE_RADIUS))
  const orig = readRgb(original, w, h, frameRect(W, H, w, h))
  const origDet = toYcc(orig.rgb, w * h).map((c) => gaussianBlur(c, w, h, DETECT_BLUR))

  const cs = Math.min(1, COARSE_MAX / Math.max(W, H))
  const cw = Math.max(16, Math.round(W * cs))
  const ch = Math.max(16, Math.round(H * cs))
  const coarseRgb = readRgb(original, cw, ch, frameRect(W, H, cw, ch)).rgb
  const coarseGray = gaussianBlur(toYcc(coarseRgb, cw * ch)[0], cw, ch, DETECT_BLUR)
  return {
    original,
    marks,
    W,
    H,
    w,
    h,
    analysis,
    origRgb: orig.rgb,
    origValid: orig.valid,
    origDet,
    origGrad: gradientMagnitude(origDet[0], w, h),
    zones,
    coarse: { w: cw, h: ch, gray: coarseGray, zones: discs(marks, cw, ch, ZONE_RADIUS) },
  }
}

export function releaseLocalEdit(job: LocalEditJob): void {
  job.original.close()
}

// A rectangle of the picture, as fractions of its width and height
export interface Area {
  x0: number
  y0: number
  x1: number
  y1: number
}

// Where the thing an arrow points at is, as a vision model sees it: its box
// and, if the model gave one, its silhouette (a picture of the box's area,
// light where the thing is)
export interface ObjectExtent {
  box: Area
  mask?: Blob
}

// A spot the user picked on a finished edit: take everything the model drew
// within `r` (of the picture's shorter side) of it, or put the original back
export interface Touch {
  x: number
  y: number
  r: number
  take: boolean
}

export interface LocalEditOptions {
  // Per arrow, in the arrows' order (null: not found). Inside an extent even
  // faint change belongs to the edit.
  extents?: (ObjectExtent | null)[]
  // Faces and the like: nothing is taken there on the strength of an outline
  // or an extent (clear change at an arrow still is)
  guarded?: Area[]
  touches?: Touch[]
}

export type LocalComposite =
  | { kind: 'ok'; blob: Blob; mask: Blob; info: LocalEditInfo }
  // `final`: trying again can't help (the model can't keep the picture's shape)
  | { kind: 'reject'; reason: string; final?: boolean }

const SHAPE_REJECT = 'the model changed the picture’s shape'
// Colour of the "what changed" overlay (RGBA)
const OVERLAY_TINT = [217, 70, 239, 140]

// Takes over `result`: it is closed as soon as it has been read, so the caller
// must not use it afterwards (closing it again does no harm).
//
// A 4K picture is 64 MB each time it is held decoded, so the steps below are
// separate functions on purpose: what a step only needed on the way is out of
// reach when it returns, instead of staying until the whole composite is done.
export async function composeLocalEdit(
  job: LocalEditJob,
  result: ImageBitmap,
  options: LocalEditOptions = {},
): Promise<LocalComposite> {
  const { W, H, w, h } = job
  const sx = w / W
  const sy = h / H

  let placed: Placed | null
  try {
    placed = placeAnswer(job, result)
  } finally {
    // From here on only the extended copy is read
    result.close()
  }
  if (!placed) return { kind: 'reject', reason: SHAPE_REJECT, final: true }
  const { answer, fit } = placed

  const featherFull = Math.max(2, FEATHER * Math.min(W, H))
  const roomFull = Math.max(6, SEAM_ROOM * Math.min(W, H))
  const found = await findAreas(job, placed, options, featherFull, roomFull)
  if ('reject' in found) {
    discard(answer.canvas)
    return { kind: 'reject', reason: found.reject }
  }

  const out = new OffscreenCanvas(W, H)
  const octx = out.getContext('2d', { willReadFrequently: true })!
  octx.drawImage(job.original, 0, 0)
  const overlay = new OffscreenCanvas(w, h)
  const ovctx = overlay.getContext('2d')!
  let takenFull = 0

  for (let k = 1; k <= found.clusters; k++) {
    // 3. Seam per changed area, at a finer crop resolution
    const seam = seamAround(job, answer, found, k, fit, featherFull, roomFull)
    if (!seam) continue
    const { cx0, cy0, cropW, cropH, cw, ch, region } = seam

    // 4. Blend at full resolution
    takenFull += blendArea(
      octx,
      job.original,
      answer,
      W,
      H,
      cx0,
      cy0,
      cropW,
      cropH,
      region,
      cw,
      ch,
      seam.offset,
      fit,
      featherFull,
    )

    // Overlay for the UI: the area taken from the model, at work resolution
    // (a see-through tint, ready to lay over the picture)
    const nc = cw * ch
    const regionCanvas = new OffscreenCanvas(cw, ch)
    const rimg = new ImageData(cw, ch)
    for (let p = 0; p < nc; p++) {
      rimg.data[p * 4] = OVERLAY_TINT[0]
      rimg.data[p * 4 + 1] = OVERLAY_TINT[1]
      rimg.data[p * 4 + 2] = OVERLAY_TINT[2]
      rimg.data[p * 4 + 3] = region[p] ? OVERLAY_TINT[3] : 0
    }
    regionCanvas.getContext('2d')!.putImageData(rimg, 0, 0)
    ovctx.drawImage(regionCanvas, cx0 * sx, cy0 * sy, cropW * sx, cropH * sy)
  }

  // Every area has been pasted: the answer is not read again, and the encoder
  // below needs room of its own
  discard(answer.canvas)
  if (takenFull === 0) {
    discard(out)
    return { kind: 'reject', reason: 'no change near the arrows' }
  }

  // Always lossless: a JPEG would re-encode — and shift — every pixel the
  // edit was meant to leave alone
  const blob = await out.convertToBlob({ type: 'image/png' })
  discard(out)
  const mask = await overlay.convertToBlob({ type: 'image/png' })
  return {
    kind: 'ok',
    blob,
    mask,
    info: {
      arrowsChanged: found.arrowsChanged,
      coverage: takenFull / (W * H),
      reachedLimit: found.reachedLimit,
      widespread: found.awayShare > WIDESPREAD,
      ...(options.extents ? { extentsUsed: found.extentsUsed } : {}),
    },
  }
}

// The answer laid on the original: where, with which colour fit, and its
// pixels extended past its own edges
interface Placed {
  place: Placement
  fit: { a: Float32Array; b: Float32Array }
  zoomCheck: number[]
  answer: Answer
}

// 1. Where the answer sits on the original, and its colour drift — both
// measured away from the arrows, where nothing should have changed. Null: the
// answer has another shape than the picture.
function placeAnswer(job: LocalEditJob, result: ImageBitmap): Placed | null {
  const { W, H, w, h } = job
  const sx = w / W
  const sy = h / H

  const arO = W / H
  const arR = result.width / result.height
  if (Math.abs(arR - arO) / arO > AR_TOLERANCE) return null

  const shift = analyzeResult(job.analysis, result)
  let place: Placement = { dx: shift.dx, dy: shift.dy, sx: 1, sy: 1 }
  const unzoomed = colourFitAt(job, result, place)
  let fit = unzoomed.fit
  const zoomed = measureZoom(job, result, place, fit)
  let zoomCheck: number[] = []
  if (zoomed) {
    // Only if it really lines the pictures up better (a big edit can fool
    // the measurement)
    const tried = colourFitAt(job, result, zoomed)
    zoomCheck = [unzoomed.mismatch, tried.mismatch, zoomed.sx, zoomed.sy]
    if (tried.mismatch < ZOOM_GAIN * unzoomed.mismatch) {
      place = zoomed
      fit = tried.fit
    }
  }

  // The answer, extended past its edges so that, however it's shifted or
  // scaled, it covers the whole picture
  const cMin = Math.min(1, CROP_MAX / Math.max(W, H))
  const margin =
    Math.max(Math.abs(place.dx), Math.abs(place.dy)) +
    Math.max(W * Math.abs(place.sx - 1), H * Math.abs(place.sy - 1)) +
    (FLOW_MARGIN + 2) / Math.min(sx, sy) +
    (2 * LOCAL_ALIGN + 2) / cMin +
    8
  return { place, fit, zoomCheck, answer: extendAnswer(result, W, H, margin) }
}

// The changed areas to paste, at work size: all that the steps after the
// detection read of it
interface ChangedAreas {
  grown: Uint8Array
  // Area number per pixel (1…clusters; 0: none), with room for seam and blend
  labels: Int32Array
  clusters: number
  // Per area, where the search for its exact placement starts
  starts: Placement[]
  keepOut?: Uint8Array | null
  forbidden?: Uint8Array | null
  arrowsChanged: boolean[]
  reachedLimit: boolean
  awayShare: number
  extentsUsed?: boolean[]
}

// 2. Where did it change?
async function findAreas(
  job: LocalEditJob,
  { answer, place, fit, zoomCheck }: Placed,
  options: LocalEditOptions,
  featherFull: number,
  roomFull: number,
): Promise<ChangedAreas | { reject: string }> {
  const { W, H, w, h } = job
  const n = w * h
  const sx = w / W
  const sy = h / H

  // Compare every pixel at its own alignment: a dense displacement field
  // follows the slight warp of a repaint, so redrawn edges don't pass for
  // changes.
  const M = FLOW_MARGIN
  const pw = w + 2 * M
  const ph = h + 2 * M
  const pn = pw * ph
  const padded = readAnswer(answer, pw, ph, placeRect(place, W, H, -M / sx, -M / sy, sx, sy), true)
  const paddedDet = toYcc(applyFit(padded.rgb, fit, pn), pn).map((c) => gaussianBlur(c, pw, ph, DETECT_BLUR))
  const flow = blockFlow(job.origDet[0], w, h, paddedDet[0], padded.valid, M)
  const aligned = warpPlanes(paddedDet, padded.valid, w, h, M, flow)
  const diff = tolerantLabDistance(job.origDet, aligned.planes, w, h, 1)
  const valid = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    valid[p] = aligned.valid[p] && job.origValid[p] ? 1 : 0
    if (!valid[p]) diff[p] = 0
  }

  // Redraw noise: how different the answer is where nothing changed, as a
  // function of edge strength
  const globalModel = robustNoiseModel(diff, job.origGrad, (p) => valid[p] === 1 && !job.zones[p], w, h)
  lastStats = []
  lastDebug = {
    w,
    h,
    grown: new Uint8Array(0),
    globalNoise: [globalModel.a, globalModel.b],
    zoom: [place.sx, place.sy],
    zoomCheck,
  }
  if (looksUnrelated(diff, job.origGrad, gradientMagnitude(aligned.planes[0], w, h), valid, job.zones, n))
    return { reject: 'the model drew a different picture' }

  const hints = await readHints(job, options)
  const found = detectChange(job, diff, valid, globalModel, flow, aligned.planes, hints)
  lastStats = found.stats
  lastDebug = { ...lastDebug, grown: found.grown.slice(), widespread: found.awayShare, maps: found.maps }
  if (!found.arrowsChanged.some(Boolean) && !hints.taken) return { reject: 'no change near the arrows' }
  const { grown } = found

  // One area per connected part of the change, with room for seam and blend
  const mayWork = dilate(grown, w, h, (featherFull + roomFull) * Math.min(sx, sy))
  const { labels, count: clusters } = labelComponents(mayWork, w, h)
  const starts = clusterPlacements(labels, clusters, grown, aligned.valid, flow, place, w, h, sx, sy)
  return {
    grown,
    labels,
    clusters,
    starts,
    keepOut: found.keepOut,
    forbidden: found.forbidden,
    arrowsChanged: found.arrowsChanged,
    reachedLimit: found.reachedLimit,
    awayShare: found.awayShare,
    extentsUsed: found.extentsUsed,
  }
}

// 3. Where area `k` is cut out: its crop box (original px), the region to
// take inside it (at crop resolution, cw×ch) and the answer's exact placement
// there. Null: too small an area to work on.
function seamAround(
  job: LocalEditJob,
  answer: Answer,
  found: ChangedAreas,
  k: number,
  fit: { a: Float32Array; b: Float32Array },
  featherFull: number,
  roomFull: number,
): {
  cx0: number
  cy0: number
  cropW: number
  cropH: number
  cw: number
  ch: number
  region: Uint8Array
  offset: Placement
} | null {
  const { W, H, w, h } = job
  const n = w * h
  const sx = w / W
  const sy = h / H
  const { grown, labels, starts } = found

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
  const cx0 = Math.max(0, Math.floor(bx0 / sx - pad))
  const cy0 = Math.max(0, Math.floor(by0 / sy - pad))
  const cx1 = Math.min(W, Math.ceil((bx1 + 1) / sx + pad))
  const cy1 = Math.min(H, Math.ceil((by1 + 1) / sy + pad))
  const cropW = cx1 - cx0
  const cropH = cy1 - cy0
  if (cropW < 4 || cropH < 4) return null

  const c = Math.min(1, CROP_MAX / Math.max(cropW, cropH))
  const cw = Math.max(4, Math.round(cropW * c))
  const ch = Math.max(4, Math.round(cropH * c))
  const rx = cw / cropW
  const ry = ch / cropH

  // This area's share of the detected change, at crop resolution
  const grownK = new Uint8Array(n)
  for (let p = 0; p < n; p++) grownK[p] = grown[p] && labels[p] === k ? 1 : 0
  const changeC = resampleMask(grownK, w, h, cx0 * sx, cy0 * sy, cropW * sx, cropH * sy, cw, ch)

  const origC = readRgb(job.original, cw, ch, placeRect(IDENTITY, W, H, cx0, cy0, rx, ry))
  const offset = refineOffset(
    origC.rgb,
    answer,
    W,
    H,
    cw,
    ch,
    cx0,
    cy0,
    rx,
    ry,
    starts[k],
    changeC,
    featherFull * c,
    roomFull * c,
  )
  const resC = readAnswer(answer, cw, ch, placeRect(offset, W, H, cx0, cy0, rx, ry), false)

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
  // What the change only surrounds (eyes inside removed glasses, a face
  // inside a recoloured hood) is not part of it: beyond the blend band
  // around the change, those pockets keep the original
  const pockets = enclosedHoles(changeC, cw, ch)
  if (found.keepOut) {
    const outC = resampleMask(found.keepOut, w, h, cx0 * sx, cy0 * sy, cropW * sx, cropH * sy, cw, ch)
    for (let p = 0; p < nc; p++) if (outC[p]) pockets[p] = 1
  }
  // … and in guarded areas and where the user put the original back,
  // nothing is taken at all
  const backC = found.forbidden
    ? resampleMask(found.forbidden, w, h, cx0 * sx, cy0 * sy, cropW * sx, cropH * sy, cw, ch)
    : null
  for (let p = 0; p < nc; p++) {
    if (!resC.valid[p] || !origC.valid[p] || (backC && backC[p])) {
      may[p] = 0
      must[p] = 0
    } else if (pockets[p] && !must[p]) may[p] = 0
  }
  const region = optimalSeamRegion(must, may, cost, cw, ch)
  return { cx0, cy0, cropW, cropH, cw, ch, region, offset }
}

// ---------------------------------------------------------------------------
// Placement: where the answer lands on the original
// ---------------------------------------------------------------------------

// The answer (stretched to the original's W×H frame) is drawn at (dx, dy)
// with size (W·sx, H·sy), in original px
interface Placement {
  dx: number
  dy: number
  sx: number
  sy: number
}
const IDENTITY: Placement = { dx: 0, dy: 0, sx: 1, sy: 1 }

interface Rect {
  ox: number
  oy: number
  dw: number
  dh: number
}

// Where the W×H frame goes in a canvas whose pixel (0,0) is original
// (x0, y0), at rx×ry canvas px per original px
function placeRect(t: Placement, W: number, H: number, x0: number, y0: number, rx: number, ry: number): Rect {
  return { ox: (t.dx - x0) * rx, oy: (t.dy - y0) * ry, dw: W * t.sx * rx, dh: H * t.sy * ry }
}

function frameRect(W: number, H: number, w: number, h: number): Rect {
  return placeRect(IDENTITY, W, H, 0, 0, w / W, h / H)
}

// The colour fit for the answer at this placement, and how well the two
// pictures then match away from the arrows (mean luma difference over the
// better-matching 70%, so a big edit elsewhere doesn't dominate it)
function colourFitAt(
  job: LocalEditJob,
  result: ImageBitmap,
  place: Placement,
): { fit: { a: Float32Array; b: Float32Array }; mismatch: number } {
  const { W, H, w, h } = job
  const n = w * h
  const res = readRgb(result, w, h, placeRect(place, W, H, 0, 0, w / W, h / H))
  const exclude = new Uint8Array(n)
  for (let p = 0; p < n; p++) exclude[p] = job.zones[p] || !res.valid[p] || !job.origValid[p] ? 1 : 0
  const fit = robustColourFit(job.origRgb, res.rgb, exclude, n)
  const step = Math.max(1, Math.floor(n / 60000))
  const errs: number[] = []
  const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b
  for (let p = 0; p < n; p += step) {
    if (exclude[p]) continue
    const o = luma(job.origRgb[0][p], job.origRgb[1][p], job.origRgb[2][p])
    const r = luma(
      fit.a[0] * res.rgb[0][p] + fit.b[0],
      fit.a[1] * res.rgb[1][p] + fit.b[1],
      fit.a[2] * res.rgb[2][p] + fit.b[2],
    )
    errs.push(Math.abs(o - r))
  }
  errs.sort((x, y) => x - y)
  const kept = errs.slice(0, Math.max(1, Math.floor(errs.length * 0.7)))
  const mismatch = kept.length > 0 ? kept.reduce((acc, v) => acc + v, 0) / kept.length : 0
  return { fit, mismatch }
}

// The answer's overall zoom, measured on small copies with a search wide
// enough for a few percent of scale. Returns the refined placement, or null
// when there's no clear zoom (the dense alignment handles the rest).
function measureZoom(
  job: LocalEditJob,
  result: ImageBitmap,
  place: Placement,
  fit: { a: Float32Array; b: Float32Array },
): Placement | null {
  const { W, H } = job
  const { w: cw, h: ch, gray, zones } = job.coarse
  const rx = cw / W
  const ry = ch / H
  const M = FLOW_MARGIN
  const pw = cw + 2 * M
  const ph = ch + 2 * M
  const padded = readRgb(result, pw, ph, placeRect(place, W, H, -M / rx, -M / ry, rx, ry))
  const luma = gaussianBlur(toYcc(applyFit(padded.rgb, fit, pw * ph), pw * ph)[0], pw, ph, DETECT_BLUR)
  const grid = measureBlocks(gray, cw, ch, luma, padded.valid, M)
  const zoom = fitAxisScale(grid, cw, ch, (x, y) => zones[Math.min(ch - 1, Math.round(y)) * cw + Math.min(cw - 1, Math.round(x))] === 1)
  if (!zoom) return null
  const big = Math.max(Math.abs(zoom.ax), Math.abs(zoom.ay))
  if (big < SCALE_MIN || big > SCALE_MAX) return null
  // Displacement in original px: U(X) = ax·(X − Xc) + Bx. Drawing the old
  // placement at X + U(X) shows original X; fold that into the placement.
  const Xc = zoom.xc / rx
  const Yc = zoom.yc / ry
  const Bx = zoom.bx / rx
  const By = zoom.by / ry
  return {
    dx: (zoom.ax * Xc - Bx + place.dx) / (1 + zoom.ax),
    dy: (zoom.ay * Yc - By + place.dy) / (1 + zoom.ay),
    sx: place.sx / (1 + zoom.ax),
    sy: place.sy / (1 + zoom.ay),
  }
}

// Each changed area's starting alignment: the dense field's median over the
// band around it, where the seam will run
function clusterPlacements(
  labels: Int32Array,
  clusters: number,
  grown: Uint8Array,
  valid: Uint8Array,
  flow: FlowField,
  place: Placement,
  w: number,
  h: number,
  sx: number,
  sy: number,
): Placement[] {
  const us: number[][] = Array.from({ length: clusters + 1 }, () => [])
  const vs: number[][] = Array.from({ length: clusters + 1 }, () => [])
  const all: number[][] = Array.from({ length: clusters + 1 }, () => [])
  const n = w * h
  for (let p = 0; p < n; p++) {
    const k = labels[p]
    if (!k || !valid[p]) continue
    if (!grown[p]) {
      us[k].push(flow.u[p])
      vs[k].push(flow.v[p])
    }
    all[k].push(p)
  }
  const out: Placement[] = [place]
  for (let k = 1; k <= clusters; k++) {
    let u = us[k]
    let v = vs[k]
    if (u.length < 20) {
      u = all[k].map((p) => flow.u[p])
      v = all[k].map((p) => flow.v[p])
    }
    const mu = u.length > 0 ? quantile(u, 0.5) : 0
    const mv = v.length > 0 ? quantile(v, 0.5) : 0
    // Answer pixel (x+u, y+v) shows original (x, y): move it back by that
    out.push({ ...place, dx: place.dx - mu / sx, dy: place.dy - mv / sy })
  }
  return out
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

interface NoiseModel {
  a: number
  b: number
}

interface Detection {
  arrowsChanged: boolean[]
  grown: Uint8Array
  // Parts that changed only as the model's drift: kept from the original
  keepOut?: Uint8Array | null
  // Where nothing may be taken at all (guarded areas, spots put back)
  forbidden?: Uint8Array | null
  extentsUsed?: boolean[]
  reachedLimit: boolean
  // share of the picture clearly changed away from the edit
  awayShare: number
  stats: ArrowStats[]
  maps?: Record<string, Uint8Array>
}

function detectChange(
  job: LocalEditJob,
  diff: Float32Array,
  valid: Uint8Array,
  globalModel: NoiseModel,
  flow: FlowField,
  answerDet: Float32Array[],
  hints: Hints,
): Detection {
  const { w, h, marks, origGrad: grad } = job
  const n = w * h
  const unitW = Math.min(w, h)
  const reach = Math.max(8, MAX_REACH * unitW)
  const core = Math.max(4, CORE_RADIUS * unitW)
  const closeR = Math.max(1, Math.round(CLOSE_RADIUS * unitW))
  const farReach = Math.max(reach, FAR_REACH * unitW)

  // Redraw noise next to each arrow; each pixel within reach of an arrow is
  // judged by the nearest arrow's level, the rest by the picture-wide one
  const models = marks.map((mark) => localNoiseModel(mark, diff, grad, valid, globalModel, w, h, reach))
  const owner = new Int16Array(n).fill(-1)
  const ownerD2 = new Float32Array(n).fill(Infinity)
  const coreMask = new Uint8Array(n)
  marks.forEach((mark, i) => {
    const cx = mark.x * w
    const cy = mark.y * h
    forDisc(cx, cy, reach, w, h, (p, d2) => {
      if (d2 < ownerD2[p]) {
        ownerD2[p] = d2
        owner[p] = i
      }
    })
    paintDisc(coreMask, w, h, cx, cy, core)
  })
  const strong = new Uint8Array(n)
  const weak = new Uint8Array(n)
  const ratio = new Float32Array(n)
  const high = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    if (!valid[p]) continue
    const m = owner[p] >= 0 ? models[owner[p]] : globalModel
    const noise = m.a + m.b * grad[p]
    ratio[p] = diff[p] / noise
    high[p] = Math.max(HIGH_MIN, HIGH_K * noise)
    if (diff[p] > high[p]) strong[p] = 1
    if (diff[p] > Math.max(LOW_MIN, LOW_K * noise)) weak[p] = 1
  }

  // Clear change, as objects. Opening drops the thin lines a redraw leaves
  // along edges (but not right at a tip, where a thin change — a stray
  // hair, a cable — can be the edit); closing joins the fragments of one
  // changed object.
  const opened = open(strong, w, h, 1)
  // Thin lines of clear change that are outlines existing in one picture only
  // (an edge only one of the two has; a recoloured strand is an edge in
  // both), away from the solid changes, whose rims are thin too. Only looked
  // for when the extent of a thing is known.
  const outline = new Uint8Array(n)
  const answerGrad = hints.extents.some(Boolean) ? gradientMagnitude(answerDet[0], w, h) : null
  if (answerGrad) {
    const bulk = open(strong, w, h, Math.max(2, closeR))
    const nearBulk = dilate(bulk, w, h, closeR + 1)
    for (let p = 0; p < n; p++) {
      if (!strong[p] || bulk[p] || nearBulk[p]) continue
      if (!oneSidedEdge(grad, answerGrad, w, h, p, 2)) continue
      if (unmatchedAround(job.origDet, answerDet, w, h, p, OUTLINE_TOLERANCE) > high[p]) outline[p] = 1
    }
  }
  // What is taken because it lies in a thing's extent
  const outlined = new Uint8Array(n)
  const extentsUsed = marks.map(() => false)
  const objects = opened.slice()
  for (let p = 0; p < n; p++) if (strong[p] && coreMask[p]) objects[p] = 1
  const joined = erode(dilate(objects, w, h, closeR), w, h, closeR)
  for (let p = 0; p < n; p++) if (!valid[p]) joined[p] = 0
  const { labels } = labelComponents(joined, w, h)

  // Per arrow: the changed object the tip points at. If the tip sits on or
  // next to one, that's the edit, and nothing else that changed nearby (the
  // model retouching the eyes next to a removed crumb). If it sits in a gap
  // between several (an arrow at a group of things), all the comparable
  // ones count.
  const touch = Math.max(2, closeR)
  const keep = new Set<number>()
  const arrowsChanged: boolean[] = []
  const stats: ArrowStats[] = []
  marks.forEach((mark, i) => {
    const cx = mark.x * w
    const cy = mark.y * h
    const near = new Map<number, number>()
    const mass = new Map<number, number>()
    const peak = new Map<number, number>()
    let seeds = 0
    forDisc(cx, cy, core, w, h, (p, d2) => {
      if (!strong[p] || !labels[p]) return
      seeds++
      const l = labels[p]
      near.set(l, Math.min(near.get(l) ?? Infinity, Math.sqrt(d2)))
      mass.set(l, (mass.get(l) ?? 0) + 1)
      peak.set(l, Math.max(peak.get(l) ?? 0, ratio[p]))
    })
    let first = -1
    for (const [l, d] of near) if (first < 0 || d < near.get(first)!) first = l
    const kept = first < 0 ? [] : [first]
    if (first >= 0 && near.get(first)! > touch)
      for (const [l, m] of mass) if (l !== first && m >= mass.get(first)! / 3) kept.push(l)
    const keptMass = kept.reduce((acc, l) => acc + mass.get(l)!, 0)
    const keptPeak = kept.reduce((acc, l) => Math.max(acc, peak.get(l)!), 0)
    const seeded =
      keptMass >= SEED_FLOOR && (keptPeak >= SEED_PEAK || keptMass >= SEED_PLENTY * Math.PI * core * core)
    if (seeded) kept.forEach((l) => keep.add(l))
    // The tip may sit in a thing a vision model has found the extent of:
    // what changed there, however faintly, in one piece with the tip
    const within =
      hints.extents[i] && answerGrad
        ? changedWithin(cx, cy, core, hints.extents[i]!, weak, strong, outline, grad, answerGrad, valid, hints.guarded, w, h, closeR)
        : null
    if (within?.piece) {
      extentsUsed[i] = true
      for (let p = 0; p < n; p++) if (within.piece[p]) outlined[p] = 1
    }
    const changed = seeded || Boolean(within?.piece)
    arrowsChanged.push(changed)
    const tx = Math.min(w - 1, Math.max(0, Math.round(cx)))
    const ty = Math.min(h - 1, Math.max(0, Math.round(cy)))
    stats.push({
      offset: [flow.u[ty * w + tx], flow.v[ty * w + tx]],
      noise: [models[i].a, models[i].b],
      seeds,
      mass: keptMass,
      near: first >= 0 ? near.get(first)! : -1,
      peak: keptPeak,
      changed,
      ...(within ? { still: within.still } : {}),
    })
  })
  if (!arrowsChanged.some(Boolean)) {
    const grown = new Uint8Array(n)
    if (hints.taken) for (let p = 0; p < n; p++) if (hints.taken[p] && valid[p] && !hints.restored?.[p]) grown[p] = 1
    // (guards hold here too: no arrow has an object of its own in them)
    let forbidden: Uint8Array | null = null
    if (hints.guarded || hints.restored) {
      forbidden = new Uint8Array(n)
      for (let p = 0; p < n; p++)
        forbidden[p] = (hints.guarded?.[p] && !hints.taken?.[p]) || hints.restored?.[p] ? 1 : 0
    }
    return { arrowsChanged, grown, forbidden, reachedLimit: false, awayShare: 0, stats, extentsUsed }
  }

  // The edit: those objects, followed as far as the change stays clear
  // (within FAR_REACH of a changed arrow) — a whole recoloured saucer is
  // taken whole
  const farMask = discsAround(marks, arrowsChanged, w, h, farReach)
  const allowed = new Uint8Array(n)
  const seeds = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    if (!labels[p] || !keep.has(labels[p]) || !farMask[p]) continue
    allowed[p] = 1
    if (strong[p] && coreMask[p]) seeds[p] = 1
  }
  const edit = growFrom(seeds, allowed, w, h)
  // Guarded areas (faces) keep the original — all but what of the arrows' own
  // object lies in them (a mole the arrow is on, a recoloured fringe hanging
  // into the face's box): see ownInGuard
  const barred = new Uint8Array(n)
  // … and that part gets the room around it that a seam and a blend need
  let roomInGuard: Uint8Array | null = null
  if (hints.guarded) {
    const tipInGuard = marks.some((m) => {
      const x = Math.min(w - 1, Math.max(0, Math.round(m.x * w)))
      const y = Math.min(h - 1, Math.max(0, Math.round(m.y * h)))
      return hints.guarded![y * w + x] === 1
    })
    const own = ownInGuard(edit, seeds, hints.guarded, coreMask, tipInGuard, job.origDet, answerDet, w, h)
    for (let p = 0; p < n; p++) {
      if (!hints.guarded[p]) continue
      if (own[p]) continue
      barred[p] = 1
      edit[p] = 0
    }
    roomInGuard = dilate(own, w, h, Math.max(2, FEATHER * unitW) + 2)
  }
  for (let p = 0; p < n; p++) if (outlined[p] && !barred[p]) edit[p] = 1
  const firstEdit = edit.slice()

  // The rest of the same object, where its change is interrupted for a
  // moment — a cable crossing a patch it doesn't contrast with, a shape cut
  // by an edge: clear change within a few pixels of the edit, or touching
  // the faint change right at its edges. Nothing further: a separate change
  // close by (a retouched eye next to recoloured hair) is not the edit.
  const weakReach = WEAK_REACH * closeR
  for (let hop = 0; hop < 4; hop++) {
    const fromEdit = distanceToSet(edit, w, h)
    const zone = new Uint8Array(n)
    for (let p = 0; p < n; p++) zone[p] = edit[p] || (weak[p] && fromEdit[p] <= weakReach) ? 1 : 0
    const reached = growFrom(edit, zone, w, h)
    const joins = new Set<number>()
    for (let p = 0; p < n; p++) {
      const l = labels[p]
      if (!l || keep.has(l) || !farMask[p]) continue
      const x = p % w
      if (
        fromEdit[p] <= closeR ||
        (x > 0 && reached[p - 1]) ||
        (x < w - 1 && reached[p + 1]) ||
        (p >= w && reached[p - w]) ||
        (p + w < n && reached[p + w])
      )
        joins.add(l)
    }
    if (joins.size === 0) break
    joins.forEach((l) => keep.add(l))
    for (let p = 0; p < n; p++) if (labels[p] && joins.has(labels[p]) && farMask[p] && !barred[p]) edit[p] = 1
  }

  // Plus faint change right at its edges (soft shadows, anti-aliasing, the
  // tail of a gradient) — but only right there: faint differences further
  // out are the redraw's own drift (a slightly brighter face, raised brows)
  const fromEdit = distanceToSet(edit, w, h)
  const zone = new Uint8Array(n)
  for (let p = 0; p < n; p++) zone[p] = edit[p] || (weak[p] && fromEdit[p] <= weakReach) ? 1 : 0
  const grown = growFrom(edit, zone, w, h)
  // The model often re-tones what's next to the edit too (a face a little
  // brighter or warmer beside recoloured hair). Touching the edit, that reads
  // as the same connected change — but it's a different kind of change, and
  // the original keeps it.
  // (the change right at each tip is the edit, whatever else is near it)
  const atTips = new Uint8Array(n)
  marks.forEach((mark, i) => {
    if (!arrowsChanged[i]) return
    let nearest = Infinity
    forDisc(mark.x * w, mark.y * h, core, w, h, (p, d2) => {
      if (seeds[p]) nearest = Math.min(nearest, d2)
    })
    // (an arrow gone by its extent alone has no clear change at its tip)
    if (nearest === Infinity) return
    const r = Math.sqrt(nearest) + touch
    forDisc(mark.x * w, mark.y * h, r, w, h, (p) => {
      if (seeds[p]) atTips[p] = 1
    })
  })
  // (what lies in a thing's extent is that thing, however evenly it changed)
  const drift = toneDrift(grown, atTips, job.origDet, answerDet, valid, w, h)
  if (drift) for (let p = 0; p < n; p++) if (drift[p] && !outlined[p]) grown[p] = 0
  // Specks inside the change belong to it; anything bigger it surrounds
  // (a face inside a recoloured hood) does not
  fillSmallHoles(grown, w, h, Math.PI * closeR * closeR)
  // Nothing of it in guarded areas, whichever step reached into them
  for (let p = 0; p < n; p++) if (barred[p]) grown[p] = 0
  // The user's own touch-ups have the last word
  if (hints.taken) for (let p = 0; p < n; p++) if (hints.taken[p] && valid[p]) grown[p] = 1
  if (hints.restored) for (let p = 0; p < n; p++) if (hints.restored[p]) grown[p] = 0
  // Where nothing may be taken at all, not even by the seam or the blend:
  // guarded areas (unless the user's touch-up took a spot there) and spots
  // the user put back
  let forbidden: Uint8Array | null = null
  if (hints.guarded || hints.restored) {
    forbidden = new Uint8Array(n)
    for (let p = 0; p < n; p++)
      forbidden[p] = (barred[p] && !roomInGuard?.[p] && !hints.taken?.[p]) || hints.restored?.[p] ? 1 : 0
  }
  const reachedLimit = touchesReachEdge(grown, marks, arrowsChanged, w, h, farReach)

  // Clear change the model made elsewhere
  const band = dilate(grown, w, h, (FEATHER + SEAM_ROOM) * unitW)
  let away = 0
  let total = 0
  for (let p = 0; p < n; p++) {
    if (!valid[p]) continue
    total++
    if (opened[p] && !band[p]) away++
  }
  return {
    arrowsChanged,
    grown,
    keepOut: drift,
    forbidden,
    reachedLimit,
    awayShare: total > 0 ? away / total : 0,
    stats,
    extentsUsed,
    maps: { strong, weak, joined, first: firstEdit, outline, outlined },
  }
}

// What of the arrows' own object (their clear change, followed as usual) may
// be taken inside a guarded area. Being connected is not enough: a face the
// model re-toned strongly reads as clear change too and joins a recoloured
// hood beside it, and fine lines it erased join an earring. So:
// - the clear change within the core disc of a tip (the arrow points at it);
// - beyond that, only what is the same kind of change as the thing itself —
//   the colour mapping fitted to the thing accounts for it (a fringe
//   recoloured with the hair, the rest of a pair of glasses) — where there is
//   enough of the thing to tell: a thing of some size outside the guard, or,
//   for an arrow pointing into the guard, the change at its tip;
// - all in one piece with the tip's change or with the object outside.
function ownInGuard(
  edit: Uint8Array,
  seeds: Uint8Array,
  guarded: Uint8Array,
  coreMask: Uint8Array,
  tipInGuard: boolean,
  orig: Float32Array[],
  answer: Float32Array[],
  w: number,
  h: number,
): Uint8Array {
  const n = w * h
  const outside: number[] = []
  const atTips: number[] = []
  let any = false
  let count = 0
  for (let p = 0; p < n; p++) {
    if (!edit[p]) continue
    if (guarded[p]) any = true
    else if (count++ % 2 === 0 && outside.length < 30000) outside.push(p)
    if (seeds[p] && atTips.length < 30000) atTips.push(p)
  }
  if (!any) return new Uint8Array(n)
  const reference = outside.length >= OWN_THING / 2 ? outside : tipInGuard ? atTips : []
  const thing = fitColourMap(orig, answer, reference)
  const candidate = new Uint8Array(n)
  const start = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    if (!edit[p] || !guarded[p]) continue
    if (seeds[p]) start[p] = 1
    if (coreMask[p]) {
      candidate[p] = 1
      continue
    }
    if (!thing) continue
    const change = Math.sqrt(
      (answer[0][p] - orig[0][p]) ** 2 + (answer[1][p] - orig[1][p]) ** 2 + (answer[2][p] - orig[2][p]) ** 2,
    )
    if (mapError(thing, orig, answer, [p]) < 0.5 * change) candidate[p] = 1
  }
  // … in one piece with the tip's change, or with the object outside the guard
  for (let p = 0; p < n; p++) {
    if (!candidate[p] || start[p]) continue
    const x = p % w
    const beside = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]
    if (beside.some((q) => q >= 0 && q < n && edit[q] && !guarded[q])) start[p] = 1
  }
  return growFrom(start, candidate, w, h)
}

// What the caller knows beyond the two pictures, as masks at work size
interface Hints {
  extents: (Uint8Array | null)[]
  guarded: Uint8Array | null
  taken: Uint8Array | null
  restored: Uint8Array | null
}

async function readHints(job: LocalEditJob, options: LocalEditOptions): Promise<Hints> {
  const { w, h, marks } = job
  const n = w * h
  const unit = Math.min(w, h)
  const tips = marks.map((m) => ({ x: m.x * w, y: m.y * h }))
  const rect = (a: Area) => ({
    x0: Math.max(0, Math.floor(Math.min(a.x0, a.x1) * w)),
    y0: Math.max(0, Math.floor(Math.min(a.y0, a.y1) * h)),
    x1: Math.min(w, Math.ceil(Math.max(a.x0, a.x1) * w)),
    y1: Math.min(h, Math.ceil(Math.max(a.y0, a.y1) * h)),
  })

  // Guarded areas. (An arrow pointing into one still edits what it points
  // at: the object its own clear change belongs to is not barred — see
  // detectChange.)
  let guarded: Uint8Array | null = null
  for (const area of options.guarded ?? []) {
    if (!area) continue
    const r = rect(area)
    if (!(r.x1 > r.x0 && r.y1 > r.y0)) continue
    guarded = guarded ?? new Uint8Array(n)
    for (let y = r.y0; y < r.y1; y++) guarded.fill(1, y * w + r.x0, y * w + r.x1)
  }

  const extents: (Uint8Array | null)[] = []
  for (let i = 0; i < marks.length; i++) {
    const extent = options.extents?.[i]
    extents.push(null)
    if (!extent || !extent.box) continue
    const r = rect(extent.box)
    const bw = r.x1 - r.x0
    const bh = r.y1 - r.y0
    // It has to hold the tip (give or take), and be a thing, not the scene
    const slack = EXTENT_SLACK * unit
    const t = tips[i]
    if (bw < 2 || bh < 2 || bw * bh > EXTENT_MAX * n) continue
    if (t.x < r.x0 - slack || t.x > r.x1 + slack || t.y < r.y0 - slack || t.y > r.y1 + slack) continue
    const mask = new Uint8Array(n)
    let shape: Uint8ClampedArray | null = null
    if (extent.mask) {
      try {
        const bitmap = await createImageBitmap(extent.mask)
        const canvas = new OffscreenCanvas(bw, bh)
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(bitmap, 0, 0, bw, bh)
        bitmap.close()
        shape = ctx.getImageData(0, 0, bw, bh).data
      } catch {
        shape = null // an unreadable silhouette: the box will do
      }
    }
    let area = 0
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const q = (y * bw + x) * 4
        if (shape && (shape[q + 3] < 128 || shape[q] + shape[q + 1] + shape[q + 2] < 3 * 128)) continue
        mask[(r.y0 + y) * w + r.x0 + x] = 1
        area++
      }
    }
    // (a silhouette that is next to nothing says nothing: the box will do)
    if (shape && area < 0.05 * bw * bh) for (let y = r.y0; y < r.y1; y++) mask.fill(1, y * w + r.x0, y * w + r.x1)
    extents[i] = mask
  }

  let taken: Uint8Array | null = null
  let restored: Uint8Array | null = null
  for (const touch of options.touches ?? []) {
    if (!touch) continue
    const disc = new Uint8Array(n)
    paintDisc(disc, w, h, touch.x * w, touch.y * h, Math.max(1, touch.r * unit))
    taken = taken ?? new Uint8Array(n)
    restored = restored ?? new Uint8Array(n)
    // later touches override earlier ones
    for (let p = 0; p < n; p++) {
      if (!disc[p]) continue
      taken[p] = touch.take ? 1 : 0
      restored[p] = touch.take ? 0 : 1
    }
  }
  if (taken && !taken.some((v) => v === 1)) taken = null
  if (restored && !restored.some((v) => v === 1)) restored = null
  // (to the very edge of the spot as the user saw it, whatever the rounding)
  if (restored) restored = dilate(restored, w, h, 2)
  return { extents, guarded, taken, restored }
}

// Within the extent of the thing a tip points at: everything that changed,
// faint or clear (thin outlines included), that is in one piece with the tip
// (fragments joined as usual); nothing in guarded areas. Null if nothing to
// speak of changed there — or if what did is still there, only re-toned: then
// the extent has taken in something that isn't the thing.
function changedWithin(
  cx: number,
  cy: number,
  core: number,
  extent: Uint8Array,
  weak: Uint8Array,
  strong: Uint8Array,
  outline: Uint8Array,
  grad: Float32Array,
  answerGrad: Float32Array,
  valid: Uint8Array,
  guarded: Uint8Array | null,
  w: number,
  h: number,
  closeR: number,
): { piece: Uint8Array | null; still: [number, number] } {
  const n = w * h
  const inside = (p: number) => extent[p] && valid[p] && !guarded?.[p]
  const changed = new Uint8Array(n)
  for (let p = 0; p < n; p++) changed[p] = inside(p) && (weak[p] || strong[p]) ? 1 : 0
  // without specks — but with the outlines, thin as they are
  const solid = open(changed, w, h, 1)
  for (let p = 0; p < n; p++) if (outline[p] && inside(p)) solid[p] = 1
  const joined = erode(dilate(solid, w, h, closeR), w, h, closeR)
  for (let p = 0; p < n; p++) if (!inside(p)) joined[p] = 0
  const start = new Uint8Array(n)
  let any = false
  forDisc(cx, cy, core, w, h, (p) => {
    if (joined[p]) {
      start[p] = 1
      any = true
    }
  })
  // Nothing changed at the tip itself (a thing that differs from what is
  // behind it by its outline alone): then from its outline — the pieces of
  // it nearest the tip, not any line somewhere in the extent
  if (!any) {
    const { labels } = labelComponents(joined, w, h)
    const nearest = new Map<number, number>()
    for (let p = 0; p < n; p++) {
      if (!outline[p] || !labels[p]) continue
      const x = p % w
      const d = Math.hypot(x - cx, (p - x) / w - cy)
      if (d < (nearest.get(labels[p]) ?? Infinity)) nearest.set(labels[p], d)
    }
    const first = Math.min(...nearest.values())
    for (let p = 0; p < n; p++) {
      const l = labels[p]
      if (l && outline[p] && nearest.get(l)! <= 1.5 * first + closeR) {
        start[p] = 1
        any = true
      }
    }
  }
  if (!any) return { piece: null, still: [0, 0] }
  const piece = growFrom(start, joined, w, h)

  // If its faint part is still there — re-toned, not replaced — the extent
  // has taken in something that isn't the thing (a face no box was given
  // for), and isn't gone by. Judged on the detail of the original in the
  // faint part, away from clear change (the flanks of an erased line say
  // nothing about the skin around it): did its edges keep their strength?
  // (Smooth skin has no detail to judge by, so this is one decision for the
  // whole extent, not one per patch.)
  const level = Math.max(4, quantile(sampleEvery(grad, valid, 7), 0.7))
  const clear = new Uint8Array(n)
  for (let p = 0; p < n; p++) clear[p] = strong[p] || outline[p] ? 1 : 0
  const nearClear = dilate(clear, w, h, 3)
  let judged = 0
  let detail = 0
  let kept = 0
  for (let p = 0; p < n; p++) {
    if (!piece[p] || !weak[p] || nearClear[p]) continue
    judged++
    if (grad[p] < level) continue
    detail++
    if (Math.abs(answerGrad[p] - grad[p]) <= STILL_MATCH * grad[p]) kept++
  }
  const still: [number, number] = [detail / Math.max(1, judged), kept / Math.max(1, detail)]
  if (judged >= STILL_AREA && detail >= STILL_DETAIL * judged && kept >= STILL_KEPT * detail) return { piece: null, still }
  let area = 0
  for (let p = 0; p < n; p++) if (piece[p]) area++
  if (area < SEED_FLOOR) return { piece: null, still }
  // Specks it encloses are part of it; anything bigger it surrounds is not
  fillSmallHoles(piece, w, h, Math.PI * closeR * closeR)
  for (let p = 0; p < n; p++) if (!inside(p)) piece[p] = 0
  return { piece, still }
}

// An edge here in one picture and next to none in the other
function oneSidedEdge(
  origGrad: Float32Array,
  answerGrad: Float32Array,
  w: number,
  h: number,
  p: number,
  r: number,
): boolean {
  const x = p % w
  const y = (p - x) / w
  let a = 0
  let b = 0
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
      const q = yy * w + xx
      if (origGrad[q] > a) a = origGrad[q]
      if (answerGrad[q] > b) b = answerGrad[q]
    }
  }
  return Math.min(a, b) < OUTLINE_ONE_SIDED * Math.max(a, b)
}

// How unlike the other picture a pixel is even when anything within `r` px
// may stand in for it, either way round: something one picture has there and
// the other doesn't have anywhere near
function unmatchedAround(
  orig: Float32Array[],
  answer: Float32Array[],
  w: number,
  h: number,
  p: number,
  r: number,
): number {
  const x = p % w
  const y = (p - x) / w
  let missingInAnswer = Infinity
  let missingInOrig = Infinity
  for (let dy = -r; dy <= r; dy++) {
    const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx
      const q = yy * w + xx
      const a = (orig[0][p] - answer[0][q]) ** 2 + (orig[1][p] - answer[1][q]) ** 2 + (orig[2][p] - answer[2][q]) ** 2
      const b = (orig[0][q] - answer[0][p]) ** 2 + (orig[1][q] - answer[1][p]) ** 2 + (orig[2][q] - answer[2][p]) ** 2
      if (a < missingInAnswer) missingInAnswer = a
      if (b < missingInOrig) missingInOrig = b
    }
  }
  return Math.sqrt(Math.max(missingInAnswer, missingInOrig))
}

// Inside a connected change, a second, clearly different kind of change: a
// large part with no tip in it, which is just the original re-toned
// (brighter, warmer — one colour mapping explains it well) by a mapping the
// edit's own part doesn't follow. That's the model's drift, not the edit.
// (A recolour's shadowed half follows the same mapping as its lit half, and
// a removal is no colour mapping at all, so neither is split.)
function toneDrift(
  grown: Uint8Array,
  seeds: Uint8Array,
  orig: Float32Array[],
  answer: Float32Array[],
  valid: Uint8Array,
  w: number,
  h: number,
): Uint8Array | null {
  const n = w * h
  let area = 0
  for (let p = 0; p < n; p++) if (grown[p] && valid[p]) area++
  if (area < 400) return null
  const step = Math.max(1, Math.floor(area / 30000))
  const delta = (p: number, c: number) => answer[c][p] - orig[c][p]
  const dist2 = (p: number, ctr: number[]) =>
    (delta(p, 0) - ctr[0]) ** 2 + (delta(p, 1) - ctr[1]) ** 2 + (delta(p, 2) - ctr[2]) ** 2
  const sample: number[] = []
  let k = 0
  for (let p = 0; p < n; p++) if (grown[p] && valid[p] && k++ % step === 0) sample.push(p)
  const seedPts: number[] = []
  for (let p = 0; p < n; p++) if (seeds[p] && grown[p] && valid[p]) seedPts.push(p)
  if (seedPts.length < 8) return null

  // Two kinds of change: start one at the tips, the other at whatever is
  // least like them
  let a = [0, 1, 2].map((c) => quantile(seedPts.map((p) => delta(p, c)), 0.5))
  const far = sample.map((p) => dist2(p, a))
  const cut = quantile(far, 0.7)
  const farPts = sample.filter((_, i) => far[i] >= cut)
  if (farPts.length < 20) return null
  let b = [0, 1, 2].map((c) => farPts.reduce((acc, p) => acc + delta(p, c), 0) / farPts.length)
  for (let iter = 0; iter < 8; iter++) {
    const sa = [0, 0, 0]
    const sb = [0, 0, 0]
    let na = 0
    let nb = 0
    for (const p of sample) {
      const toA = dist2(p, a) <= dist2(p, b)
      for (let c = 0; c < 3; c++) (toA ? sa : sb)[c] += delta(p, c)
      if (toA) na++
      else nb++
    }
    if (na === 0 || nb === 0) return null
    a = sa.map((v) => v / na)
    b = sb.map((v) => v / nb)
  }
  let spreadA = 0
  let spreadB = 0
  let na = 0
  let nb = 0
  for (const p of sample) {
    const da = dist2(p, a)
    const db = dist2(p, b)
    if (da <= db) {
      spreadA += da
      na++
    } else {
      spreadB += db
      nb++
    }
  }
  const apart = Math.sqrt(dist2Of(a, b))
  if (apart < 10 || apart < 2.5 * Math.sqrt(Math.max(spreadA / Math.max(1, na), spreadB / Math.max(1, nb))))
    return null

  // The other kind, as connected parts
  const other = new Uint8Array(n)
  for (let p = 0; p < n; p++) if (grown[p] && valid[p] && dist2(p, b) < dist2(p, a)) other[p] = 1
  const cleaned = open(other, w, h, 1)
  const { labels, count } = labelComponents(cleaned, w, h)
  if (count === 0) return null
  const size = new Int32Array(count + 1)
  const hasSeed = new Uint8Array(count + 1)
  for (let p = 0; p < n; p++) {
    const l = labels[p]
    if (!l) continue
    size[l]++
    if (seeds[p]) hasSeed[l] = 1
  }
  // The edit's own colour mapping, from its part
  const editPts: number[] = []
  k = 0
  for (let p = 0; p < n; p++) if (grown[p] && valid[p] && !other[p] && k++ % step === 0) editPts.push(p)
  const editMap = fitColourMap(orig, answer, editPts)

  const drop = new Uint8Array(n)
  let any = false
  for (let l = 1; l <= count; l++) {
    if (hasSeed[l] || size[l] < Math.max(300, Math.min(0.08 * area, 0.005 * n))) continue
    const pts: number[] = []
    const every = Math.max(1, Math.floor(size[l] / 20000))
    k = 0
    for (let p = 0; p < n; p++) if (labels[p] === l && k++ % every === 0) pts.push(p)
    let change = 0
    for (const p of pts) change += Math.sqrt(delta(p, 0) ** 2 + delta(p, 1) ** 2 + delta(p, 2) ** 2)
    change /= pts.length
    const own = fitColourMap(orig, answer, pts)
    if (!own || !editMap) continue
    const ownErr = mapError(own, orig, answer, pts)
    const editErr = mapError(editMap, orig, answer, pts)
    // a clean re-tone of its own, which the edit's mapping misses by far
    if (ownErr < 0.4 * change && editErr > 5 * ownErr && editErr > ownErr + 0.5 * change) {
      any = true
      for (let p = 0; p < n; p++) if (labels[p] === l) drop[p] = 1
    }
  }
  if (!any) return null
  // with whatever of the edit it encloses (eyes in a re-toned face)
  const holes = enclosedHoles(drop, w, h)
  for (let p = 0; p < n; p++) if (holes[p] && grown[p] && !seeds[p]) drop[p] = 1
  return drop
}

function dist2Of(a: number[], b: number[]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

// answer ≈ M·original + c (3×3 plus offset), least squares
function fitColourMap(orig: Float32Array[], answer: Float32Array[], pts: number[]): number[][] | null {
  if (pts.length < 30) return null
  // normal equations: [Y Cb Cr 1] × 4
  const ata = Array.from({ length: 4 }, () => [0, 0, 0, 0])
  const atb = Array.from({ length: 3 }, () => [0, 0, 0, 0])
  for (const p of pts) {
    const x = [orig[0][p], orig[1][p], orig[2][p], 1]
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) ata[i][j] += x[i] * x[j]
      for (let c = 0; c < 3; c++) atb[c][i] += x[i] * answer[c][p]
    }
  }
  for (let i = 0; i < 3; i++) ata[i][i] += 1e-3 * pts.length // a touch of ridge: flat areas
  const rows = [0, 1, 2].map((c) => solve4(ata, atb[c]))
  return rows.every((r) => r !== null) ? (rows as number[][]) : null
}

function mapError(map: number[][], orig: Float32Array[], answer: Float32Array[], pts: number[]): number {
  let err = 0
  for (const p of pts) {
    let e = 0
    for (let c = 0; c < 3; c++) {
      const m = map[c]
      const v = m[0] * orig[0][p] + m[1] * orig[1][p] + m[2] * orig[2][p] + m[3]
      e += (answer[c][p] - v) ** 2
    }
    err += Math.sqrt(e)
  }
  return err / pts.length
}

// Gaussian elimination for a 4×4 system
function solve4(A: number[][], b: number[]): number[] | null {
  const m = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < 4; col++) {
    let piv = col
    for (let r = col + 1; r < 4; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
    if (Math.abs(m[piv][col]) < 1e-9) return null
    ;[m[col], m[piv]] = [m[piv], m[col]]
    for (let r = 0; r < 4; r++) {
      if (r === col) continue
      const f = m[r][col] / m[col][col]
      for (let c = col; c < 5; c++) m[r][c] -= f * m[col][c]
    }
  }
  return m.map((row, i) => row[4] / row[i])
}

function localNoiseModel(
  mark: EditMark,
  diff: Float32Array,
  grad: Float32Array,
  valid: Uint8Array,
  globalModel: NoiseModel,
  w: number,
  h: number,
  reach: number,
): NoiseModel {
  const unitW = Math.min(w, h)
  const cx = mark.x * w
  const cy = mark.y * h
  const inner = ZONE_RADIUS * unitW
  const outer = Math.min(NOISE_OUTER * unitW, reach)
  const ringDiff: number[] = []
  const ringGrad: number[] = []
  const x0 = Math.max(0, Math.floor(cx - outer))
  const y0 = Math.max(0, Math.floor(cy - outer))
  const x1 = Math.min(w - 1, Math.ceil(cx + outer))
  const y1 = Math.min(h - 1, Math.ceil(cy + outer))
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2
      if (d2 < inner * inner || d2 > outer * outer) continue
      const p = y * w + x
      if (!valid[p]) continue
      if (diff[p] > CLEAR_CHANGE * (globalModel.a + globalModel.b * grad[p])) continue
      ringDiff.push(diff[p])
      ringGrad.push(grad[p])
    }
  }
  // Never more than a few times the picture-wide noise: a big edit that
  // fills the ring must not raise its own bar
  const local = ringDiff.length >= 400 ? fitNoiseModel(ringDiff, ringGrad) : globalModel
  return {
    a: Math.min(local.a, LOCAL_NOISE_CAP * globalModel.a),
    b: Math.min(local.b, LOCAL_NOISE_CAP * Math.max(globalModel.b, 0.02)),
  }
}

// Picture-wide noise model, refitted once without the pixels the first fit
// calls a clear change (so a big edit doesn't hide itself in the noise)
function robustNoiseModel(
  diff: Float32Array,
  grad: Float32Array,
  include: (p: number) => boolean,
  w: number,
  h: number,
): NoiseModel {
  const n = w * h
  const step = Math.max(1, Math.floor(n / 60000))
  const sample = (exclude: NoiseModel | null) => {
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
  // An edit that fills nearly all the flat ground (a recoloured sky, a new
  // backdrop) still drags that up. Flat redraw noise is about the same
  // everywhere and an edit isn't, so the quieter flat tiles of the picture
  // bound it from above.
  const bound = flatTileBound(diff, grad, include, w, h, g0)
  model = { a: Math.min(model.a, bound), b: Math.min(model.b, NOISE_B_MAX) }
  for (let pass = 0; pass < 2; pass++) {
    const [ds, gs] = sample(model)
    const next = fitNoiseModel(ds, gs)
    model = { a: Math.min(next.a, bound), b: Math.min(next.b, NOISE_B_MAX) }
  }
  return model
}

function flatTileBound(
  diff: Float32Array,
  grad: Float32Array,
  include: (p: number) => boolean,
  w: number,
  h: number,
  grads: readonly number[],
): number {
  const flat = quantile(grads as number[], 0.3)
  const tiles = 12
  const medians: number[] = []
  const tw = Math.ceil(w / tiles)
  const th = Math.ceil(h / tiles)
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const vals: number[] = []
      for (let y = ty * th; y < Math.min(h, (ty + 1) * th); y += 2) {
        for (let x = tx * tw; x < Math.min(w, (tx + 1) * tw); x += 2) {
          const p = y * w + x
          if (include(p) && grad[p] <= flat) vals.push(diff[p])
        }
      }
      if (vals.length >= 12) medians.push(quantile(vals, 0.5))
    }
  }
  const bound = medians.length >= 8 ? 1.5 * quantile(medians, 0.3) + 0.5 : Infinity
  return Math.min(bound, NOISE_A_MAX)
}

// The answer is a different picture (black, blank, another photo): nearly
// every detailed part of the original is gone — either very different, or
// its edges are missing from the answer
function looksUnrelated(
  diff: Float32Array,
  grad: Float32Array,
  answerGrad: Float32Array,
  valid: Uint8Array,
  zones: Uint8Array,
  n: number,
): boolean {
  const step = Math.max(1, Math.floor(n / 40000))
  const grads: number[] = []
  for (let p = 0; p < n; p += step) if (valid[p] && !zones[p]) grads.push(grad[p])
  if (grads.length < 200) return false
  const detailed = Math.max(4, quantile(grads, 0.7))
  let total = 0
  let lost = 0
  for (let p = 0; p < n; p += step) {
    if (!valid[p] || zones[p] || grad[p] < detailed) continue
    total++
    if (diff[p] > 2 * HIGH_MIN || answerGrad[p] < 0.3 * grad[p]) lost++
  }
  return total >= 100 && lost / total > UNRELATED
}

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

// Fine alignment where the seam will be: try small shifts of the answer and
// keep the one that matches the original best on the band around the change
function refineOffset(
  origRgb: Float32Array[],
  answer: Answer,
  W: number,
  H: number,
  cw: number,
  ch: number,
  cx0: number,
  cy0: number,
  rx: number,
  ry: number,
  start: Placement,
  changeC: Uint8Array,
  featherC: number,
  roomC: number,
): Placement {
  const R = LOCAL_ALIGN
  // Draw the answer with a margin so shifted reads stay inside
  const pw = cw + 2 * R
  const ph = ch + 2 * R
  const resP = readAnswer(answer, pw, ph, placeRect(start, W, H, cx0 - R / rx, cy0 - R / ry, rx, ry), false)
  const near = dilate(changeC, cw, ch, featherC + roomC)
  const inner = dilate(changeC, cw, ch, featherC)
  const ring: number[] = []
  for (let p = 0; p < cw * ch; p++) if (near[p] && !inner[p]) ring.push(p)
  if (ring.length < 50) return start
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
  return { ...start, dx: start.dx - best.sx / rx, dy: start.dy - best.sy / ry }
}

// Pastes one area at full resolution; returns how many pixels were taken.
//
// The crop can be the whole picture, so what is held at once matters here:
// every buffer is made as late, and let go as early, as the arithmetic allows
// (at the final loop: the region, alpha and the two pictures, 13 bytes per
// crop pixel).
function blendArea(
  octx: OffscreenCanvasRenderingContext2D,
  original: ImageBitmap,
  answer: Answer,
  W: number,
  H: number,
  x0: number,
  y0: number,
  cw: number,
  ch: number,
  regionC: Uint8Array,
  rw: number,
  rh: number,
  offset: Placement,
  fit: { a: Float32Array; b: Float32Array },
  feather: number,
): number {
  // Region at full resolution (smooth upscale, then re-binarised)
  const region = resampleMask(regionC, rw, rh, 0, 0, rw, rh, cw, ch)

  // Local tone match + boundary correction are estimated on a small copy
  // (below). Its mask is made first: shrinking the region takes a crop-sized
  // canvas for a moment, which is cheapest while nothing else is held.
  const bs = Math.min(1, BLEND_MAX / Math.max(cw, ch))
  const bw = Math.max(4, Math.round(cw * bs))
  const bh = Math.max(4, Math.round(ch * bs))
  const maskSmall = resampleMask(region, cw, ch, 0, 0, cw, ch, bw, bh)

  const { alpha, taken } = featherAlpha(region, cw, ch, feather)
  if (taken === 0) return 0

  const layerCanvas = new OffscreenCanvas(cw, ch)
  const lctx = layerCanvas.getContext('2d', { willReadFrequently: true })!
  const rect = placeRect(offset, W, H, x0, y0, 1, 1)
  // The answer never lands on whole pixels, and the browser's own
  // interpolation would soften it noticeably against the untouched picture
  // around it (edges and fine texture lose a quarter or more). A windowed-sinc
  // resampling keeps them.
  let layer = cw * ch <= SHARP_MAX ? sharpAnswer(answer, rect, cw, ch) : null
  if (layer) {
    lctx.putImageData(layer, 0, 0)
  } else {
    lctx.imageSmoothingQuality = 'high'
    drawAnswer(lctx, answer, rect)
    layer = lctx.getImageData(0, 0, cw, ch)
  }
  // The canvas was only needed for the small copy: its pixels are in `layer`
  const layerSmall = smallCopyOf(layerCanvas, bw, bh)
  discard(layerCanvas)

  // The crop's own frame can only be the picture's edge (the crop leaves room
  // everywhere else), which isn't a seam: the correction stays free there.
  const origSmall = smallCopy(original, x0, y0, cw, ch, bw, bh)
  const corr = computeCorrection(origSmall, layerSmall, maskSmall, bw, bh, true)
  // Fall back to the global colour fit when the crop has too little outside
  const a = corr.a[0] === 1 && corr.a[1] === 1 && corr.a[2] === 1 && corr.b[0] === 0 ? fit.a : corr.a
  const b = a === fit.a ? fit.b : corr.b

  // Nothing has been drawn on the picture since this area's turn began, so
  // reading it only now gives the same pixels as reading it first would
  const base = octx.getImageData(x0, y0, cw, ch)

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

  // The correction field is spread to full size one row at a time, and only
  // for rows that take something from the answer
  const fieldRow = [new Float32Array(cw), new Float32Array(cw), new Float32Array(cw)]
  const bd = base.data
  const ld = layer.data
  for (let y = 0; y < ch; y++) {
    let spread = false
    for (let x = 0; x < cw; x++) {
      const p = y * cw + x
      const al = alpha[p]
      // Transparent parts of the original stay as they are
      if (al <= 0 || bd[p * 4 + 3] < 250 || ld[p * 4 + 3] < 250) continue
      if (!spread) {
        for (let k = 0; k < 3; k++) upsampleRow(corr.field[k], bw, bh, cw, ch, y, fieldRow[k])
        spread = true
      }
      const noise = addSigma > 0.5 ? (rand() + rand() + rand() - 1.5) * (addSigma / 0.5) : 0
      const j = p * 4
      for (let k = 0; k < 3; k++) {
        let v = a[k] * ld[j + k] + b[k] + fieldRow[k][x] + noise
        v = v < 0 ? 0 : v > 255 ? 255 : v
        bd[j + k] = Math.round(bd[j + k] + (v - bd[j + k]) * al)
      }
    }
  }
  octx.putImageData(base, x0, y0)
  return taken
}

// Alpha for the blend: 0 outside the region and exactly at the seam, 1 once
// `feather` px inside; and how many pixels get any of the answer. (Its own
// function, so that the scratch mask is gone as soon as it returns.)
function featherAlpha(
  region: Uint8Array,
  w: number,
  h: number,
  feather: number,
): { alpha: Float32Array; taken: number } {
  const n = w * h
  const outside = new Uint8Array(n)
  for (let p = 0; p < n; p++) outside[p] = region[p] ? 0 : 1
  // Depth becomes alpha in place: one float per pixel instead of two
  const alpha = distanceToSet(outside, w, h)
  let taken = 0
  for (let p = 0; p < n; p++) {
    if (!region[p]) {
      alpha[p] = 0
      continue
    }
    const t = Math.min(1, alpha[p] / feather)
    alpha[p] = t * t * (3 - 2 * t)
    if (alpha[p] > 0) taken++
  }
  return { alpha, taken }
}

// ---------------------------------------------------------------------------
// Pixel plumbing
// ---------------------------------------------------------------------------

// The model's answer with a margin of repeated edge pixels: an answer that
// is shifted or scaled down a little leaves no gap at the picture's edge
// (which would otherwise keep a strip of the original, or a transparent hole
// the blend can't use) — it just continues its outermost rows and columns.
interface Answer {
  canvas: OffscreenCanvas
  // margin and the answer's own size, in answer px
  e: number
  bw: number
  bh: number
}

function extendAnswer(result: ImageBitmap, W: number, H: number, marginFrame: number): Answer {
  const bw = result.width
  const bh = result.height
  const e = Math.ceil(marginFrame * Math.max(bw / W, bh / H)) + 2
  const canvas = new OffscreenCanvas(bw + 2 * e, bh + 2 * e)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(result, e, e)
  ctx.drawImage(canvas, e, e, 1, bh, 0, e, e, bh)
  ctx.drawImage(canvas, e + bw - 1, e, 1, bh, e + bw, e, e, bh)
  ctx.drawImage(canvas, 0, e, bw + 2 * e, 1, 0, 0, bw + 2 * e, e)
  ctx.drawImage(canvas, 0, e + bh - 1, bw + 2 * e, 1, 0, e + bh, bw + 2 * e, e)
  return { canvas, e, bw, bh }
}

// The answer where its frame lands on `rect`, as a w×h picture, resampled
// with a Lanczos-3 kernel (widened when the answer is larger than what it is
// drawn into, so it is also the right low-pass). Separable: rows, then columns.
function sharpAnswer(answer: Answer, rect: Rect, w: number, h: number): ImageData | null {
  const ctx = answer.canvas.getContext('2d')
  if (!ctx) return null
  // output pixel i (centre i + 0.5) reads the answer canvas at a·(i + 0.5) + b
  const ax = answer.bw / rect.dw
  const ay = answer.bh / rect.dh
  const bx = answer.e - rect.ox * ax
  const by = answer.e - rect.oy * ay
  const colTaps = lanczosTaps(w, ax, bx, answer.canvas.width)
  const rowTaps = lanczosTaps(h, ay, by, answer.canvas.height)
  const sx0 = colTaps.first
  const sy0 = rowTaps.first
  const sw = colTaps.last - sx0 + 1
  const sh = rowTaps.last - sy0 + 1
  if (sw <= 0 || sh <= 0) return null
  const src = ctx.getImageData(sx0, sy0, sw, sh).data
  const out = new ImageData(w, h)
  const rows = new Float32Array(w * sh)
  for (let c = 0; c < 3; c++) {
    // horizontally: sw → w, for every source row
    for (let y = 0; y < sh; y++) {
      const line = y * sw * 4 + c
      for (let x = 0; x < w; x++) {
        let acc = 0
        const t = x * colTaps.count
        const start = colTaps.start[x] - sx0
        for (let k = 0; k < colTaps.count; k++) acc += colTaps.weight[t + k] * src[line + (start + k) * 4]
        rows[y * w + x] = acc
      }
    }
    // vertically: sh → h
    for (let y = 0; y < h; y++) {
      const t = y * rowTaps.count
      const start = rowTaps.start[y] - sy0
      for (let x = 0; x < w; x++) {
        let acc = 0
        for (let k = 0; k < rowTaps.count; k++) acc += rowTaps.weight[t + k] * rows[(start + k) * w + x]
        out.data[(y * w + x) * 4 + c] = acc < 0 ? 0 : acc > 255 ? 255 : acc + 0.5
      }
    }
  }
  for (let p = 3; p < out.data.length; p += 4) out.data[p] = 255
  return out
}

// For each of `n` output pixels: the run of source pixels it reads (clamped
// to the source, whose edge then simply repeats) and their weights
function lanczosTaps(
  n: number,
  a: number,
  b: number,
  size: number,
): { start: Int32Array; weight: Float32Array; count: number; first: number; last: number } {
  const stretch = Math.max(1, a)
  const radius = 3 * stretch
  const count = Math.ceil(2 * radius) + 1
  const start = new Int32Array(n)
  const weight = new Float32Array(n * count)
  let first = Infinity
  let last = -Infinity
  for (let i = 0; i < n; i++) {
    const centre = a * (i + 0.5) + b
    // the run is kept inside the source by sliding it, never by cutting it
    const from = Math.min(Math.max(0, size - count), Math.max(0, Math.floor(centre - radius)))
    start[i] = from
    let sum = 0
    for (let k = 0; k < count; k++) {
      const x = (from + k + 0.5 - centre) / stretch
      let v = 0
      if (Math.abs(x) < 1e-6) v = 1
      else if (Math.abs(x) < 3) {
        const px = Math.PI * x
        v = (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px)
      }
      // a source pixel that doesn't exist (a source narrower than the kernel)
      if (from + k >= size) v = 0
      weight[i * count + k] = v
      sum += v
    }
    if (sum !== 0) for (let k = 0; k < count; k++) weight[i * count + k] /= sum
    first = Math.min(first, from)
    last = Math.max(last, Math.min(size - 1, from + count - 1))
  }
  return { start, weight, count, first, last }
}

// Draws the answer so that its own frame lands on `rect`
function drawAnswer(ctx: OffscreenCanvasRenderingContext2D, answer: Answer, rect: Rect): void {
  const kx = rect.dw / answer.bw
  const ky = rect.dh / answer.bh
  ctx.drawImage(
    answer.canvas,
    0,
    0,
    answer.canvas.width,
    answer.canvas.height,
    rect.ox - answer.e * kx,
    rect.oy - answer.e * ky,
    rect.dw + 2 * answer.e * kx,
    rect.dh + 2 * answer.e * ky,
  )
}

// Planar RGB of the answer drawn at `rect` in a w×h canvas. `real`: only
// pixels the answer itself covers count as valid (for comparing), not its
// repeated edges.
function readAnswer(
  answer: Answer,
  w: number,
  h: number,
  rect: Rect,
  real: boolean,
): { rgb: Float32Array[]; valid: Uint8Array } {
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  drawAnswer(ctx, answer, rect)
  const out = planes(ctx.getImageData(0, 0, w, h).data, w * h)
  discard(canvas)
  if (real) {
    const colOk = new Uint8Array(w)
    const rowOk = new Uint8Array(h)
    for (let x = 0; x < w; x++) {
      const u = ((x + 0.5 - rect.ox) / rect.dw) * answer.bw
      colOk[x] = u >= 0.5 && u <= answer.bw - 0.5 ? 1 : 0
    }
    for (let y = 0; y < h; y++) {
      const v = ((y + 0.5 - rect.oy) / rect.dh) * answer.bh
      rowOk[y] = v >= 0.5 && v <= answer.bh - 0.5 ? 1 : 0
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!colOk[x] || !rowOk[y]) out.valid[y * w + x] = 0
  }
  return out
}

// Draws `source` stretched onto `rect` in a w×h canvas, returning planar RGB
// and which pixels the source fully covered (and is opaque at)
function readRgb(source: ImageBitmap, w: number, h: number, rect: Rect): { rgb: Float32Array[]; valid: Uint8Array } {
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, source.width, source.height, rect.ox, rect.oy, rect.dw, rect.dh)
  const out = planes(ctx.getImageData(0, 0, w, h).data, w * h)
  discard(canvas)
  return out
}

// Gives a scratch canvas's pixel store back at once. Without this it lingers
// until the garbage collector gets round to the canvas, and at full size
// that is tens of MB each.
function discard(canvas: OffscreenCanvas): void {
  canvas.width = canvas.height = 0
}

function planes(data: Uint8ClampedArray, n: number): { rgb: Float32Array[]; valid: Uint8Array } {
  const rgb = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  const valid = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    // ImageData is not premultiplied: colours are usable as they are
    valid[p] = data[p * 4 + 3] >= 250 ? 1 : 0
    rgb[0][p] = data[p * 4]
    rgb[1][p] = data[p * 4 + 1]
    rgb[2][p] = data[p * 4 + 2]
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
  discard(src)
  discard(dst)
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
  const data = ctx.getImageData(0, 0, bw, bh).data
  discard(canvas)
  return data
}

function smallCopyOf(source: OffscreenCanvas, bw: number, bh: number): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(bw, bh)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, bw, bh)
  const data = ctx.getImageData(0, 0, bw, bh).data
  discard(canvas)
  return data
}

// Bilinear upsample of a small float field: row `y` of the dw×dh result, into
// `out` (dw long)
function upsampleRow(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  y: number,
  out: Float32Array,
): void {
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
    out[x] = top * (1 - ty) + bottom * ty
  }
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

function sampleEvery(values: Float32Array, valid: Uint8Array, step: number): number[] {
  const out: number[] = []
  for (let p = 0; p < values.length; p += step) if (valid[p]) out.push(values[p])
  return out
}

function forDisc(
  cx: number,
  cy: number,
  r: number,
  w: number,
  h: number,
  visit: (p: number, d2: number) => void,
): void {
  const x0 = Math.max(0, Math.floor(cx - r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const x1 = Math.min(w - 1, Math.ceil(cx + r))
  const y1 = Math.min(h - 1, Math.ceil(cy + r))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2
      if (d2 <= r * r) visit(y * w + x, d2)
    }
  }
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
