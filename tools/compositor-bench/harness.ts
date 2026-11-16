// Runs one bench case through the "only around arrows" compositor inside a
// page. run.cjs bundles this file and calls window.runCase for every case.
import {
  composeLocalEdit,
  lastLocalEditDebug,
  lastLocalEditStats,
  prepareLocalEdit,
  type LocalEditOptions,
} from '../../src/lib/localEdit'

function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

async function blobToB64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}

// A debug map (one byte per work pixel, non-zero = set) as a black/white PNG
async function mapToB64(map: Uint8Array, w: number, h: number): Promise<string> {
  const canvas = new OffscreenCanvas(w, h)
  const img = new ImageData(w, h)
  for (let p = 0; p < map.length; p++) {
    img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = map[p] ? 255 : 0
    img.data[p * 4 + 3] = 255
  }
  canvas.getContext('2d')!.putImageData(img, 0, 0)
  return blobToB64(await canvas.convertToBlob({ type: 'image/png' }))
}

async function runCase(
  origB64: string,
  resB64: string,
  marks: { x: number; y: number }[],
  withMaps: boolean,
  options?: LocalEditOptions,
) {
  const t0 = performance.now()
  const job = await prepareLocalEdit(
    b64ToBlob(origB64, 'image/png'),
    marks.map((m, i) => ({ id: String(i), text: 'x', ...m })),
  )
  const t1 = performance.now()
  const result = await createImageBitmap(b64ToBlob(resB64, 'image/png'))
  const out = await composeLocalEdit(job, result, options)
  const t2 = performance.now()
  const stats = lastLocalEditStats()
  const dbg = lastLocalEditDebug()
  const common = {
    stats,
    globalNoise: dbg?.globalNoise,
    zoom: dbg?.zoom,
    zoomCheck: dbg?.zoomCheck,
    away: dbg?.widespread,
    prepMs: t1 - t0,
    ms: t2 - t1,
  }
  // What the detection saw, at work resolution: strong and weak change, what
  // was linked to the edit, and the area finally grown
  const maps: Record<string, string> = {}
  if (dbg && withMaps) {
    maps.grown = await mapToB64(dbg.grown, dbg.w, dbg.h)
    for (const [name, map] of Object.entries(dbg.maps ?? {})) maps[name] = await mapToB64(map, dbg.w, dbg.h)
  }
  if (out.kind === 'reject') return { kind: 'reject', reason: out.reason, ...common, maps }
  return {
    kind: 'ok',
    info: out.info,
    ...common,
    composite: await blobToB64(out.blob),
    mask: await blobToB64(out.mask),
    maps,
  }
}

;(window as unknown as { runCase: typeof runCase }).runCase = runCase
