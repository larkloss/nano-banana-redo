// Memory and responsiveness of a long edit-studio session, in the built app
// with the model's answers faked: one picture is brought in, the studio is
// opened, and it is edited over many rounds, each from the version before.
// After every round the browser's memory is read per process, together with
// what the page holds (pictures, object URLs, JS heap), and at the start and
// the end a few interactions are timed (typing, switching versions,
// scrolling, closing and reopening the studio).
//
//   npm run build:single                           (the page under test)
//   (cd tools/compositor-bench && python sim.py)   (the default picture, once)
//   node tools/e2e/studio-memory.cjs [options]
//
//   --rounds N          edits in a row (12)
//   --size 2048         the picture's size: one number (square) or WxH
//   --tag NAME          names the run in the output
//   --out FILE          where the results go, as JSON (studio-memory-<tag>.json)
//   --whole             arrows, but "only around arrows" off (whole-picture edits)
//   --no-arrows         no arrows at all: a written instruction only
//   --experiment A,B    page changes injected for attribution, any of:
//                         hide-previews  version strip, result tiles, arrow guides not painted
//                         hide-gallery   gallery pictures not painted while the studio is open
//                         no-blur        no backdrop blur behind the studio
//                         thumbs         the same previews (and gallery) shown from small copies
//                         canvas-stage   the stage picture drawn into a canvas, not shown by its <img>
//   --idle S            seconds to sit idle with the studio closed (30)
//   --heap              after the last round: a heap snapshot (largest objects and what holds
//                       them) and the browser's own account of its memory, per allocator
//   --dumps             the browser's own account, per allocator, with every memory reading
//   --trace             trace each of the last interactions: picture decodes, raster, frames
//   --profile           CPU profile of the last edit: where the page's main thread spends it
//   --picture FILE      the picture to start from (the compositor bench's 4K astronaut)
//   --channel NAME      another browser build (e.g. chromium: the full browser, new headless)
//   --args "A B"        extra command-line switches for the browser under test
//   --headed            with a window
//   --compare A B       no run: compares two result files (invariants, memory, timings)
//
// The answers are made by a second browser, so their cost never lands in the
// one being measured. Each answer is the picture that was actually sent, with
// a badge painted at every arrow and a faint repaint of the whole picture
// (tone drift, fine noise), as lossless PNG — a function of the request only,
// so two runs are byte for byte the same. The sha256 of everything sent, of
// every version shown and of a real download are recorded ("invariants"): a
// change to the app that must not touch picture quality has to leave them as
// they are.
//
// Memory is PSS from /proc/<pid>/smaps_rollup for every process of the
// browser under test (found from its own --user-data-dir), after a forced GC.
// Linux only. Headless Chromium draws without a GPU: decoded pictures sit in
// the page's own process (as memory the browser gives back when short), and
// the blur behind the studio costs tens of ms a frame — on a desktop with a
// GPU both differ, so read timings against --experiment no-blur, or run
// --headed there.
const { chromium } = require('playwright')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const APP = path.join(__dirname, '..', '..', 'nano-banana.html')
const DEFAULT_PICTURE = path.join(__dirname, '..', 'compositor-bench', 'cases', 'A-4k__mild', 'orig.png')
const VIEWPORT = { width: 1440, height: 950 }
const STAGE = '[role=dialog] section:first-of-type'
const THREAD = '[role=dialog] section:nth-of-type(2) > div:first-child'
const STRIP = `${STAGE} div.overflow-x-auto`

// What --experiment injects (CSS for the page, or a script run in it)
const EXPERIMENTS = {
  // Not painted means not decoded; the layout stays as it is, so the arrows
  // land where they do in the baseline
  'hide-previews': { css: `${STRIP} img, [role=dialog] section:nth-of-type(2) img { visibility: hidden !important }` },
  'hide-gallery': { css: 'body:has([role=dialog]) main img { visibility: hidden !important }' },
  'no-blur': { css: '.backdrop-blur-sm { -webkit-backdrop-filter: none !important; backdrop-filter: none !important }' },
  thumbs: { script: thumbnailPreviews },
  'canvas-stage': { script: canvasStage },
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const MB = (bytes) => +(bytes / 1048576).toFixed(1)

function parseArgs(argv) {
  const o = { rounds: 12, size: '2048', tag: '', out: '', idle: 30, experiment: '', picture: DEFAULT_PICTURE, channel: '', args: '' }
  const flags = ['whole', 'no-arrows', 'heap', 'dumps', 'trace', 'profile', 'headed']
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    if (key === 'compare') o.compare = [argv[++i], argv[++i]]
    else if (flags.includes(key)) o[key] = true
    else if (key in o) o[key] = argv[++i]
    else throw new Error(`unknown option ${argv[i]}`)
  }
  o.rounds = Number(o.rounds)
  o.idle = Number(o.idle)
  const [w, h] = String(o.size).split('x').map(Number)
  o.width = w
  o.height = h || w
  o.experiments = o.experiment ? o.experiment.split(',') : []
  for (const name of o.experiments) if (!EXPERIMENTS[name]) throw new Error(`unknown experiment ${name}`)
  o.mode = o['no-arrows'] ? 'no-arrows' : o.whole ? 'whole' : 'local'
  o.tag = o.tag || [`${o.width}x${o.height}`, o.mode, ...o.experiments].join('-')
  o.out = o.out || `studio-memory-${o.tag}.json`
  return o
}

// ---- The fake model -------------------------------------------------------

// Where round `r` points its arrows: one on odd rounds, two on even ones,
// spread over the picture (a Halton sequence), clear of the edges
function marksFor(round) {
  const halton = (i, base) => {
    let f = 1
    let v = 0
    for (; i > 0; i = Math.floor(i / base)) {
      f /= base
      v += f * (i % base)
    }
    return v
  }
  const at = (i) => ({ x: +(0.14 + 0.72 * halton(i, 2)).toFixed(4), y: +(0.14 + 0.72 * halton(i, 3)).toFixed(4) })
  return round % 2 === 1 ? [at(2 * round - 1)] : [at(2 * round - 1), at(2 * round)]
}

// A second browser that draws: the first picture, and the model's answers
async function createPainter() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.evaluate(() => {
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const base64 = (blob) =>
      new Promise((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result.split(',')[1])
        reader.readAsDataURL(blob)
      })
    // Small, fast and the same everywhere
    const random = (seed) => () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 4294967296
    }
    const repaint = (ctx, W, H, seed, gain, lift, noise) => {
      const image = ctx.getImageData(0, 0, W, H)
      const d = image.data
      const next = random(seed)
      for (let i = 0; i < d.length; i += 4) {
        for (let c = 0; c < 3; c++) d[i + c] = d[i + c] * gain[c] + lift[c] + (next() - 0.5) * 2 * noise
      }
      ctx.putImageData(image, 0, 0)
    }
    // The picture the session starts from: a photo scaled to size (or, with
    // none at hand, shapes on a gradient), with fine grain as a camera or an
    // image model leaves it — which is what makes a PNG of a photo large
    window.basePicture = async (b64, W, H) => {
      const canvas = new OffscreenCanvas(W, H)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (b64) {
        const photo = await createImageBitmap(new Blob([bytes(b64)]))
        const scale = Math.max(W / photo.width, H / photo.height)
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(photo, (W - photo.width * scale) / 2, (H - photo.height * scale) / 2, photo.width * scale, photo.height * scale)
      } else {
        const sky = ctx.createLinearGradient(0, 0, W, H)
        sky.addColorStop(0, '#31507a')
        sky.addColorStop(1, '#d9a066')
        ctx.fillStyle = sky
        ctx.fillRect(0, 0, W, H)
        const next = random(7)
        for (let i = 0; i < 60; i++) {
          ctx.fillStyle = `hsl(${Math.floor(next() * 360)} 45% ${30 + Math.floor(next() * 40)}%)`
          ctx.beginPath()
          ctx.ellipse(next() * W, next() * H, (0.02 + next() * 0.1) * W, (0.02 + next() * 0.1) * H, next() * 3, 0, 7)
          ctx.fill()
        }
      }
      repaint(ctx, W, H, 12345, [1, 1, 1], [0, 0, 0], 3)
      return base64(await canvas.convertToBlob({ type: 'image/png' }))
    }
    // What an image model gives back for an edit: the picture it was sent,
    // changed where it was asked to (a badge at each arrow) and repainted as
    // a whole, faintly — tone a little off, fine detail redrawn
    window.answer = async (b64, mime, marks, round, seed) => {
      const source = await createImageBitmap(new Blob([bytes(b64)], { type: mime }))
      const W = source.width
      const H = source.height
      const canvas = new OffscreenCanvas(W, H)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(source, 0, 0)
      const unit = Math.min(W, H)
      marks.forEach((m, i) => {
        ctx.fillStyle = `hsl(${(round * 67 + i * 140) % 360} 85% 52%)`
        ctx.strokeStyle = 'white'
        ctx.lineWidth = unit * 0.006
        ctx.beginPath()
        ctx.ellipse(m.x * W, m.y * H, unit * 0.038, unit * 0.03, 0.4 * round, 0, 2 * Math.PI)
        ctx.fill()
        ctx.stroke()
      })
      repaint(ctx, W, H, seed, [1.01, 0.994, 1.006], [1, 0, -1], 2)
      return base64(await canvas.convertToBlob({ type: 'image/png' }))
    }
  })
  return {
    base: async (file, W, H) =>
      Buffer.from(await page.evaluate(([b, w, h]) => window.basePicture(b, w, h), [file ? fs.readFileSync(file).toString('base64') : null, W, H]), 'base64'),
    answer: async (source, mime, marks, round) =>
      Buffer.from(
        await page.evaluate(([b, t, m, r, s]) => window.answer(b, t, m, r, s), [source.toString('base64'), mime, marks, round, parseInt(sha256(source).slice(0, 8), 16) || 1]),
        'base64',
      ),
    close: () => browser.close(),
  }
}

// ---- Inside the page under test -------------------------------------------

// Runs before the app: keeps count of object URLs, long tasks and slow
// frames, and times what follows a click or a key
function probe() {
  const now = () => performance.now()
  const epoch = () => performance.timeOrigin + performance.now()
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
  const stats = (list) => {
    if (list.length === 0) return { n: 0 }
    const s = [...list].sort((a, b) => a - b)
    const at = (q) => +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1)
    return { n: s.length, median: at(0.5), p95: at(0.95), worst: +s[s.length - 1].toFixed(1) }
  }

  // Object URLs that have not been revoked, and the blobs behind them
  const urls = new Map()
  const counts = { created: 0, revoked: 0 }
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  URL.createObjectURL = function (object) {
    const url = create.call(URL, object)
    if (object instanceof Blob) urls.set(url, { size: object.size, type: object.type, blob: new WeakRef(object) })
    counts.created++
    return url
  }
  URL.revokeObjectURL = function (url) {
    if (urls.delete(url)) counts.revoked++
    return revoke.call(URL, url)
  }

  // Long tasks, long frames (with the scripts that made them long) and slow
  // events, for the whole session
  const seen = { tasks: [], frames: [], events: [], elements: [] }
  const observe = (type, add, extra = {}) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(add)).observe({ type, buffered: true, ...extra })
    } catch {
      // (an entry type this browser doesn't have)
    }
  }
  observe('longtask', (e) => seen.tasks.push({ start: e.startTime, ms: e.duration }))
  observe('long-animation-frame', (e) =>
    seen.frames.push({
      start: e.startTime,
      ms: e.duration,
      blocking: e.blockingDuration,
      scripts: e.scripts.map((s) => ({ invoker: s.invoker, fn: s.sourceFunctionName, ms: Math.round(s.duration) })),
    }),
  )
  observe('event', (e) => seen.events.push({ name: e.name, start: e.startTime, ms: e.duration, delay: e.processingStart - e.startTime, id: e.interactionId }), { durationThreshold: 16 })
  observe('element', (e) => seen.elements.push({ url: e.url, render: e.renderTime, load: e.loadTime }))

  const stageImg = () => document.querySelector('[role=dialog] section img')
  // Resolves once `done()` gives something, looked at whenever the page changes
  const watch = (done) =>
    new Promise((resolve) => {
      const check = () => {
        const value = done()
        if (!value) return
        observer.disconnect()
        resolve(value)
      }
      const observer = new MutationObserver(check)
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'alt'] })
      check()
    })
  const nextPress = () => new Promise((r) => addEventListener('pointerdown', (e) => r(e.timeStamp), { capture: true, once: true }))
  // The stage picture becoming `label`: when the page had it (commit), when
  // its bytes were loaded, when it was decoded, and two frames later
  const stage = async (label, from) => {
    const img = await watch(() => {
      const i = stageImg()
      return i && i.alt === label ? i : null
    })
    // (so its paint is reported as an element timing entry)
    img.setAttribute('elementtiming', 'stage')
    const t = { commit: now() }
    if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }))
    t.load = now()
    // (an experiment that shows the stage picture another way says when it has)
    if (window.__stageDrawn) await window.__stageDrawn(img)
    else await img.decode().catch(() => {})
    t.decoded = now()
    await frame()
    await frame()
    t.painted = now()
    await frame()
    const painted = seen.elements.filter((e) => e.url === img.currentSrc && e.render >= (from ?? 0)).pop()
    t.rendered = painted ? painted.render : null
    return t
  }
  const window_ = (from, to) => {
    const inside = (e) => e.start + e.ms > from && e.start < to
    const tasks = seen.tasks.filter(inside)
    const frames = seen.frames.filter(inside)
    const scripts = {}
    for (const f of frames) for (const s of f.scripts) scripts[s.invoker || s.fn || '?'] = (scripts[s.invoker || s.fn || '?'] ?? 0) + s.ms
    return {
      longTasks: tasks.length,
      longTaskMs: Math.round(tasks.reduce((a, t) => a + t.ms, 0)),
      worstTaskMs: Math.round(Math.max(0, ...tasks.map((t) => t.ms))),
      longFrames: frames.length,
      worstFrameMs: Math.round(Math.max(0, ...frames.map((f) => f.ms))),
      blockingMs: Math.round(frames.reduce((a, f) => a + f.blocking, 0)),
      slowScripts: Object.entries(scripts).sort((a, b) => b[1] - a[1]).slice(0, 5),
    }
  }

  let recording = null
  let typing = null
  window.__probe = {
    epoch,
    // Everything long between two moments (given as epoch ms)
    between: (from, to) => window_(from - performance.timeOrigin, to - performance.timeOrigin),
    urls: () => {
      const blobs = new Set()
      const byType = {}
      let bytes = 0
      for (const entry of urls.values()) {
        const blob = entry.blob.deref()
        if (blob && blobs.has(blob)) continue
        if (blob) blobs.add(blob)
        bytes += entry.size
        byType[entry.type || '?'] = (byType[entry.type || '?'] ?? 0) + entry.size
      }
      return { live: urls.size, bytes, byType, ...counts }
    },
    // Pictures in the page: how much they come to when decoded in full, and
    // how much the sizes they are shown at would need
    dom: () => {
      const bySrc = new Map()
      for (const img of document.images) {
        const src = img.currentSrc || img.src
        if (!src) continue
        let entry = bySrc.get(src)
        if (!entry) bySrc.set(src, (entry = { width: img.naturalWidth, height: img.naturalHeight, encoded: urls.get(src)?.size ?? null, shown: [] }))
        entry.shown.push({
          where: img.closest('[role=dialog]') ? 'studio' : 'gallery',
          alt: img.alt,
          css: [img.clientWidth, img.clientHeight],
          painted: getComputedStyle(img).visibility !== 'hidden',
        })
      }
      const list = [...bySrc.values()].map((e) => ({ ...e, decodedBytes: e.width * e.height * 4 }))
      const dpr = devicePixelRatio
      const needed = (e) => Math.min(e.decodedBytes, Math.max(0, ...e.shown.filter((s) => s.painted).map((s) => s.css[0] * dpr * s.css[1] * dpr * 4)))
      return {
        nodes: document.getElementsByTagName('*').length,
        imgElements: document.images.length,
        distinctSrc: list.length,
        decodedUpperBoundBytes: list.reduce((a, e) => a + e.decodedBytes, 0),
        paintedUpperBoundBytes: list.filter((e) => e.shown.some((s) => s.painted)).reduce((a, e) => a + e.decodedBytes, 0),
        asShownBytes: Math.round(list.reduce((a, e) => a + needed(e), 0)),
        encodedBytes: list.reduce((a, e) => a + (e.encoded ?? 0), 0),
        largest: list.sort((a, b) => b.decodedBytes - a.decodedBytes).slice(0, 6),
      }
    },
    // sha256 of the bytes behind the stage picture
    stageBytes: async () => {
      const img = stageImg()
      const buffer = await (await fetch(img.src)).arrayBuffer()
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))
      return {
        sha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
        bytes: buffer.byteLength,
        alt: img.alt,
        width: img.naturalWidth,
        height: img.naturalHeight,
        box: [img.clientWidth, img.clientHeight],
      }
    },
    // The stage showing `label`, as epoch times (an edit's result arriving)
    stageShown: async (label) => {
      const t = await stage(label)
      return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v === null ? null : v + performance.timeOrigin]))
    },
    // The next press, and the stage showing `label` after it: ms from the press
    pressToStage: async (label) => {
      const t0 = await nextPress()
      const t = await stage(label, t0)
      const end = now()
      return { ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v === null ? null : +(v - t0).toFixed(1)])), ...window_(t0, end) }
    },
    // The next press, and `selector` being gone after it
    pressToGone: async (selector) => {
      const t0 = await nextPress()
      await watch(() => !document.querySelector(selector))
      const commit = now()
      await frame()
      await frame()
      return { commit: +(commit - t0).toFixed(1), painted: +(now() - t0).toFixed(1), ...window_(t0, now()) }
    },
    frames: {
      start: () => {
        recording = { times: [now()], on: true }
        const tick = () => {
          if (!recording.on) return
          recording.times.push(now())
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      },
      stop: () => {
        recording.on = false
        const t = recording.times
        const gaps = t.slice(1).map((v, i) => v - t[i])
        return {
          ...stats(gaps),
          frames: gaps.length,
          ms: Math.round(t[t.length - 1] - t[0]),
          // frames a 60 Hz screen would have shown in the gaps
          dropped: gaps.reduce((a, g) => a + Math.max(0, Math.round(g / 16.67) - 1), 0),
          over50ms: gaps.filter((g) => g > 50).length,
          ...window_(t[0], t[t.length - 1]),
        }
      },
    },
    // Per key typed: how long the event waited for the main thread, and how
    // long until the frame that shows it was produced
    typing: {
      start: () => {
        typing = { from: now(), delay: [], frame: [], listener: null }
        typing.listener = (e) => {
          const t0 = e.timeStamp
          typing.delay.push(now() - t0)
          const run = typing
          requestAnimationFrame(() => setTimeout(() => run.frame.push(now() - t0), 0))
        }
        addEventListener('input', typing.listener, true)
      },
      stop: () => {
        removeEventListener('input', typing.listener, true)
        // Event Timing: to the next paint on screen, per interaction (entries
        // only exist from 16 ms up; anything faster counts as 8)
        const byId = new Map()
        for (const e of seen.events) if (e.start >= typing.from && e.id) byId.set(e.id, Math.max(byId.get(e.id) ?? 0, e.ms))
        const paints = [...byId.values()]
        while (paints.length < typing.frame.length) paints.push(8)
        return { keys: typing.frame.length, inputDelayMs: stats(typing.delay), toFrameMs: stats(typing.frame), toPaintMs: stats(paints), slowEvents: byId.size, ...window_(typing.from, now()) }
      },
    },
  }
}

// --experiment thumbs: every small preview is shown from a copy of at most
// 256 px instead of the full picture — what the app could do itself. The
// stage and the zoomed view keep the real picture.
function thumbnailPreviews() {
  const made = new Map()
  const thumbnails = new Set()
  const small = (src) => {
    if (!made.has(src))
      made.set(
        src,
        (async () => {
          const blob = await (await fetch(src)).blob()
          const full = await createImageBitmap(blob)
          const scale = Math.min(1, 256 / Math.max(full.width, full.height))
          const canvas = new OffscreenCanvas(Math.round(full.width * scale), Math.round(full.height * scale))
          const ctx = canvas.getContext('2d')
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(full, 0, 0, canvas.width, canvas.height)
          full.close()
          const url = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }))
          thumbnails.add(url)
          return url
        })(),
      )
    return made.get(src)
  }
  const previews = 'main img, [role=dialog] section:first-of-type div.overflow-x-auto img, [role=dialog] section:nth-of-type(2) img'
  const swap = (img) => {
    const src = img.getAttribute('src')
    if (!src || !src.startsWith('blob:') || thumbnails.has(src)) return
    // (not shown, and so not decoded, until the small copy is there)
    img.style.visibility = 'hidden'
    void small(src).then((url) => {
      if (img.getAttribute('src') !== src) return
      img.src = url
      img.style.visibility = ''
    })
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target.matches(previews)) swap(record.target)
        continue
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue
        for (const img of node.matches('img') ? [node] : node.querySelectorAll('img')) if (img.matches(previews)) swap(img)
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
}

// --experiment canvas-stage: the stage's <img> is kept (the app measures and
// labels it) but never painted; the picture is decoded once into an
// ImageBitmap, drawn into a canvas laid over it at the size it is shown, and
// the bitmap is closed. Tells what the browser keeps for pictures shown by an
// <img> — on screen this is not the app's own scaling, so not a fix as it is.
function canvasStage() {
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;pointer-events:none'
  let drawn = null
  let waiting = []
  const draw = async (img) => {
    const src = img.getAttribute('src')
    const place = () => {
      canvas.style.left = `${img.offsetLeft}px`
      canvas.style.top = `${img.offsetTop}px`
      canvas.style.width = `${img.clientWidth}px`
      canvas.style.height = `${img.clientHeight}px`
    }
    if (canvas.previousSibling !== img) img.after(canvas)
    if (drawn === src) return place()
    const bitmap = await createImageBitmap(await (await fetch(src)).blob())
    if (img.getAttribute('src') !== src) return bitmap.close()
    if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }))
    place()
    canvas.width = Math.round(img.clientWidth * devicePixelRatio)
    canvas.height = Math.round(img.clientHeight * devicePixelRatio)
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    drawn = src
    waiting.forEach((done) => done())
    waiting = []
  }
  const stage = () => document.querySelector('[role=dialog] section:first-of-type img.object-contain')
  window.__stageDrawn = (img) => new Promise((r) => (drawn === img.getAttribute('src') ? r() : waiting.push(r)))
  const style = document.createElement('style')
  style.textContent = '[role=dialog] section:first-of-type img.object-contain { visibility: hidden !important }'
  addEventListener('DOMContentLoaded', () => document.head.appendChild(style))
  const look = () => {
    const img = stage()
    if (img) void draw(img)
    else drawn = null
  }
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
  addEventListener('resize', look)
}

// ---- Memory of the browser under test -------------------------------------

// Every process of the browser started with this profile directory: the one
// that carries it on its command line, and all that descend from it
function browserProcesses(profile) {
  const table = []
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      table.push({ pid: Number(pid), parent: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), cmdline })
    } catch {
      // (gone in the meantime)
    }
  }
  const root = table.find((p) => p.cmdline.includes(`--user-data-dir=${profile}`) && !p.cmdline.join(' ').includes(' --type='))
  if (!root) throw new Error('the browser under test is not running')
  const ours = new Set([root.pid])
  for (let grew = true; grew; ) {
    grew = false
    for (const p of table) {
      if (ours.has(p.pid) || !ours.has(p.parent)) continue
      ours.add(p.pid)
      grew = true
    }
  }
  return table
    .filter((p) => ours.has(p.pid))
    .map((p) => {
      // (child processes carry their whole command line as one string)
      const line = p.cmdline.join(' ')
      const flag = (name) => (line.match(new RegExp(`--${name}=(\\S+)`)) ?? ['', ''])[1]
      const type = flag('type')
      return {
        pid: p.pid,
        type: type === '' ? 'browser' : type === 'gpu-process' ? 'gpu' : type === 'renderer' || type === 'utility' ? type : 'other',
        detail: flag('utility-sub-type') || type,
      }
    })
}

function processMemory(profile) {
  const byType = {}
  const processes = []
  for (const p of browserProcesses(profile)) {
    let rollup
    try {
      rollup = fs.readFileSync(`/proc/${p.pid}/smaps_rollup`, 'utf8')
    } catch {
      continue
    }
    const kb = (name) => Number((rollup.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm')) ?? [0, 0])[1])
    const m = { pssMB: MB(kb('Pss') * 1024), rssMB: MB(kb('Rss') * 1024), anonMB: MB(kb('Pss_Anon') * 1024), fileMB: MB(kb('Pss_File') * 1024), shmemMB: MB(kb('Pss_Shmem') * 1024) }
    processes.push({ ...p, ...m })
    const sum = (byType[p.type] ??= { pssMB: 0, rssMB: 0, anonMB: 0, fileMB: 0, shmemMB: 0, processes: 0 })
    for (const key of Object.keys(m)) sum[key] = +(sum[key] + m[key]).toFixed(1)
    sum.processes++
  }
  return { totalPssMB: +processes.reduce((a, p) => a + p.pssMB, 0).toFixed(1), byType, processes }
}

// ---- The run ---------------------------------------------------------------

async function run(o) {
  if (!fs.existsSync(APP)) throw new Error(`${APP} is missing — npm run build:single`)
  const painter = await createPainter()
  // (its own profile directory is how the browser's processes are told apart)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nbr-studio-memory-'))
  const context = await chromium.launchPersistentContext(profile, {
    viewport: VIEWPORT,
    headless: !o.headed,
    acceptDownloads: true,
    ...(o.channel ? { channel: o.channel } : {}),
    ...(o.args ? { args: o.args.split(/\s+/).filter(Boolean) } : {}),
  })
  try {
    const result = await session(o, painter, context, profile)
    fs.writeFileSync(o.out, JSON.stringify(result, null, 1))
    log(`invariants ${result.invariants.digest.slice(0, 16)}… · page errors: ${result.errors.length} · written to ${o.out}`)
  } finally {
    await context.close().catch(() => {})
    await painter.close().catch(() => {})
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

// Playwright keeps the inspector's Network domain switched on, and with it
// the page's process keeps a base64 copy of the pictures it has loaded (about
// 200 MB of them before it lets go) — memory no user's browser holds. Those
// buffers are set to nothing, on Playwright's own session with the page; if
// its internals have moved, the run goes on and says so in its results.
async function withoutInspectorCopies(page) {
  try {
    const session = page._connection.toImpl(page).delegate._mainFrameSession._client
    await session.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 })
    return true
  } catch {
    log('(could not switch off the inspector’s copies of loaded pictures: the renderer’s memory will include them)')
    return false
  }
}

// One session in the browser under test, from the first picture to the last reading
async function session(o, painter, context, profile) {
  const picture = fs.existsSync(o.picture) ? o.picture : null
  if (!picture) log(`(${o.picture} is missing: starting from a drawn picture instead)`)
  log(`painting the ${o.width}×${o.height} picture to start from`)
  const base = await painter.base(picture, o.width, o.height)

  const page = context.pages()[0] ?? (await context.newPage())
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  const inspectorCopies = !(await withoutInspectorCopies(page))
  const cdp = await context.newCDPSession(page)
  const browserCdp = await context.browser().newBrowserCDPSession()
  await cdp.send('Performance.enable')
  await cdp.send('HeapProfiler.enable')
  const tracing = tracer(browserCdp)

  const css = o.experiments.map((name) => EXPERIMENTS[name].css).filter(Boolean).join('\n')
  await page.addInitScript(probe)
  if (css) {
    await page.addInitScript((text) => {
      const style = document.createElement('style')
      style.textContent = text
      addEventListener('DOMContentLoaded', () => document.head.appendChild(style))
    }, css)
  }
  for (const name of o.experiments) if (EXPERIMENTS[name].script) await page.addInitScript(EXPERIMENTS[name].script)

  // The fake Gemini: the first request is the generation, every later one an
  // edit, answered from the picture it carries
  const requests = []
  let round = 0
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const at = Date.now()
    const parts = route.request().postDataJSON().contents[0].parts
    const pictures = parts.filter((p) => p.inlineData).map((p) => ({ mime: p.inlineData.mimeType, data: Buffer.from(p.inlineData.data, 'base64') }))
    const prompt = parts.filter((p) => p.text).map((p) => p.text).join('\n')
    let answer = base
    if (pictures.length > 0) answer = await painter.answer(pictures[0].data, pictures[0].mime, marksFor(round), round)
    const describe = (p) => (p ? { sha256: sha256(p.data), bytes: p.data.length, mime: p.mime } : null)
    const entry = {
      round,
      source: describe(pictures[0]),
      guide: describe(pictures[1]),
      others: pictures.slice(2).map(describe),
      prompt: sha256(prompt),
      answer: { sha256: sha256(answer), bytes: answer.length },
      at,
      answeredAt: Date.now(),
    }
    requests.push(entry)
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: answer.toString('base64') } }] }, finishReason: 'STOP' }] }),
    })
    entry.fulfilledAt = Date.now()
  })

  await page.goto('file://' + APP)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('nbr.apiKey', 'g')
    localStorage.setItem('nbr.settings.v1', JSON.stringify({ targetCount: 1, prompt: 'x', attemptsCap: 3 }))
    localStorage.setItem('nbr.capDefault50', '1')
    localStorage.setItem('nbr.promptModules.v1', JSON.stringify({ mode: 'simple', modules: [] }))
  })
  await page.reload()

  const system = await browserCdp.send('SystemInfo.getInfo')
  const result = {
    meta: {
      tag: o.tag,
      date: new Date().toISOString(),
      argv: process.argv.slice(2),
      size: [o.width, o.height],
      rounds: o.rounds,
      mode: o.mode,
      experiments: o.experiments,
      app: { sha256: sha256(fs.readFileSync(APP)), bytes: fs.statSync(APP).size },
      picture: { from: picture ? path.basename(path.dirname(picture)) + '/' + path.basename(picture) : 'drawn', sha256: sha256(base), bytes: base.length },
      browser: (await browserCdp.send('Browser.getVersion')).product,
      headless: !o.headed,
      // (true would mean the renderer's numbers include the inspector's copies of loaded pictures)
      inspectorCopies,
      gpu: { device: system.gpu.devices[0]?.deviceString ?? null, features: system.gpu.featureStatus ?? null },
      viewport: VIEWPORT,
      cpus: os.cpus().length,
      totalMemMB: MB(os.totalmem()),
    },
    samples: [],
    rounds: [],
    responsiveness: {},
    invariants: {},
    errors,
  }

  // What the browser itself says its memory is made of, right now
  const memoryDump = async () => {
    await tracing.start(['disabled-by-default-memory-infra'])
    await browserCdp.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed' })
    return summariseMemoryDump(await tracing.stop())
  }
  // One reading of everything, after things have settled and a forced GC
  const sample = async (label, extra = {}) => {
    await sleep(1000)
    await cdp.send('HeapProfiler.collectGarbage')
    await cdp.send('HeapProfiler.collectGarbage')
    await sleep(700)
    const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
    const cpu = {}
    for (const p of (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo) {
      const type = p.type === 'GPU' ? 'gpu' : p.type === 'browser' || p.type === 'renderer' ? p.type : 'utility'
      cpu[type] = +((cpu[type] ?? 0) + p.cpuTime).toFixed(2)
    }
    const s = {
      label,
      ...extra,
      memory: processMemory(profile),
      cpuSeconds: cpu,
      js: { heapUsedMB: MB(metrics.JSHeapUsedSize), heapTotalMB: MB(metrics.JSHeapTotalSize), nodes: metrics.Nodes, listeners: metrics.JSEventListeners },
      dom: await page.evaluate(() => window.__probe.dom()),
      urls: await page.evaluate(() => window.__probe.urls()),
    }
    if (o.dumps) s.allocators = await memoryDump()
    result.samples.push(s)
    const t = s.memory.byType
    log(
      `[${label}] total ${s.memory.totalPssMB} MB — browser ${t.browser?.pssMB ?? 0} · renderer ${t.renderer?.pssMB ?? 0} · gpu ${t.gpu?.pssMB ?? 0} · utility ${t.utility?.pssMB ?? 0}` +
        ` | heap ${s.js.heapUsedMB} MB | urls ${s.urls.live} (${MB(s.urls.bytes)} MB) | ${s.dom.imgElements} img, decoded ≤ ${MB(s.dom.decodedUpperBoundBytes)} MB`,
    )
    return s
  }

  const dialogText = () => page.evaluate(() => document.querySelector('[role=dialog]')?.innerText ?? '')
  const stageBox = () => page.locator(`${STAGE} svg.touch-none`).first().boundingBox()
  const label = (n) => (n === 0 ? 'Original' : `Version ${n}`)

  // ---- Interactions that are timed ----

  // (a) 20 characters into the instruction box, several times over
  const typingRun = async (repeats = 3) => {
    const box = page.locator('[role=dialog] section:nth-of-type(2) textarea')
    await box.click()
    await page.evaluate(() => window.__probe.typing.start())
    for (let r = 0; r < repeats; r++) {
      for (const key of 'make the sky warmer.') {
        await page.keyboard.type(key)
        await sleep(60)
      }
    }
    await sleep(200)
    const timing = await page.evaluate(() => window.__probe.typing.stop())
    await box.fill('')
    return timing
  }
  // (b) clicks in the version strip: until the stage shows the other version
  const switchingRun = async (order) => {
    const each = []
    for (const n of order) {
      const shown = page.evaluate((l) => window.__probe.pressToStage(l), label(n))
      await page.locator(`${STRIP} button`).nth(n).click()
      each.push({ to: n, ...(await shown) })
      await sleep(250)
    }
    const column = (key) => each.map((e) => e[key]).filter((v) => v !== null)
    return {
      commitMs: summary(column('commit')),
      decodedMs: summary(column('decoded')),
      paintedMs: summary(column('painted')),
      renderedMs: summary(column('rendered')),
      longTaskMs: each.reduce((a, e) => a + e.longTaskMs, 0),
      each,
    }
  }
  // (c) the mouse wheel, top to bottom and back, over something that scrolls
  const scrollRun = async (selector) => {
    const box = await page.locator(selector).first().boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const range = await page.evaluate((s) => {
      const el = document.querySelector(s)
      el.scrollTop = 0
      return el.scrollHeight - el.clientHeight
    }, selector)
    await sleep(400)
    await page.evaluate(() => window.__probe.frames.start())
    for (const direction of [1, -1]) {
      for (let y = 0; y < range + 200; y += 100) {
        await page.mouse.wheel(0, 100 * direction)
        await sleep(16)
      }
      await sleep(250)
    }
    return { rangePx: range, ...(await page.evaluate(() => window.__probe.frames.stop())) }
  }
  // (d) out of the studio, through the gallery, and back in
  const closeAndReopen = async (version, between = async () => {}) => {
    const gone = page.evaluate(() => window.__probe.pressToGone('[role=dialog]'))
    await page.locator('[role=dialog] header button:has-text("✕")').click()
    const close = await gone
    const gallery = await scrollRun('main')
    await between()
    const shown = page.evaluate((l) => window.__probe.pressToStage(l), label(version))
    const card = version === 0 ? page.locator('main div.group') : page.locator(`main div.group:has(span:text-is("✏️ v${version}"))`)
    await card.locator('button:has-text("✏️ Edit")').first().click()
    const reopen = await shown
    await page.waitForSelector(`${STAGE} svg.touch-none`)
    return { close, gallery, reopen }
  }

  // ---- One edit ----
  const edit = async (n) => {
    const marks = o.mode === 'no-arrows' ? [] : marksFor(n)
    const box = await stageBox()
    for (const m of marks) {
      await page.mouse.click(box.x + box.width * m.x, box.y + box.height * m.y)
      await page.keyboard.type('add a round badge here')
    }
    if (marks.length === 0) await page.locator('[role=dialog] section:nth-of-type(2) textarea').fill('make the light a little warmer')
    else await page.locator('[role=dialog] label:has-text("only around arrows") input').setChecked(o.mode === 'local')
    round = n
    const sent = requests.length
    const shown = page.evaluate((l) => window.__probe.stageShown(l), label(n))
    const failed = page
      .waitForFunction(() => /Gave up after|Something went wrong|could not be decoded|can’t be pasted|already running/.test(document.querySelector('[role=dialog]')?.innerText ?? ''), null, { timeout: 0 })
      .then(() => 'failed')
    failed.catch(() => {})
    // (with --profile, the last edit is sampled from "Apply edit" to the turn's end)
    const profiled = o.profile && n === o.rounds
    if (profiled) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
      await cdp.send('Profiler.start')
    }
    const appliedAt = await page.evaluate(() => window.__probe.epoch())
    await page.locator('[role=dialog] button:has-text("Apply edit")').click()
    const t = await Promise.race([shown, failed])
    if (t === 'failed') throw new Error(`round ${n} did not produce a version:\n${(await dialogText()).slice(-600)}`)
    await page.locator('[role=dialog] button:has-text("Apply edit")').waitFor({ timeout: 0 })
    const doneAt = await page.evaluate(() => window.__probe.epoch())
    if (profiled) result.profile = summariseProfile((await cdp.send('Profiler.stop')).profile)
    const mine = requests.slice(sent)
    const fakeMs = mine.reduce((a, r) => a + (r.fulfilledAt - r.at), 0)
    const entry = {
      round: n,
      marks,
      requests: mine.length,
      timing: {
        // from "Apply edit" to the new version painted, and its parts
        totalMs: Math.round(t.painted - appliedAt),
        beforeRequestMs: Math.round(mine[0].at - appliedAt),
        fakeAnswerMs: fakeMs,
        afterAnswerMs: Math.round(t.painted - mine[mine.length - 1].fulfilledAt),
        localMs: Math.round(t.painted - appliedAt - fakeMs),
        // of which, once the page had the new version: loading, decoding, painting it
        showMs: Math.round(t.painted - t.commit),
        turnDoneMs: Math.round(doneAt - appliedAt),
      },
      mainThread: await page.evaluate(([a, b]) => window.__probe.between(a, b), [appliedAt, doneAt]),
      stage: await page.evaluate(() => window.__probe.stageBytes()),
      note: ((await dialogText()).match(/Done[^\n]*/g) ?? []).pop() ?? null,
    }
    result.rounds.push(entry)
    log(
      `round ${n}: ${entry.timing.totalMs} ms (before request ${entry.timing.beforeRequestMs}, fake answer ${fakeMs}, after ${entry.timing.afterAnswerMs}) · ` +
        `main thread blocked ${entry.mainThread.longTaskMs} ms, worst ${entry.mainThread.worstTaskMs} · sent ${MB(mine[0].source.bytes)} MB ${mine[0].source.mime}, ` +
        `answer ${MB(mine[0].answer.bytes)} MB, version ${MB(entry.stage.bytes)} MB`,
    )
  }

  // ---- The session ----
  await page.click('button:has-text("Generate 1 image")')
  await page.waitForSelector('main img[alt^="Generated"]', { timeout: 120000 })
  await sample('gallery, one picture')
  await page.locator('button:has-text("✏️ Edit")').first().click()
  await page.waitForSelector(`${STAGE} svg.touch-none`)
  await page.evaluate((l) => window.__probe.stageShown(l), 'Original')
  result.meta.stageBox = await stageBox()
  await sample('studio open', { round: 0 })

  log('timing interactions before any edit')
  result.responsiveness.start = {
    typing: await typingRun(),
    threadScroll: await scrollRun(THREAD),
    ...(await closeAndReopen(0)),
  }

  for (let n = 1; n <= o.rounds; n++) {
    await edit(n)
    await sample(`round ${n}`, { round: n })
    if (n === 1) {
      // (with a single version there is nothing to switch between)
      result.responsiveness.afterRound1 = { switching: await switchingRun([0, 1, 0, 1, 0, 1]) }
    }
  }

  const last = o.rounds
  // (with --trace, each interaction is traced on its own: what the browser
  // spent its time on while it ran — slower than without, so not for timings)
  const traces = {}
  const traced = async (name, work) => {
    if (!o.trace) return work()
    await tracing.start(TIMELINE_CATEGORIES)
    const value = await work()
    traces[name] = summariseTrace(await tracing.stop())
    return value
  }
  log('timing interactions after the last round')
  // every version once (first time on the stage for most), then back and forth
  const visits = [...Array(last).keys(), last, last - 1, last, 0, last]
  const end = {
    typing: await traced('typing', () => typingRun()),
    switching: await traced('switching', () => switchingRun(visits)),
    threadScroll: await traced('threadScroll', () => scrollRun(THREAD)),
  }
  await sample('after interactions', { round: last })
  Object.assign(
    end,
    await closeAndReopen(last, async () => {
      await sample('studio closed', { round: last })
      if (o.idle > 0) {
        await sleep(o.idle * 1000)
        await sample(`studio closed, idle ${o.idle} s`, { round: last })
      }
    }),
  )
  result.responsiveness.end = end
  if (o.trace) result.trace = traces
  await sample('studio reopened', { round: last })

  // A real download of the last version
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[role=dialog] button:has-text("↓ Download")').click()])
  const saved = fs.readFileSync(await download.path())
  const downloaded = { name: download.suggestedFilename().replace(/_\d{4}-.*_/, '_<time>_'), sha256: sha256(saved), bytes: saved.length }

  // What the page's script still holds
  result.objects = await liveObjects(cdp)
  if (o.heap) {
    log('taking a memory dump and a heap snapshot')
    result.allocators = await memoryDump()
    result.heap = await heapSnapshot(cdp)
  }
  // What goes when the browser is told memory is short: caches, not leaks
  await cdp.send('Memory.simulatePressureNotification', { level: 'critical' }).catch(() => {})
  await sample('after memory pressure', { round: last })

  const sentPictures = requests.map((r) => ({ round: r.round, source: r.source, guide: r.guide, prompt: r.prompt, answer: r.answer.sha256 }))
  const stages = result.rounds.map((r) => ({ round: r.round, sha256: r.stage.sha256, bytes: r.stage.bytes, size: [r.stage.width, r.stage.height] }))
  result.invariants = { sent: sentPictures, stages, download: downloaded, digest: sha256(JSON.stringify([sentPictures, stages, downloaded])) }
  result.requests = requests.map(({ at, answeredAt, fulfilledAt, ...r }) => ({ ...r, answerMs: answeredAt - at }))

  return result
}

function summary(list) {
  if (list.length === 0) return { n: 0 }
  const s = [...list].sort((a, b) => a - b)
  return { n: s.length, median: s[Math.floor(s.length / 2)], worst: s[s.length - 1] }
}

// ---- What the page's script holds ------------------------------------------

// Blobs and ArrayBuffers the script can still reach (after a GC)
async function liveObjects(cdp) {
  const count = async (prototype, measure) => {
    const proto = await cdp.send('Runtime.evaluate', { expression: prototype })
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId })
    const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: measure, returnByValue: true })
    await cdp.send('Runtime.releaseObject', { objectId: objects.objectId })
    return result.value
  }
  return {
    blobs: await count(
      'Blob.prototype',
      `function () {
        const byType = {}
        for (const b of this) { const t = (byType[b.type || '?'] ??= { count: 0, bytes: 0 }); t.count++; t.bytes += b.size }
        return { count: this.length, bytes: this.reduce((a, b) => a + b.size, 0), byType, largest: this.map((b) => b.size).sort((a, b) => b - a).slice(0, 8) }
      }`,
    ),
    arrayBuffers: await count(
      'ArrayBuffer.prototype',
      `function () {
        return { count: this.length, bytes: this.reduce((a, b) => a + b.byteLength, 0), detached: this.filter((b) => b.detached).length, largest: this.map((b) => b.byteLength).sort((a, b) => b - a).slice(0, 8) }
      }`,
    ),
  }
}

// A heap snapshot, boiled down: sizes by kind of object, the largest objects
// with the shortest path that keeps each alive, long strings, detached nodes
async function heapSnapshot(cdp) {
  const chunks = []
  const onChunk = (e) => chunks.push(e.chunk)
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false })
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
  const snap = JSON.parse(chunks.join(''))
  const meta = snap.snapshot.meta
  const nf = meta.node_fields.length
  const ef = meta.edge_fields.length
  const [nType, nName, nSelf, nEdges, nDetached] = ['type', 'name', 'self_size', 'edge_count', 'detachedness'].map((f) => meta.node_fields.indexOf(f))
  const [eType, eName, eTo] = ['type', 'name_or_index', 'to_node'].map((f) => meta.edge_fields.indexOf(f))
  const nodeTypes = meta.node_types[0]
  const edgeTypes = meta.edge_types[0]
  const { nodes, edges, strings } = snap
  const count = nodes.length / nf
  const typeOf = (i) => nodeTypes[nodes[i * nf + nType]]
  const nameOf = (i) => strings[nodes[i * nf + nName]]
  const sizeOf = (i) => nodes[i * nf + nSelf]

  // Breadth first from the root: for every object, the edge it was first reached by
  const firstEdge = new Int32Array(count).fill(-1)
  const parent = new Int32Array(count).fill(-1)
  const edgeStart = new Int32Array(count + 1)
  for (let i = 0; i < count; i++) edgeStart[i + 1] = edgeStart[i] + nodes[i * nf + nEdges]
  const queue = new Int32Array(count)
  let head = 0
  let tail = 1
  parent[0] = 0
  while (head < tail) {
    const from = queue[head++]
    for (let e = edgeStart[from]; e < edgeStart[from + 1]; e++) {
      if (edgeTypes[edges[e * ef + eType]] === 'weak') continue
      const to = edges[e * ef + eTo] / nf
      if (parent[to] !== -1) continue
      parent[to] = from
      firstEdge[to] = e
      queue[tail++] = to
    }
  }
  const short = (text, n = 60) => (text.length > n ? `${text.slice(0, n)}…` : text)
  const heldBy = (i) => {
    const steps = []
    for (let at = i; at !== 0 && parent[at] !== -1 && steps.length < 14; at = parent[at]) {
      const e = firstEdge[at]
      const kind = edgeTypes[edges[e * ef + eType]]
      const via = kind === 'element' || kind === 'hidden' ? `[${edges[e * ef + eName]}]` : strings[edges[e * ef + eName]]
      steps.push(`${short(nameOf(parent[at]) || typeOf(parent[at]), 40)}.${short(String(via), 30)}`)
    }
    return steps.join(' ← ')
  }

  const byType = {}
  const order = []
  const detached = {}
  let longStrings = { count: 0, bytes: 0 }
  for (let i = 0; i < count; i++) {
    const type = typeOf(i)
    const size = sizeOf(i)
    const t = (byType[type] ??= { count: 0, bytes: 0 })
    t.count++
    t.bytes += size
    if (size >= 100000) order.push(i)
    if (/string/.test(type) && size >= 100000) longStrings = { count: longStrings.count + 1, bytes: longStrings.bytes + size }
    if (nDetached >= 0 && nodes[i * nf + nDetached] === 2) detached[nameOf(i)] = (detached[nameOf(i)] ?? 0) + 1
  }
  order.sort((a, b) => sizeOf(b) - sizeOf(a))
  return {
    totalMB: MB(Object.values(byType).reduce((a, t) => a + t.bytes, 0)),
    byType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1].bytes - a[1].bytes).map(([k, v]) => [k, { count: v.count, MB: MB(v.bytes) }])),
    longStrings: { count: longStrings.count, MB: MB(longStrings.bytes) },
    over100kB: { count: order.length, MB: MB(order.reduce((a, i) => a + sizeOf(i), 0)) },
    largest: order.slice(0, 30).map((i) => ({ MB: MB(sizeOf(i)), type: typeOf(i), name: short(nameOf(i), 50), heldBy: heldBy(i) })),
    detachedNodes: Object.entries(detached).sort((a, b) => b[1] - a[1]).slice(0, 12),
  }
}

// A CPU profile of the page's main thread, boiled down: the functions most
// time was spent in themselves, with where they are in the built page (its
// code is minified, so a piece of the source says more than the name)
function summariseProfile(profile) {
  const lines = fs.readFileSync(APP, 'utf8').split('\n')
  const self = new Map()
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)))
  const byFunction = new Map()
  let total = 0
  for (const node of profile.nodes) {
    const ms = (self.get(node.id) ?? 0) / 1000
    const f = node.callFrame
    if (f.functionName === '(idle)') continue
    total += ms
    const key = `${f.functionName}|${f.url}|${f.lineNumber}|${f.columnNumber}`
    const entry = byFunction.get(key) ?? { name: f.functionName || '(anonymous)', ms: 0, at: f.url ? `${f.lineNumber + 1}:${f.columnNumber + 1}` : 'native', source: '' }
    if (f.url && f.url.startsWith('file:') && lines[f.lineNumber]) entry.source = lines[f.lineNumber].slice(f.columnNumber, f.columnNumber + 110)
    entry.ms += ms
    byFunction.set(key, entry)
  }
  const top = [...byFunction.values()].sort((a, b) => b.ms - a.ms).slice(0, 14)
  return { busyMs: Math.round(total), top: top.map((e) => ({ ...e, ms: Math.round(e.ms) })) }
}

// ---- Traces -----------------------------------------------------------------

const TIMELINE_CATEGORIES = ['cc', 'viz', 'blink', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame']

// The browser's tracing, from start() to stop(), as a list of events
function tracer(browserCdp) {
  return {
    start: (categories) => browserCdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: categories, excludedCategories: ['*'] } }),
    stop: async () => {
      const complete = new Promise((r) => browserCdp.once('Tracing.tracingComplete', r))
      await browserCdp.send('Tracing.end')
      const { stream } = await complete
      const chunks = []
      for (;;) {
        const part = await browserCdp.send('IO.read', { handle: stream, size: 8 << 20 })
        chunks.push(part.base64Encoded ? Buffer.from(part.data, 'base64') : Buffer.from(part.data))
        if (part.eof) break
      }
      await browserCdp.send('IO.close', { handle: stream })
      const trace = JSON.parse(Buffer.concat(chunks).toString())
      return trace.traceEvents ?? trace
    },
  }
}

const processNames = (events) => {
  const names = {}
  for (const e of events) if (e.ph === 'M' && e.name === 'process_name') names[e.pid] = e.args.name
  return names
}

// The browser's own account of its memory (a memory-infra dump): per process,
// MB per allocator — what the process totals read from /proc are made of.
// Allocators overlap in places (a cache entry is also a malloc block).
function summariseMemoryDump(events) {
  const names = processNames(events)
  const processes = {}
  for (const e of events) {
    const allocators = e.ph === 'v' && e.args?.dumps?.allocators
    if (!allocators) continue
    // (one process's dump can come in several events)
    const tree = (processes[`${names[e.pid] ?? 'process'} ${e.pid}`] ??= {})
    for (const [name, dump] of Object.entries(allocators)) {
      let level = tree
      let node = null
      for (const part of name.split('/')) {
        node = level[part] ??= { own: null, under: {} }
        level = node.under
      }
      if (dump.attrs?.size) node.own = parseInt(dump.attrs.size.value, 16)
    }
  }
  // a node's size is its own, or failing that the sum of what is under it
  const sizeOf = (node) => node.own ?? Object.values(node.under).reduce((a, n) => a + sizeOf(n), 0)
  const out = {}
  for (const [name, tree] of Object.entries(processes)) {
    const rows = {}
    for (const [top, node] of Object.entries(tree)) {
      if (sizeOf(node) >= 1 << 20) rows[top] = MB(sizeOf(node))
      // one level down where it says something (which partition, which cache)
      for (const [child, sub] of Object.entries(node.under)) {
        if (sizeOf(sub) >= 4 << 20 && !/^segment_|^[0-9a-f]{16,}$/i.test(child)) rows[`${top}/${child}`] = MB(sizeOf(sub))
      }
    }
    out[name] = Object.fromEntries(Object.entries(rows).sort((x, y) => y[1] - x[1]))
  }
  return out
}

// A timeline trace, boiled down: time per kind of work that matters here, per process
function summariseTrace(events) {
  const process = processNames(events)
  const wanted = /^(ImageDecodeTask|Decode Image|Decode LazyPixelRef|Draw LazyPixelRef|Resize Image|RasterTask|ImageUploadTask|Paint|PrePaint|Layout|UpdateLayoutTree|FunctionCall|EventDispatch|Commit|DrawFrame|DroppedFrame|RunTask|CompositeLayers|Layerize)$/
  const totals = {}
  for (const e of events) {
    if (!wanted.test(e.name) || (e.ph !== 'X' && e.ph !== 'I' && e.ph !== 'i')) continue
    if (e.name === 'RunTask' && (e.dur ?? 0) < 50000) continue
    const key = `${process[e.pid] ?? e.pid} · ${e.name === 'RunTask' ? 'tasks over 50 ms' : e.name}`
    const t = (totals[key] ??= { count: 0, ms: 0, worstMs: 0 })
    t.count++
    t.ms += (e.dur ?? 0) / 1000
    t.worstMs = Math.max(t.worstMs, (e.dur ?? 0) / 1000)
  }
  return Object.fromEntries(
    Object.entries(totals)
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([k, v]) => [k, { count: v.count, ms: Math.round(v.ms), worstMs: Math.round(v.worstMs) }]),
  )
}

// ---- Two result files side by side -----------------------------------------

function compare(fileA, fileB) {
  const [a, b] = [fileA, fileB].map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
  const same = a.invariants.digest === b.invariants.digest
  console.log(`invariants: ${same ? 'IDENTICAL' : 'DIFFERENT'} (${a.invariants.digest.slice(0, 12)} / ${b.invariants.digest.slice(0, 12)})`)
  if (!same) {
    const flat = (r) => [
      ...r.invariants.sent.flatMap((s, i) => [[`request ${i} (round ${s.round}) source`, s.source?.sha256], [`request ${i} (round ${s.round}) guide`, s.guide?.sha256], [`request ${i} (round ${s.round}) prompt`, s.prompt], [`request ${i} (round ${s.round}) answer`, s.answer]]),
      ...r.invariants.stages.map((s) => [`version ${s.round} on the stage`, s.sha256]),
      ['download', r.invariants.download.sha256],
    ]
    const other = new Map(flat(b))
    const differing = flat(a).filter(([k, v]) => other.get(k) !== v).map(([k]) => k)
    console.log(`  first differences: ${differing.slice(0, 6).join(' · ') || '(a different number of requests or versions)'}`)
  }
  const row = (cells) => console.log(cells.map((c, i) => String(c).padEnd(i === 0 ? 32 : 40)).join(''))
  const cell = (s) => (s ? `${s.memory.totalPssMB} (r ${s.memory.byType.renderer?.pssMB ?? 0}, b ${s.memory.byType.browser?.pssMB ?? 0}, g ${s.memory.byType.gpu?.pssMB ?? 0})` : '—')
  console.log('\nmemory, MB of PSS: total (renderer, browser, gpu)')
  row(['', a.meta.tag, b.meta.tag])
  for (const s of a.samples) row([s.label, cell(s), cell(b.samples.find((t) => t.label === s.label))])
  console.log('\ninteractions after the last round, ms: median / worst')
  const pair = (s) => (s && s.n ? `${s.median} / ${s.worst}` : '—')
  const lines = (r) => {
    const e = r.responsiveness.end
    return {
      'typing: key to frame': pair({ n: 1, median: e.typing.toFrameMs.median, worst: e.typing.toFrameMs.worst }),
      'typing: key to paint': pair({ n: 1, median: e.typing.toPaintMs.median, worst: e.typing.toPaintMs.worst }),
      'switch version: decoded': pair(e.switching.decodedMs),
      'switch version: painted': pair(e.switching.paintedMs),
      'thread scroll: frame': pair({ n: 1, median: e.threadScroll.median, worst: e.threadScroll.worst }),
      'thread scroll: dropped frames': e.threadScroll.dropped,
      'close studio: painted': e.close.painted,
      'gallery scroll: frame': pair({ n: 1, median: e.gallery.median, worst: e.gallery.worst }),
      'reopen studio: painted': e.reopen.painted,
      'edit, local work (median)': summary(r.rounds.map((x) => x.timing.localMs)).median,
    }
  }
  const [la, lb] = [lines(a), lines(b)]
  for (const key of Object.keys(la)) row([key, la[key], lb[key]])
}

const options = parseArgs(process.argv.slice(2))
if (options.compare) compare(...options.compare)
else
  run(options).catch((e) => {
    console.error(e)
    process.exit(1)
  })
