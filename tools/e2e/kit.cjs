// Shared by the checks that run parts of the app's own source in a page,
// without the app around them (worker-peaks.cjs, zip-check.cjs).
const crypto = require('crypto')
const esbuild = require('esbuild')
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MB = (bytes) => +(bytes / 1048576).toFixed(1)

// `--name value` and bare `--name` from the command line
function options(argv, defaults) {
  const out = { ...defaults }
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const name = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[name] = true
    else out[name] = typeof defaults[name] === 'number' ? Number(argv[++i]) : argv[++i]
  }
  return out
}

// The app imports its workers the way Vite spells it ('./x.worker?worker&inline':
// a class that starts the worker from its bundled source). The same thing
// for esbuild, so the page under test starts the real workers.
const inlineWorkers = {
  name: 'inline-workers',
  setup(build) {
    build.onResolve({ filter: /\?worker&inline$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?worker&inline$/, '') + '.ts'),
      namespace: 'inline-worker',
    }))
    build.onLoad({ filter: /.*/, namespace: 'inline-worker' }, (args) => {
      const built = esbuild.buildSync({ entryPoints: [args.path], bundle: true, format: 'iife', write: false, logLevel: 'warning' })
      const code = built.outputFiles[0].text
      return {
        contents: `const code = ${JSON.stringify(code)}
export default class extends Worker {
  constructor() {
    super(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
  }
}`,
        loader: 'js',
      }
    })
  },
}

// Bundles `source` (TypeScript; it imports the app's code as '@src/…', which
// is the directory `srcDir`) and returns the script
async function bundle(srcDir, source) {
  const built = await esbuild.build({
    stdin: { contents: source, resolveDir: __dirname, loader: 'ts' },
    alias: { '@src': path.resolve(srcDir) },
    bundle: true,
    format: 'iife',
    write: false,
    plugins: [inlineWorkers],
    logLevel: 'warning',
  })
  return built.outputFiles[0].text
}

// A page at ORIGIN (never reaches the network; localhost, so the page counts
// as secure and may use crypto.subtle) that runs `script` and can fetch the
// files in `files` (name → path on disk). `init` runs in the page before
// anything else.
const ORIGIN = 'http://localhost:4173'
async function openPage(browser, script, files = {}, init = null) {
  const page = await browser.newPage()
  if (init) await page.addInitScript(init)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.route(ORIGIN + '/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1)
    if (name === '') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><script src="/page.js"></script>' })
    if (name === 'page.js') return route.fulfill({ contentType: 'text/javascript', body: script })
    if (files[name]) return route.fulfill({ contentType: 'application/octet-stream', body: fs.readFileSync(files[name]) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(ORIGIN + '/')
  return { page, errors }
}

// Memory of the browser's page processes (workers live in their page's
// process), as PSS from /proc: read now, or watched for its peak while
// something runs. Linux only.
async function rendererMemory(browser) {
  const cdp = await browser.newBrowserCDPSession()
  const pids = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer').map((p) => p.id)
  const read = (list) => {
    let kb = 0
    for (const pid of list) {
      try {
        kb += Number(/^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))[1])
      } catch {
        // a process that has just gone
      }
    }
    return kb * 1024
  }
  return {
    now: async () => read(await pids()),
    // Peak while `work` runs, sampled every `every` ms
    async peakDuring(work, every = 15) {
      const list = await pids()
      let peak = read(list)
      let samples = 1
      const timer = setInterval(() => {
        peak = Math.max(peak, read(list))
        samples++
      }, every)
      try {
        return { value: await work(), peak, samples }
      } finally {
        clearInterval(timer)
      }
    },
  }
}

// The pictures: the bench's 4K astronaut at the wanted size, the same with a
// large area recoloured (the "answer"), and tinted variants to export
async function makePictures(dir, size, count) {
  const names = ['original.png', 'answer.png', ...Array.from({ length: count }, (_, i) => `picture-${i + 1}.png`)]
  if (names.every((n) => fs.existsSync(path.join(dir, n)))) return names
  const from = path.join(__dirname, '..', 'compositor-bench', 'cases', 'A-4k__mild', 'orig.png')
  if (!fs.existsSync(from)) throw new Error('No bench cases yet: run `python sim.py` in tools/compositor-bench first')
  fs.mkdirSync(dir, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.evaluate(
    async ({ b64, size }) => {
      const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob())
      window.draw = async (kind, i) => {
        const canvas = new OffscreenCanvas(size, size)
        const ctx = canvas.getContext('2d')
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(bitmap, 0, 0, size, size)
        if (kind === 'answer') {
          ctx.fillStyle = 'rgba(40, 110, 235, 0.6)'
          ctx.beginPath()
          ctx.ellipse(size / 2, size / 2, size * 0.3, size * 0.3, 0, 0, 2 * Math.PI)
          ctx.fill()
        } else if (kind === 'picture') {
          ctx.fillStyle = `hsla(${i * 55}, 80%, 50%, 0.18)`
          ctx.fillRect(0, 0, size, size)
        }
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
        let s = ''
        for (let at = 0; at < bytes.length; at += 0x8000) s += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
        return btoa(s)
      }
    },
    { b64: fs.readFileSync(from).toString('base64'), size },
  )
  for (const name of names) {
    const kind = name.startsWith('picture') ? 'picture' : name.replace('.png', '')
    const b64 = await page.evaluate(({ kind, i }) => window.draw(kind, i), { kind, i: Number(/\d+/.exec(name)?.[0] ?? 0) })
    fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'))
  }
  await browser.close()
  return names
}

module.exports = { sha256, sleep, MB, options, bundle, openPage, rendererMemory, makePictures, ORIGIN }
