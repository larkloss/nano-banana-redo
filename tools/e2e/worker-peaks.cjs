// Peak memory and output bytes of the app's two background workers, run from
// the app's own source in a bare page: the "only around arrows" compositor
// (through localEditClient.ts, as the studio calls it) on one large edit, and
// the JPEG export worker on several pictures asked for at once.
//
//   (cd tools/compositor-bench && python sim.py)   (the picture it starts from, once)
//   node tools/e2e/worker-peaks.cjs [options]
//
//   --src DIR        the source tree under test (this checkout's src/)
//   --size 4096      side of the square picture
//   --answers 2      answers composited at once, as several keys or candidates give
//   --pictures 6     pictures exported as JPEG at once
//   --tag NAME       names the result file: tools/e2e/out/worker-peaks-<tag>.json
//   --compare A B    no run: compares two result files (bytes must match; memory side by side)
//
// For a change that must not alter a single output byte: run it on the source
// before (--src <a copy of the old src> --tag before) and after (--tag after),
// then --compare the two files. The pictures are made once per size (in
// tools/e2e/out/) and their sha256 is in every result, so two runs are known
// to have had the same input.
//
// The edit is a large one: an ellipse 60% of the picture wide is recoloured,
// so the compositor works on a crop of most of the picture. Memory is the PSS
// of the page's process (its workers live in it) read from /proc every 15 ms
// while the work runs; "over" is the peak above the reading just before.
// Linux only. Headless Chromium draws canvases without a GPU, so their pixels
// are in that process.
//
// Also checked, because the compositor's worker queues its work: Stop during
// a composite still ends it at once, and without workers the same bytes come
// out of the page's own thread.
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const { sha256, sleep, MB, options, bundle, openPage, rendererMemory, makePictures } = require('./kit.cjs')

const OUT = path.join(__dirname, 'out')
const opts = options(process.argv.slice(2), {
  src: path.join(__dirname, '..', '..', 'src'),
  size: 4096,
  answers: 2,
  pictures: 6,
  tag: 'run',
})
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// What runs in the page
const PAGE = `
import { createLocalEditor, type LocalEditor } from '@src/lib/localEditClient'
import type { LocalComposite } from '@src/lib/localEdit'
import { toFullColourJpeg } from '@src/lib/jpegExport'

const blobs: Record<string, Blob> = {}
let editor: LocalEditor | null = null
let composites: LocalComposite[] = []
let jpegs: Blob[] = []
const hash = async (blob: Blob) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('')

Object.assign(window, {
  async load(names: string[]) {
    for (const name of names) blobs[name] = await (await fetch('/' + name)).blob()
  },
  async prepare(name: string, marks: { x: number; y: number }[]) {
    editor = await createLocalEditor(blobs[name], marks.map((m, i) => ({ id: String(i), text: 'x', ...m })))
  },
  async compose(name: string, count: number) {
    composites = await Promise.all(Array.from({ length: count }, () => editor!.compose(blobs[name])))
    return composites.map((c) => (c.kind === 'ok' ? { kind: c.kind, info: c.info } : c))
  },
  async compositeHashes() {
    const out = []
    for (const c of composites) out.push(c.kind === 'ok' ? { composite: await hash(c.blob), mask: await hash(c.mask) } : null)
    return out
  },
  // Stop, pressed while a composite is being worked on
  async stopDuring(name: string, afterMs: number) {
    const work = editor!.compose(blobs[name])
    await new Promise((r) => setTimeout(r, afterMs))
    const t0 = performance.now()
    editor!.release()
    try {
      await work
      return { ended: 'with a composite' }
    } catch (err) {
      return { ended: (err as Error).message, ms: performance.now() - t0 }
    }
  },
  async encode(names: string[], quality: number) {
    jpegs = await Promise.all(names.map((name) => toFullColourJpeg(blobs[name], quality)))
    return jpegs.map((j) => j.size)
  },
  async jpegHashes() {
    const out = []
    for (const j of jpegs) out.push(await hash(j))
    return out
  },
})
`

// Counts the workers the page starts, and lets a page have none
const INIT = (noWorkers) => `
window.__workers = 0
{
  const Real = window.Worker
  window.Worker = class extends Real {
    constructor(...args) {
      if (${noWorkers}) throw new Error('no workers here')
      super(...args)
      window.__workers++
    }
  }
}`

// One fresh browser per measurement, so no reading inherits another's memory
async function session(script, files, { noWorkers = false } = {}) {
  const browser = await chromium.launch()
  const { page, errors } = await openPage(browser, script, files, INIT(noWorkers))
  const cdp = await page.context().newCDPSession(page)
  const memory = await rendererMemory(browser)
  return {
    page,
    errors,
    // A settled reading: after a forced collection
    async baseline() {
      await cdp.send('HeapProfiler.collectGarbage')
      await sleep(500)
      return memory.now()
    },
    peakDuring: memory.peakDuring,
    workers: () => page.evaluate(() => window.__workers),
    close: () => browser.close(),
  }
}

const MARKS = [{ x: 0.5, y: 0.5 }]

async function measureCompose(script, files, answers) {
  const s = await session(script, files)
  await s.page.evaluate(() => window.load(['original.png', 'answer.png']))
  await s.page.evaluate((marks) => window.prepare('original.png', marks), MARKS)
  const before = await s.baseline()
  const t0 = Date.now()
  const { value: outcomes, peak, samples } = await s.peakDuring(() => s.page.evaluate((n) => window.compose('answer.png', n), answers))
  const ms = Date.now() - t0
  const hashes = await s.page.evaluate(() => window.compositeHashes())
  const workers = await s.workers()
  await s.close()
  const result = { answers, workers, ms, samples, baselineMB: MB(before), peakMB: MB(peak), overMB: MB(peak - before), outcomes, hashes, errors: s.errors }
  log(`compose × ${answers}: peak ${result.peakMB} MB, ${result.overMB} MB over the ${result.baselineMB} MB before (${ms} ms, ${workers} worker)`)
  return result
}

async function checkStop(script, files) {
  const s = await session(script, files)
  await s.page.evaluate(() => window.load(['original.png', 'answer.png']))
  await s.page.evaluate((marks) => window.prepare('original.png', marks), MARKS)
  // Two at once: one being worked on, one waiting its turn
  const result = await s.page.evaluate(async () => {
    const waiting = window.compose('answer.png', 1).then(
      () => 'with a composite',
      (err) => err.message,
    )
    const stopped = await window.stopDuring('answer.png', 400)
    return { ...stopped, waiting: await waiting }
  })
  await s.close()
  log(`stop during a composite: ended "${result.ended}" after ${Math.round(result.ms ?? -1)} ms; the one waiting: "${result.waiting}"`)
  return result
}

async function checkFallback(script, files) {
  const s = await session(script, files, { noWorkers: true })
  await s.page.evaluate(() => window.load(['original.png', 'answer.png']))
  await s.page.evaluate((marks) => window.prepare('original.png', marks), MARKS)
  const outcomes = await s.page.evaluate(() => window.compose('answer.png', 2))
  const hashes = await s.page.evaluate(() => window.compositeHashes())
  const workers = await s.workers()
  await s.close()
  log(`without workers: ${outcomes.map((o) => o.kind).join(', ')} (${workers} workers started)`)
  return { workers, outcomes, hashes, errors: s.errors }
}

async function measureJpeg(script, files, names) {
  const s = await session(script, files)
  await s.page.evaluate((n) => window.load(n), names)
  const before = await s.baseline()
  const t0 = Date.now()
  const { value: sizes, peak, samples } = await s.peakDuring(() => s.page.evaluate((n) => window.encode(n, 95), names))
  const ms = Date.now() - t0
  const hashes = await s.page.evaluate(() => window.jpegHashes())
  const workers = await s.workers()
  await s.close()
  const result = { pictures: names.length, workers, ms, samples, baselineMB: MB(before), peakMB: MB(peak), overMB: MB(peak - before), sizes, hashes, errors: s.errors }
  log(`JPEG × ${names.length}: peak ${result.peakMB} MB, ${result.overMB} MB over the ${result.baselineMB} MB before (${ms} ms, ${workers} worker)`)
  return result
}

function compare(fileA, fileB) {
  const [a, b] = [fileA, fileB].map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
  let bad = 0
  const same = (what, x, y) => {
    const ok = JSON.stringify(x) === JSON.stringify(y)
    console.log(`${ok ? 'same  ' : 'DIFFER'} ${what}`)
    if (!ok) bad++
  }
  same('input pictures', a.inputs, b.inputs)
  a.compose.forEach((c, i) => {
    same(`composite and mask bytes, ${c.answers} at once`, c.hashes, b.compose[i]?.hashes)
    same(`what the compositor reported, ${c.answers} at once`, c.outcomes, b.compose[i]?.outcomes)
  })
  same('composite and mask bytes without workers', a.fallback.hashes, b.fallback.hashes)
  same('JPEG bytes', a.jpeg.hashes, b.jpeg.hashes)
  const row = (what, x, y) => console.log(`  ${what.padEnd(34)} ${String(x).padStart(8)} ${String(y).padStart(8)}`)
  console.log(`\nmemory of the page's process, MB${' '.repeat(6)}${a.tag.padStart(8)} ${b.tag.padStart(8)}`)
  a.compose.forEach((c, i) => {
    row(`compose × ${c.answers}: peak`, c.peakMB, b.compose[i].peakMB)
    row(`compose × ${c.answers}: over the start`, c.overMB, b.compose[i].overMB)
  })
  row(`JPEG × ${a.jpeg.pictures}: peak`, a.jpeg.peakMB, b.jpeg.peakMB)
  row(`JPEG × ${a.jpeg.pictures}: over the start`, a.jpeg.overMB, b.jpeg.overMB)
  process.exit(bad ? 1 : 0)
}

async function main() {
  if (opts.compare) {
    const files = process.argv.slice(process.argv.indexOf('--compare') + 1, process.argv.indexOf('--compare') + 3)
    return compare(...files)
  }
  const dir = path.join(OUT, `pictures-${opts.size}`)
  const names = await makePictures(dir, opts.size, opts.pictures)
  log('pictures in', dir)
  const files = Object.fromEntries(names.map((n) => [n, path.join(dir, n)]))
  const inputs = Object.fromEntries(names.map((n) => [n, sha256(fs.readFileSync(files[n]))]))
  const script = await bundle(opts.src, PAGE)
  log(`source: ${path.resolve(opts.src)}, ${opts.size}×${opts.size}`)

  const result = { tag: opts.tag, src: path.resolve(opts.src), size: opts.size, inputs, compose: [] }
  for (const answers of [...new Set([1, opts.answers])]) result.compose.push(await measureCompose(script, files, answers))
  result.stop = await checkStop(script, files)
  result.fallback = await checkFallback(script, files)
  result.jpeg = await measureJpeg(script, files, names.filter((n) => n.startsWith('picture')))

  let bad = 0
  const check = (name, ok, detail = '') => {
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''))
    if (!ok) bad++
  }
  const first = result.compose[0]
  check('the edit is composited, and is a large one', first.outcomes[0].kind === 'ok' && first.outcomes[0].info.coverage > 0.2, JSON.stringify(first.outcomes[0].info ?? first.outcomes[0]))
  check('the compositor ran in a worker', result.compose.every((c) => c.workers === 1))
  check('every composite of the same answer has the same bytes', result.compose.every((c) => c.hashes.every((h) => h && h.composite === first.hashes[0].composite && h.mask === first.hashes[0].mask)))
  check('stop ends a composite being worked on, and one waiting, at once', result.stop.ended === 'released' && result.stop.waiting === 'released' && result.stop.ms < 200, JSON.stringify(result.stop))
  check('without workers: no worker, same bytes', result.fallback.workers === 0 && result.fallback.hashes.every((h) => h && h.composite === first.hashes[0].composite && h.mask === first.hashes[0].mask))
  check('the JPEGs came from one worker', result.jpeg.workers === 1 && result.jpeg.hashes.length === opts.pictures)
  check('no page errors', [...result.compose, result.fallback, result.jpeg].every((r) => r.errors.length === 0))

  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `worker-peaks-${opts.tag}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 1))
  log('written to', file)
  if (bad) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
