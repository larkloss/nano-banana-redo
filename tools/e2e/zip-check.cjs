// "Download all" and the zip writer behind it, run from the app's own source
// in a bare page: are the files in the archive exactly the bytes each picture
// is saved as, under the right names, in order — and how much memory does
// making it take?
//
//   (cd tools/compositor-bench && python sim.py)   (the picture it starts from, once)
//   node tools/e2e/zip-check.cjs [options]
//
//   --src DIR        the source tree under test (this checkout's src/)
//   --size 2048      side of the square pictures
//   --pictures 8     how many pictures (at least 5)
//   --tag NAME       names the results: tools/e2e/out/zip-<tag>/
//   --python CMD     the Python that checks the archives (python3)
//   --plain-reads    as in a browser that can't read a file into a buffer of the
//                    caller's own (the zip writer then takes the pieces as they come)
//   --compare A B    no run: do two runs' archives hold the same names and bytes?
//
// Two archives are made and saved the way the app saves them (a download):
//
//   all.zip    downloadAllAsZip() on a gallery of PNGs kept as they are, edit
//              results held as PNG but saved as JPEG (encoded by the JPEG
//              worker, all asked for at once), an upload and a 12 MB "video"
//   store.zip  zipStore() directly (if the source tree has it): names that
//              are not ASCII, a name in a folder, an empty file, a 12 MB file
//
// zip-check.py then reads both with Python's zipfile and compares every entry
// with the sha256 of what went in. Memory: PSS of the page's process read
// from /proc while all.zip is made (the JPEGs are encoded beforehand, so the
// reading is the zip's own). Linux only.
const { chromium } = require('playwright')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { sha256, sleep, MB, options, bundle, openPage, rendererMemory, makePictures } = require('./kit.cjs')

const OUT = path.join(__dirname, 'out')
const opts = options(process.argv.slice(2), {
  src: path.join(__dirname, '..', '..', 'src'),
  size: 2048,
  pictures: 8,
  tag: 'run',
  python: 'python3',
  'plain-reads': false,
})
// What --plain-reads does to the page
const PLAIN_READS = `{
  const real = ReadableStream.prototype.getReader
  ReadableStream.prototype.getReader = function (options) {
    if (options && options.mode === 'byob') throw new TypeError('not a byte stream')
    return real.call(this, options)
  }
}`
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const page = (withStore) => `
import { downloadAllAsZip, downloadBlob, exportBlob, makeFilename } from '@src/lib/imageUtils'
${withStore ? "import { zipStore } from '@src/lib/zipStore'" : ''}

const hash = async (blob: Blob) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('')
const entry = async (name: string, blob: Blob) => ({ name, sha256: await hash(blob), size: blob.size })

// The same bytes every run (a small generator, not Math.random)
function filler(bytes: number, type: string): Blob {
  const data = new Uint32Array(bytes / 4)
  let x = 0x9e3779b9
  for (let i = 0; i < data.length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    data[i] = x
  }
  return new Blob([data], { type })
}

let gallery: any[] = []
Object.assign(window, {
  // The gallery, and what each of its pictures is saved as
  async gallery(names: string[]) {
    const blobs = []
    for (const name of names) blobs.push(new Blob([await (await fetch('/' + name)).arrayBuffer()], { type: 'image/png' }))
    const base = { objectUrl: '', width: 0, height: 0, attempt: 1, modelId: 'gemini-3.1-flash-image', createdAt: Date.UTC(2026, 0, 2, 3, 4, 5) }
    const png = { ...base, kind: 'image', mimeType: 'image/png', format: 'png' }
    gallery = blobs.map((blob, i) => {
      const id = 'p' + i
      // 2nd to 4th: results of the edit studio, saved as JPEG
      if (i >= 1 && i <= 3) return { ...png, id, blob, saveAs: 'jpg', edit: { sessionId: 's', version: i + 1, prompt: '' } }
      if (i === 4) return { ...png, id, blob, uploaded: { name: 'mine.png' } }
      return { ...png, id, blob }
    })
    gallery.push({ ...base, id: 'v', kind: 'video', blob: filler(12 * 1024 * 1024, 'video/mp4'), mimeType: 'video/mp4', format: 'png', modelId: 'gemini-omni-1.1-flash' })
    const saved = await Promise.all(gallery.map(exportBlob))
    return Promise.all(saved.map((blob, i) => entry(makeFilename(gallery[i], i), blob)))
  },
  downloadAll: () => downloadAllAsZip(gallery),
  ${
    withStore
      ? `async store(name: string) {
    const picture = await (await fetch('/' + name)).blob()
    const files = [
      { name: 'été – 写真 ☃ ñandú.png', blob: picture },
      { name: 'folder/inside it.png', blob: picture.slice(0, 1000) },
      { name: 'empty.txt', blob: new Blob([]) },
      { name: 'большой файл.bin', blob: filler(12 * 1024 * 1024 + 4, 'application/octet-stream') },
      { name: 'last.png', blob: picture },
    ]
    downloadBlob(await zipStore(files), 'store.zip')
    return Promise.all(files.map((f) => entry(f.name, f.blob)))
  },`
      : ''
  }
})
`

function compare(tagA, tagB) {
  const [a, b] = [tagA, tagB].map((t) => JSON.parse(fs.readFileSync(path.join(OUT, `zip-${t}`, 'result.json'), 'utf8')))
  const same = JSON.stringify(a.all) === JSON.stringify(b.all) && JSON.stringify(a.inputs) === JSON.stringify(b.inputs)
  for (const e of a.all) console.log(`  ${e.sha256.slice(0, 16)}…  ${String(e.size).padStart(9)}  ${e.name}`)
  console.log(same ? 'same  names, order and bytes of every file in all.zip' : 'DIFFER the files in all.zip')
  console.log(`\nmaking all.zip, memory of the page's process, MB: ${a.tag} peak ${a.memory.peakMB} (${a.memory.overMB} over the start), ${b.tag} peak ${b.memory.peakMB} (${b.memory.overMB} over the start)`)
  console.log(`time: ${a.tag} ${a.memory.ms} ms, ${b.tag} ${b.memory.ms} ms; archive ${MB(a.zipBytes)} MB and ${MB(b.zipBytes)} MB`)
  process.exit(same ? 0 : 1)
}

async function main() {
  if (opts.compare) {
    const at = process.argv.indexOf('--compare')
    return compare(process.argv[at + 1], process.argv[at + 2])
  }
  const dir = path.join(OUT, `pictures-${opts.size}`)
  const names = (await makePictures(dir, opts.size, opts.pictures)).filter((n) => n.startsWith('picture'))
  const files = Object.fromEntries(names.map((n) => [n, path.join(dir, n)]))
  const inputs = Object.fromEntries(names.map((n) => [n, sha256(fs.readFileSync(files[n]))]))
  const withStore = fs.existsSync(path.join(opts.src, 'lib', 'zipStore.ts'))
  const script = await bundle(opts.src, page(withStore))
  const out = path.join(OUT, `zip-${opts.tag}`)
  fs.mkdirSync(out, { recursive: true })
  log(`source: ${path.resolve(opts.src)}, ${names.length} pictures of ${opts.size}×${opts.size}`)

  const browser = await chromium.launch()
  const { page: p, errors } = await openPage(browser, script, files, opts['plain-reads'] ? PLAIN_READS : null)
  const cdp = await p.context().newCDPSession(p)
  const memory = await rendererMemory(browser)

  const all = await p.evaluate((n) => window.gallery(n), names)
  await cdp.send('HeapProfiler.collectGarbage')
  await sleep(500)
  const before = await memory.now()
  const t0 = Date.now()
  const measured = await memory.peakDuring(async () => {
    const [download] = await Promise.all([p.waitForEvent('download'), p.evaluate(() => window.downloadAll())])
    const ms = Date.now() - t0
    await download.saveAs(path.join(out, 'all.zip'))
    return ms
  })
  fs.writeFileSync(path.join(out, 'all.json'), JSON.stringify(all, null, 1))
  const checks = [path.join(out, 'all.zip'), path.join(out, 'all.json')]
  const result = {
    tag: opts.tag,
    src: path.resolve(opts.src),
    inputs,
    all,
    zipBytes: fs.statSync(path.join(out, 'all.zip')).size,
    memory: { ms: measured.value, samples: measured.samples, baselineMB: MB(before), peakMB: MB(measured.peak), overMB: MB(measured.peak - before) },
  }
  log(`all.zip: ${all.length} files, ${MB(result.zipBytes)} MB, made in ${result.memory.ms} ms; peak ${result.memory.peakMB} MB, ${result.memory.overMB} MB over the ${result.memory.baselineMB} MB before`)

  if (withStore) {
    const [download, store] = await Promise.all([p.waitForEvent('download'), p.evaluate((n) => window.store(n), names[0])])
    await download.saveAs(path.join(out, 'store.zip'))
    fs.writeFileSync(path.join(out, 'store.json'), JSON.stringify(store, null, 1))
    result.store = store
    checks.push(path.join(out, 'store.zip'), path.join(out, 'store.json'))
  } else log('no zipStore.ts in this source tree: store.zip skipped')
  await browser.close()
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 1))

  // PNGs kept as they are must be in the archive as the very files on disk
  let bad = 0
  const kept = all.filter((e) => e.name.endsWith('.png'))
  const untouched = kept.every((e) => Object.values(inputs).includes(e.sha256))
  console.log((untouched ? 'PASS ' : 'FAIL ') + `${kept.length} PNGs are saved as the bytes they are held in`)
  if (!untouched) bad++
  if (errors.length) {
    console.log('FAIL page errors', errors)
    bad++
  }
  const py = spawnSync(opts.python, [path.join(__dirname, 'zip-check.py'), ...checks], { stdio: 'inherit' })
  if (py.status !== 0) bad++
  log('written to', out)
  if (bad) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
