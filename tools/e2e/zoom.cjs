// End-to-end check of zooming: the edit studio's stage and the gallery's large
// view, in the built app with the model's answers faked. Buttons, keys, wheel,
// dragging and fingers; that a click on the zoomed stage lands on the picture
// point under the pointer; and that nothing has moved for a picture at fit.
//
//   npm run build:single                      (the page under test)
//   (cd tools/compositor-bench && python sim.py)   (the pictures it uses, once)
//   node tools/e2e/zoom.cjs [--shots[=folder]]
//
// Exits with status 1 if a check fails. --shots saves two screenshots (studio
// zoomed with an arrow, large view zoomed) to tools/e2e/shots/ or the folder given.
//
// "Fit" must be what the app showed before it could zoom. BEFORE holds the
// picture's on-screen box [x, y, width, height] measured on the build just
// before zoom was added (headless Chromium, the same pictures and window
// sizes); each number has to match within 1px. Those numbers depend on the
// fonts of the machine that measured them, so there is a second check that
// does not: the picture has to cover the invisible "sizer" picture, which is
// laid out by the old rules.
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const B = path.join(__dirname, '..', 'compositor-bench', 'cases') + path.sep
const APP = 'file://' + path.join(__dirname, '..', '..', 'nano-banana.html')
const shotsArg = process.argv.find((a) => a === '--shots' || a.startsWith('--shots='))
const SHOTS = shotsArg ? (shotsArg.includes('=') ? path.resolve(shotsArg.split('=')[1]) : path.join(__dirname, 'shots')) : null
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name) }) : null)
const b64 = (c, f) => fs.readFileSync(B + c + '/' + f).toString('base64')
const meta = (c) => JSON.parse(fs.readFileSync(B + c + '/meta.json'))
const image = (data) => JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data } }] }, finishReason: 'STOP' }] })
let pass = 0, fail = 0
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); ok ? pass++ : fail++ }
const near = (a, b, tol) => Math.abs(a - b) <= tol
const r2 = (v) => Math.round(v * 100) / 100

const BEFORE = {
  'C-remove-spoon__mild': {
    '1440x950': { stage: [97, 160.75, 846, 564], large: [270, 175, 900, 600] },
    '820x1100': { stage: [162.6875, 146.5, 494.625, 329.75], large: [24, 292.671875, 771.984375, 514.65625] },
    '1000x600': { stage: [320, 102.5, 360, 240], large: [117.5, 45, 765, 510] },
  },
  'A-4k__mild': {
    '1440x950': { stage: [179.75, 102.5, 680.5, 680.5], large: [316.25, 71.25, 807.5, 807.5] },
    '820x1100': { stage: [245.125, 146.5, 329.75, 329.75], large: [24, 164, 772, 772] },
    '1000x600': { stage: [380, 102.5, 240, 240], large: [245, 45, 510, 510] },
  },
}

const STAGE = '[role=dialog] [data-zoom-pane]'
const LARGE = '.fixed.z-50 [data-zoom-pane]'
// The picture in a pane (the studio's tint overlay is an aria-hidden <img> next to it)
const PIC = ' img:not([aria-hidden])'

// A page with `count` pictures in the gallery; the first image request gets
// the case's original, later ones its "result"
async function open(browser, kase, { viewport = { width: 1440, height: 950 }, count = 2, touch = false } = {}) {
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch })
  const p = await context.newPage()
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  let calls = 0
  await p.route('https://generativelanguage.googleapis.com/**', async (route) => {
    calls++
    await route.fulfill({ contentType: 'application/json', body: image(b64(kase, calls <= count ? 'orig.png' : 'result.png')) })
  })
  await p.goto(APP)
  await p.evaluate((count) => {
    localStorage.clear(); localStorage.setItem('nbr.apiKey', 'g')
    localStorage.setItem('nbr.settings.v1', JSON.stringify({ targetCount: count, prompt: 'x', attemptsCap: 3 })); localStorage.setItem('nbr.capDefault50', '1')
    localStorage.setItem('nbr.promptModules.v1', JSON.stringify({ mode: 'simple', modules: [] }))
  }, count)
  await p.reload()
  await p.click(`button:has-text("Generate ${count} image")`)
  await p.waitForFunction((count) => document.querySelectorAll('main img[alt^="Generated"]').length >= count, count)
  return { p, errors, context }
}
async function openStudio(p, nth = 0) {
  await p.locator('button:has-text("✏️ Edit")').nth(nth).click()
  await p.waitForSelector('[role=dialog] svg')
  await settled(p, STAGE)
}
async function openLarge(p, nth = 0) {
  await p.locator('main img[alt^="Generated"]').nth(nth).click()
  await p.waitForSelector(LARGE + PIC)
  await settled(p, LARGE)
}
// Waits until the picture in a pane has a size and a frame has gone by
async function settled(p, pane) {
  await p.waitForFunction((sel) => { const i = document.querySelector(sel); return i && i.complete && i.getBoundingClientRect().width > 0 }, pane + PIC)
  await frame(p)
}
const frame = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

// Everything the checks read about a pane, in one go
async function view(p, pane) {
  return p.evaluate(({ pane, PIC }) => {
    const el = document.querySelector(pane)
    const img = el.querySelector(PIC.trim())
    const r = img.getBoundingClientRect(), v = el.getBoundingClientRect()
    return {
      x: r.x, y: r.y, w: r.width, h: r.height, nw: img.naturalWidth, nh: img.naturalHeight, src: img.src, tag: img.tagName,
      canvases: el.querySelectorAll('canvas').length,
      pane: { x: v.x, y: v.y, w: el.clientWidth, h: el.clientHeight, left: el.scrollLeft, top: el.scrollTop },
      label: (el.parentElement.querySelector('[role=group][aria-label=Zoom] span') || {}).textContent,
    }
  }, { pane, PIC })
}
// The invisible picture that is laid out by the rules from before zoom
async function sizer(p, root) {
  return p.evaluate((root) => { const r = document.querySelector(root + ' img.invisible').getBoundingClientRect(); return [r.x, r.y, r.width, r.height] }, root)
}
const boxOf = (v) => [v.x, v.y, v.w, v.h]
const sameBox = (a, b, tol = 1) => a.every((n, i) => near(n, b[i], tol))
const fmt = (a) => '[' + a.map(r2).join(', ') + ']'
// Where a picture point (fractions) is on screen
const onScreen = (v, fx, fy) => ({ x: v.x + fx * v.w, y: v.y + fy * v.h })
// … and the picture point under a screen position
const underPointer = (v, x, y) => ({ fx: (x - v.x) / v.w, fy: (y - v.y) / v.h })
const zoomButton = (p, root, label) => p.locator(`${root} [role=group][aria-label=Zoom] button[aria-label^="${label}"]`)
const press = async (p, root, label, times = 1) => { for (let i = 0; i < times; i++) await zoomButton(p, root, label).click(); await frame(p) }

// The arrows on the stage: stored position, where the tip is drawn, how large head and tag are on screen
async function marks(p) {
  return p.evaluate(() => [...document.querySelectorAll('[role=dialog] g[data-mark-x]')].map((g) => {
    const m = g.ownerSVGElement.getScreenCTM()
    const pts = g.querySelector('polygon').getAttribute('points').split(' ').map((s) => s.split(',').map(Number))
    const at = ([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f })
    const [tip, wing] = [at(pts[0]), at(pts[1])]
    const tag = g.querySelector('circle').getBoundingClientRect()
    const stroke = +g.querySelectorAll('line')[1].getAttribute('stroke-width') * m.a
    return { x: +g.dataset.markX, y: +g.dataset.markY, tip, head: Math.hypot(tip.x - wing.x, tip.y - wing.y), tag: tag.width, stroke }
  }))
}

;(async () => {
  const browser = await chromium.launch()

  // ---- 1. At fit nothing has moved: both pictures, three window sizes, studio and large view
  for (const kase of Object.keys(BEFORE)) for (const size of Object.keys(BEFORE[kase])) {
    const [width, height] = size.split('x').map(Number)
    const { p, errors } = await open(browser, kase, { viewport: { width, height } })
    await openLarge(p)
    const large = await view(p, LARGE)
    check(`${kase} ${size}: large view at fit is where it was`, sameBox(boxOf(large), BEFORE[kase][size].large), `${fmt(boxOf(large))} vs ${fmt(BEFORE[kase][size].large)}`)
    check(`${kase} ${size}: large view covers its sizer`, sameBox(boxOf(large), await sizer(p, '.fixed.z-50'), 0.1))
    await p.keyboard.press('Escape')
    await openStudio(p)
    const stage = await view(p, STAGE)
    check(`${kase} ${size}: stage picture at fit is where it was`, sameBox(boxOf(stage), BEFORE[kase][size].stage), `${fmt(boxOf(stage))} vs ${fmt(BEFORE[kase][size].stage)}`)
    check(`${kase} ${size}: stage picture covers its sizer`, sameBox(boxOf(stage), await sizer(p, '[role=dialog]'), 0.1))
    check(`${kase} ${size}: no scrolling at fit`, await p.evaluate((s) => getComputedStyle(document.querySelector(s)).overflow === 'hidden', STAGE))
    check(`${kase} ${size}: no page errors`, errors.length === 0, errors.join(' | '))
    await p.close()
  }

  // ---- 2. The studio's stage, on a 4096×4096 picture (fit is about 17% of its pixels)
  {
    const kase = 'A-4k__mild'
    const { p, errors } = await open(browser, kase)
    await openStudio(p)
    const fit = await view(p, STAGE)
    const dlg = '[role=dialog]'
    check('the level is shown as a share of the picture’s own pixels', fit.label === Math.round((fit.w / fit.nw) * 100) + '%', `${fit.label} for ${r2(fit.w)} of ${fit.nw} px`)
    check('at fit, "Fit" and "−" have nothing to do', (await zoomButton(p, dlg, 'Fit').isDisabled()) && (await zoomButton(p, dlg, 'Zoom out').isDisabled()))
    for (const label of ['Zoom out', 'Zoom in', 'Fit', 'Zoom to 100%']) {
      const b = zoomButton(p, dlg, label)
      check(`"${label}" button has a title`, (await b.count()) === 1 && Boolean(await b.getAttribute('title')))
    }

    // + three times: about the middle, and without leaving an arrow
    await press(p, dlg, 'Zoom in', 3)
    const z3 = await view(p, STAGE)
    check('+ three times zooms in (1.4 a press)', near(z3.w / fit.w, 1.4 ** 3, 0.01), `×${r2(z3.w / fit.w)}`)
    const mid = { x: z3.pane.x + z3.pane.w / 2, y: z3.pane.y + z3.pane.h / 2 }
    const c = onScreen(z3, 0.5, 0.5)
    check('the buttons zoom about the middle of the stage', near(c.x, mid.x, 1) && near(c.y, mid.y, 1), `picture centre at ${r2(c.x)},${r2(c.y)}; stage centre ${r2(mid.x)},${r2(mid.y)}`)
    check('pressing zoom buttons places no arrow', (await marks(p)).length === 0)

    // Dragging the zoomed picture moves it, and leaves no arrow
    await p.mouse.move(mid.x, mid.y)
    await p.mouse.down(); await p.mouse.move(mid.x - 90, mid.y - 60, { steps: 4 }); await p.mouse.up()
    await frame(p)
    const panned = await view(p, STAGE)
    check('dragging the zoomed picture moves it', panned.pane.left - z3.pane.left === 90 && panned.pane.top - z3.pane.top === 60, `by ${panned.pane.left - z3.pane.left},${panned.pane.top - z3.pane.top}`)
    check('… and places no arrow', (await marks(p)).length === 0)

    // A click lands on the picture point under the pointer
    const click = { x: Math.round(mid.x + 137), y: Math.round(mid.y - 91) }
    await p.mouse.click(click.x, click.y)
    await frame(p)
    const zoomedView = await view(p, STAGE)
    let [m] = await marks(p)
    const want = underPointer(zoomedView, click.x, click.y)
    const offPx = m ? Math.hypot((m.x - want.fx) * zoomedView.nw, (m.y - want.fy) * zoomedView.nh) : NaN
    check('zoomed in, a click stores the picture point under the pointer (within 0.5 picture px)', offPx <= 0.5, `${r2(offPx)} picture px off; stored ${m && m.x.toFixed(5)},${m && m.y.toFixed(5)}`)
    check('… and the arrow’s tip is drawn there (within 0.5 screen px)', m && Math.hypot(m.tip.x - click.x, m.tip.y - click.y) <= 0.5, m && `${r2(m.tip.x)},${r2(m.tip.y)} vs ${click.x},${click.y}`)
    await shot(p, 'studio-zoomed.png')
    // Dragging an arrow still moves the arrow — by exactly as far — and not the picture
    await p.mouse.move(click.x, click.y)
    await p.mouse.down(); await p.mouse.move(click.x + 30, click.y + 20, { steps: 4 }); await p.mouse.up()
    await frame(p)
    const afterGrab = await view(p, STAGE)
    const placed = m
    ;[m] = await marks(p)
    check('dragging an arrow moves the arrow, not the zoomed picture', (await marks(p)).length === 1 && afterGrab.pane.left === zoomedView.pane.left && afterGrab.pane.top === zoomedView.pane.top && Math.hypot(m.tip.x - (click.x + 30), m.tip.y - (click.y + 20)) <= 0.5 && m.x !== placed.x, `tip at ${r2(m.tip.x)},${r2(m.tip.y)}`)
    const zoomedMark = m

    // Scrolling moves the picture and the arrow together; a plain wheel does not zoom
    await p.mouse.move(mid.x, mid.y)
    await p.mouse.wheel(60, 80)
    await frame(p)
    const scrolled = await view(p, STAGE)
    ;[m] = await marks(p)
    const tipWant = onScreen(scrolled, m.x, m.y)
    check('a plain wheel scrolls, it does not zoom', near(scrolled.w, zoomedView.w, 0.01) && scrolled.pane.top - zoomedView.pane.top === 80 && scrolled.pane.left - zoomedView.pane.left === 60, `scrolled by ${scrolled.pane.left - zoomedView.pane.left},${scrolled.pane.top - zoomedView.pane.top}`)
    check('the arrow stays on its picture point while scrolling', Math.hypot(m.tip.x - tipWant.x, m.tip.y - tipWant.y) <= 0.5)

    // Ctrl + wheel: the picture point under the pointer stays put
    const pointer = { x: Math.round(mid.x - 203), y: Math.round(mid.y + 118) }
    await p.mouse.move(pointer.x, pointer.y)
    const before = await view(p, STAGE)
    const held = underPointer(before, pointer.x, pointer.y)
    await p.keyboard.down('Control')
    let worst = 0
    for (const dy of [-100, -100, -100, -100, 100, 100, -100]) {
      await p.mouse.wheel(0, dy)
      await frame(p)
      const v = await view(p, STAGE), at = onScreen(v, held.fx, held.fy)
      worst = Math.max(worst, Math.hypot(at.x - pointer.x, at.y - pointer.y))
    }
    await p.keyboard.up('Control')
    const wheeled = await view(p, STAGE)
    check('Ctrl + wheel zooms', wheeled.w > before.w * 1.5, `×${r2(wheeled.w / before.w)}`)
    check('Ctrl + wheel keeps the point under the pointer fixed (within 2px)', worst <= 2, `worst ${r2(worst)}px over 7 steps`)
    ;[m] = await marks(p)
    check('the arrow’s head, tag and line are as large on screen at any zoom', near(m.head, zoomedMark.head, 0.1) && near(m.tag, zoomedMark.tag, 0.1) && near(m.stroke, zoomedMark.stroke, 0.01), `head ${r2(m.head)}, tag ${r2(m.tag)}, line ${r2(m.stroke)}`)
    check('zooming does not move the arrow on the picture', m.x === zoomedMark.x && m.y === zoomedMark.y)

    // 100%: one picture pixel per screen pixel
    await press(p, dlg, 'Zoom to 100%')
    const real = await view(p, STAGE)
    check('"100%" shows one picture pixel per screen pixel', near(real.w, real.nw, 0.5) && near(real.h, real.nh, 0.5) && real.label === '100%', `${r2(real.w)}×${r2(real.h)} on screen for ${real.nw}×${real.nh}, label ${real.label}`)
    check('… and then has nothing more to do', await zoomButton(p, dlg, 'Zoom to 100%').isDisabled())

    // Space + drag and the middle button move the picture, and leave no arrow
    await p.evaluate(() => document.activeElement && document.activeElement.blur())
    await p.mouse.move(mid.x, mid.y)
    const count = (await marks(p)).length
    await p.keyboard.down('Space')
    await p.mouse.down(); await p.mouse.move(mid.x - 120, mid.y - 70, { steps: 4 }); await p.mouse.up()
    await p.keyboard.up('Space')
    await frame(p)
    const dragged = await view(p, STAGE)
    check('Space + drag moves the picture', dragged.pane.left - real.pane.left === 120 && dragged.pane.top - real.pane.top === 70, `by ${dragged.pane.left - real.pane.left},${dragged.pane.top - real.pane.top}`)
    await p.mouse.move(mid.x, mid.y)
    await p.mouse.down({ button: 'middle' }); await p.mouse.move(mid.x + 50, mid.y + 30, { steps: 4 }); await p.mouse.up({ button: 'middle' })
    await frame(p)
    const middled = await view(p, STAGE)
    check('dragging with the middle button moves the picture', middled.pane.left - dragged.pane.left === -50 && middled.pane.top - dragged.pane.top === -30, `by ${middled.pane.left - dragged.pane.left},${middled.pane.top - dragged.pane.top}`)
    check('neither leaves an arrow', (await marks(p)).length === count)
    // … and with Space let go, a press places arrows again
    await p.mouse.click(mid.x + 40, mid.y + 40)
    await frame(p)
    check('after Space is released a click places an arrow again', (await marks(p)).length === count + 1)

    // Fit: back to exactly the fitted box, arrows still on their points and still the same size
    await press(p, dlg, 'Fit')
    const again = await view(p, STAGE)
    check('"Fit" goes back to the fitted picture', sameBox(boxOf(again), boxOf(fit), 0.01) && again.label === fit.label, fmt(boxOf(again)))
    ;[m] = await marks(p)
    const fitTip = onScreen(again, m.x, m.y)
    check('at fit the arrow is on the same picture point', Math.hypot(m.tip.x - fitTip.x, m.tip.y - fitTip.y) <= 0.5)
    const unit = Math.min(again.w, again.h)
    check('arrow sizes go by the fitted picture, zoomed or not', near(m.head, zoomedMark.head, 0.1) && near(m.tag, zoomedMark.tag, 0.1) && near(m.head, Math.max(10, unit * 0.035), 0.1), `head ${r2(m.head)} / ${r2(zoomedMark.head)}, tag ${r2(m.tag)} / ${r2(zoomedMark.tag)}`)

    // Display only: the same <img> with the same source
    check('zooming never changed the picture element’s source', again.src === fit.src && real.src === fit.src && wheeled.src === fit.src && again.tag === 'IMG' && again.canvases === 0)

    // Typing + − 0 = in a text field is typing
    const typeInto = async (locator, name) => {
      await locator.click()
      await p.keyboard.type('+0-=')
      await frame(p)
      const v = await view(p, STAGE)
      check(`typing + 0 − = in ${name} does not zoom`, near(v.w, again.w, 0.01) && (await locator.inputValue()).includes('+0-='), await locator.inputValue())
    }
    await typeInto(p.locator('[role=dialog] textarea').last(), 'the instruction box')
    await typeInto(p.locator('[role=dialog] input[type=text], [role=dialog] input:not([type])').first(), 'an arrow’s instruction')

    // … and outside one, the keys zoom
    await p.evaluate(() => document.activeElement && document.activeElement.blur())
    await p.keyboard.press('+'); await p.keyboard.press('='); await frame(p)
    const keyed = await view(p, STAGE)
    await p.keyboard.press('-'); await frame(p)
    const keyedOut = await view(p, STAGE)
    await p.keyboard.press('0'); await frame(p)
    const keyedFit = await view(p, STAGE)
    check('+ and = zoom in, − zooms out, 0 fits (focus not in a text field)', near(keyed.w / fit.w, 1.96, 0.01) && near(keyedOut.w / fit.w, 1.4, 0.01) && near(keyedFit.w, fit.w, 0.01), `×${r2(keyed.w / fit.w)}, ×${r2(keyedOut.w / fit.w)}, ×${r2(keyedFit.w / fit.w)}`)

    // The zoom limit: at least 8× fit and 4× the picture's own pixels
    for (let i = 0; i < 30 && !(await zoomButton(p, dlg, 'Zoom in').isDisabled()); i++) await press(p, dlg, 'Zoom in')
    const most = await view(p, STAGE)
    check('zooms to at least 8× fit and 4× real size', most.w >= fit.w * 8 - 1 && most.w >= most.nw * 4 - 1 && (await zoomButton(p, dlg, 'Zoom in').isDisabled()), `${r2(most.w / fit.w)}× fit, ${r2(most.w / most.nw)}× real`)
    await press(p, dlg, 'Fit')

    // Esc still closes the studio (focus not in a text field)
    await p.keyboard.press('Escape')
    check('Esc still closes the studio', (await p.locator('[role=dialog]').count()) === 0)
    // Another chain starts at fit
    await openStudio(p, 0); await press(p, dlg, 'Zoom in', 2)
    await p.keyboard.press('Escape')
    await openStudio(p, 1)
    const other = await view(p, STAGE)
    check('another picture’s studio starts at fit', sameBox(boxOf(other), boxOf(fit), 0.01))
    check('no page errors in the studio', errors.length === 0, errors.join(' | '))
    await p.close()
  }

  // ---- 3. Versions of one picture keep the zoom and the spot (to compare before / after)
  {
    const kase = 'C-remove-spoon__mild', spot = meta(kase).marks[0]
    const { p, errors } = await open(browser, kase, { count: 1 })
    await openStudio(p)
    const dlg = '[role=dialog]'
    const fit = await view(p, STAGE)
    // (at fit a press places its arrow at once, as it always has — before it is let go)
    await p.mouse.move(fit.x + fit.w * spot.x, fit.y + fit.h * spot.y)
    await p.mouse.down(); await frame(p)
    check('at fit, the arrow is there as soon as the button goes down', (await marks(p)).length === 1)
    await p.mouse.up()
    await p.keyboard.type('remove this')
    await p.click('[role=dialog] button:has-text("Apply edit")')
    await p.waitForFunction(() => /Done in|Done on|Gave up|went wrong|Stopped/.test(document.querySelector('[role=dialog]').innerText), null, { timeout: 90000 })
    await settled(p, STAGE)
    await press(p, dlg, 'Zoom in', 4)
    await p.evaluate((s) => { const el = document.querySelector(s); el.scrollLeft = 700; el.scrollTop = 400 }, STAGE)
    await frame(p)
    const v1 = await view(p, STAGE)
    await p.locator('[role=dialog] section img[alt="Original"]').last().click()
    await frame(p); await settled(p, STAGE)
    const v0 = await view(p, STAGE)
    check('showing another version changes the picture …', v0.src !== v1.src)
    check('… and keeps the zoom and the spot', near(v0.w, v1.w, 0.01) && v0.pane.left === v1.pane.left && v0.pane.top === v1.pane.top && v1.pane.left > 0 && v1.pane.top > 0, `×${r2(v0.w / fit.w)} at ${v0.pane.left},${v0.pane.top}`)
    await p.locator('[role=dialog] section img[alt="Version 1"]').last().click()
    await frame(p); await settled(p, STAGE)
    const hold = p.locator('[role=dialog] button:has-text("Hold to compare")')
    const hb = await hold.boundingBox()
    await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await p.mouse.down(); await frame(p)
    const peek = await view(p, STAGE)
    await p.mouse.up(); await frame(p)
    const back = await view(p, STAGE)
    check('"Hold to compare" shows the picture before at the same zoom and spot', peek.src === v0.src && back.src === v1.src && near(peek.w, v1.w, 0.01) && peek.pane.left === v1.pane.left && peek.pane.top === v1.pane.top, `×${r2(peek.w / fit.w)} at ${peek.pane.left},${peek.pane.top}`)
    check('no page errors while comparing', errors.length === 0, errors.join(' | '))
    await p.close()
  }

  // ---- 4. Fingers: two pinch (and leave no arrow), one taps an arrow in
  {
    const { p, errors, context } = await open(browser, 'A-4k__mild', { touch: true, viewport: { width: 1100, height: 800 } })
    await openStudio(p)
    const dlg = '[role=dialog]'
    const coarse = await p.evaluate(() => matchMedia('(pointer: coarse)').matches)
    const sizes = await p.evaluate(() => [...document.querySelectorAll('[role=dialog] [role=group][aria-label=Zoom] button')].map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height) }))
    check('on a touch screen the zoom buttons are at least 40px', coarse && sizes.length === 4 && Math.min(...sizes) >= 40, `coarse pointer: ${coarse}; ${sizes.map(r2).join(', ')}`)
    const fit = await view(p, STAGE)
    const cdp = await context.newCDPSession(p)
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
    const cx = Math.round(fit.x + fit.w * 0.4), cy = Math.round(fit.y + fit.h * 0.6)
    const held = underPointer(fit, cx, cy)
    await touch('touchStart', [[cx - 40, cy]])
    await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]])
    for (const d of [60, 80, 100, 120]) { await touch('touchMove', [[cx - d, cy], [cx + d, cy]]); await frame(p) }
    const pinched = await view(p, STAGE)
    const at = onScreen(pinched, held.fx, held.fy)
    check('two fingers spreading zoom in', near(pinched.w / fit.w, 3, 0.05), `×${r2(pinched.w / fit.w)}`)
    check('… about the point between them (within 2px)', Math.hypot(at.x - cx, at.y - cy) <= 2, `${r2(Math.hypot(at.x - cx, at.y - cy))}px off`)
    // both fingers move together: the picture follows
    for (const s of [10, 20, 30]) { await touch('touchMove', [[cx - 120 - s, cy - s], [cx + 120 - s, cy - s]]); await frame(p) }
    const moved = await view(p, STAGE)
    const at2 = onScreen(moved, held.fx, held.fy)
    check('two fingers moving together drag the picture', Math.hypot(at2.x - (cx - 30), at2.y - (cy - 30)) <= 2 && near(moved.w, pinched.w, 0.5), `${r2(at2.x - at.x)},${r2(at2.y - at.y)}`)
    await touch('touchEnd', [[cx - 150, cy - 30]])
    await touch('touchEnd', [])
    await frame(p)
    check('a pinch leaves no arrow', (await marks(p)).length === 0)
    // one finger dragging: the picture follows, and still no arrow
    const px = Math.round(moved.pane.x + moved.pane.w / 2), py = Math.round(moved.pane.y + moved.pane.h / 2)
    await touch('touchStart', [[px, py]])
    for (const s of [10, 20, 30, 40]) { await touch('touchMove', [[px - s, py - s / 2]]); await frame(p) }
    await touch('touchEnd', [])
    await frame(p)
    const swiped = await view(p, STAGE)
    check('one finger drags the zoomed picture, and leaves no arrow', swiped.pane.left - moved.pane.left === 40 && swiped.pane.top - moved.pane.top === 20 && (await marks(p)).length === 0, `by ${swiped.pane.left - moved.pane.left},${swiped.pane.top - moved.pane.top}`)
    // one finger: an arrow where it touched, and the cursor in its row
    const tap = { x: Math.round(moved.pane.x + moved.pane.w / 2 + 33), y: Math.round(moved.pane.y + moved.pane.h / 2 - 21) }
    await touch('touchStart', [[tap.x, tap.y]])
    await touch('touchEnd', [])
    await frame(p)
    const tapped = await view(p, STAGE)
    const [m] = await marks(p)
    const want = underPointer(tapped, tap.x, tap.y)
    const off = m ? Math.hypot((m.x - want.fx) * tapped.nw, (m.y - want.fy) * tapped.nh) : NaN
    check('one finger taps an arrow onto the point it touched (within 0.5 picture px)', off <= 0.5, `${r2(off)} picture px off`)
    check('… and the cursor is in that arrow’s instruction', await p.evaluate(() => document.activeElement instanceof HTMLInputElement && Boolean(document.activeElement.closest('[role=dialog]'))))
    check('no page errors with touch', errors.length === 0, errors.join(' | '))
    await p.close()
  }

  // ---- 5. The gallery's large view
  {
    const { p, errors } = await open(browser, 'A-4k__mild')
    await openLarge(p)
    const root = '.fixed.z-50'
    const fit = await view(p, LARGE)
    const counter = () => p.locator(`${root} span:has-text("×")`).first().innerText()
    await press(p, root, 'Zoom in')
    const one = await view(p, LARGE)
    const c = onScreen(one, 0.5, 0.5)
    check('large view: + zooms in about the middle', near(one.w / fit.w, 1.4, 0.01) && near(c.x, 720, 1) && near(c.y, 475, 1), `×${r2(one.w / fit.w)}, centre ${r2(c.x)},${r2(c.y)}`)
    check('large view: the zoom buttons do not close it', (await p.locator(LARGE).count()) === 1)
    await press(p, root, 'Zoom out')
    const out = await view(p, LARGE)
    check('large view: − zooms back out', sameBox(boxOf(out), boxOf(fit), 0.01))
    await press(p, root, 'Zoom to 100%')
    const real = await view(p, LARGE)
    check('large view: "100%" shows one picture pixel per screen pixel', near(real.w, real.nw, 0.5) && real.label === '100%', `${r2(real.w)} for ${real.nw}`)
    // zoomed, the picture has the whole window; the buttons are still on screen and on top
    const reachable = await p.evaluate((root) => ['Previous picture', 'Next picture', 'Download', '✕', 'Fit'].map((name) => {
      const b = [...document.querySelectorAll(root + ' button')].find((b) => b.getAttribute('aria-label')?.startsWith(name) || b.textContent.trim() === name)
      if (!b) return name + ': absent'
      const r = b.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return name + ': ' + (r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && (top === b || b.contains(top)) ? 'ok' : 'covered or off screen')
    }), root)
    check('large view, zoomed: next, download, close and the zoom buttons stay reachable', reachable.filter((s) => s.endsWith('ok')).length === 4 && reachable[0] === 'Previous picture: absent', reachable.join('; '))
    check('large view, zoomed: the picture uses the whole window', real.pane.w >= 1440 - 16 && real.pane.h >= 950 - 16, `${real.pane.w}×${real.pane.h}`)
    // dragging moves it, and the click that ends the drag closes nothing
    await p.mouse.move(700, 500)
    await p.mouse.down(); await p.mouse.move(500, 350, { steps: 5 }); await p.mouse.up()
    await frame(p)
    const dragged = await view(p, LARGE)
    check('large view: dragging moves the zoomed picture', dragged.pane.left - real.pane.left === 200 && dragged.pane.top - real.pane.top === 150, `by ${dragged.pane.left - real.pane.left},${dragged.pane.top - real.pane.top}`)
    check('large view: … and does not close it', (await p.locator(LARGE).count()) === 1)
    await shot(p, 'large-view-zoomed.png')
    await press(p, root, 'Fit')
    const fitted = await view(p, LARGE)
    check('large view: "Fit" goes back to the fitted picture', sameBox(boxOf(fitted), boxOf(fit), 0.01))
    // double click: real size about the pointer, and back
    const dbl = { x: Math.round(fit.x + fit.w * 0.3), y: Math.round(fit.y + fit.h * 0.7) }
    const held = underPointer(fitted, dbl.x, dbl.y)
    await p.mouse.dblclick(dbl.x, dbl.y); await frame(p)
    const twice = await view(p, LARGE)
    const at = onScreen(twice, held.fx, held.fy)
    check('large view: a double click goes to real size, about the pointer', near(twice.w, twice.nw, 0.5) && Math.hypot(at.x - dbl.x, at.y - dbl.y) <= 2, `${r2(twice.w)} px wide, ${r2(Math.hypot(at.x - dbl.x, at.y - dbl.y))}px off`)
    // Ctrl + wheel about the pointer (while the picture is larger than the window)
    await p.keyboard.down('Control')
    let worst = 0
    for (const dy of [100, 100, -100, -100, -100]) {
      await p.mouse.wheel(0, dy); await frame(p)
      const v = await view(p, LARGE), q = onScreen(v, held.fx, held.fy)
      worst = Math.max(worst, Math.hypot(q.x - dbl.x, q.y - dbl.y))
    }
    await p.keyboard.up('Control')
    const wheeled = await view(p, LARGE)
    check('large view: Ctrl + wheel zooms about the pointer (within 2px)', near(wheeled.w / twice.w, Math.exp(0.25), 0.01) && worst <= 2, `×${r2(wheeled.w / twice.w)}, worst ${r2(worst)}px`)
    await p.mouse.dblclick(dbl.x, dbl.y); await frame(p)
    check('large view: a second double click goes back to fit', sameBox(boxOf(await view(p, LARGE)), boxOf(fit), 0.01))
    // a picture narrower than the window stays in the middle of it, whatever it is zoomed about
    await p.keyboard.down('Control'); await p.mouse.wheel(0, -100); await p.keyboard.up('Control'); await frame(p)
    const little = await view(p, LARGE)
    check('large view: zoomed a little, the picture stays centred while it is narrower than the window', little.w > fit.w * 1.2 && little.w < 1440 && near(little.x + little.w / 2, 720, 1), `${r2(little.w)} px wide, centre ${r2(little.x + little.w / 2)}`)
    await press(p, root, 'Fit')
    check('large view: zooming never changed the picture element’s source', wheeled.src === fit.src && real.src === fit.src && wheeled.tag === 'IMG' && wheeled.canvases === 0)
    // next picture: back to fit; arrow keys and Esc as before
    await p.locator(`${root} button[aria-label="Next picture"]`).click()
    await settled(p, LARGE)
    const next = await view(p, LARGE)
    check('large view: the next picture starts at fit', (await counter()).startsWith('2/2') && sameBox(boxOf(next), boxOf(fit), 0.01) && next.src !== fit.src, `${await counter()} ${fmt(boxOf(next))}`)
    await p.keyboard.press('+'); await frame(p)
    const keyed = await view(p, LARGE)
    await p.keyboard.press('ArrowLeft'); await settled(p, LARGE)
    const prev = await view(p, LARGE)
    check('large view: + zooms, ← still goes to the previous picture, at fit', near(keyed.w / fit.w, 1.4, 0.01) && (await counter()).startsWith('1/2') && sameBox(boxOf(prev), boxOf(fit), 0.01), `×${r2(keyed.w / fit.w)}, ${await counter()}`)
    await p.keyboard.press('='); await p.keyboard.press('-'); await p.keyboard.press('-'); await p.keyboard.press('+'); await p.keyboard.press('0'); await frame(p)
    check('large view: 0 fits', sameBox(boxOf(await view(p, LARGE)), boxOf(fit), 0.01))
    await p.keyboard.press('ArrowRight'); await settled(p, LARGE)
    check('large view: → still goes to the next picture', (await counter()).startsWith('2/2'))
    await p.keyboard.press('Escape')
    check('large view: Esc still closes it', (await p.locator(LARGE).count()) === 0)
    await openLarge(p)
    await p.mouse.click(8, 8)
    check('large view: a click beside the fitted picture still closes it', (await p.locator(LARGE).count()) === 0)
    check('no page errors in the large view', errors.length === 0, errors.join(' | '))
    await p.close()
  }

  await browser.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
