// End-to-end check of the edit studio's "only around arrows" extras, in the
// built app with the model's answers faked: touch-ups (take / put back, no
// request) and "find the object".
//
//   npm run build:single                      (the page under test)
//   (cd tools/compositor-bench && python sim.py)   (the pictures it uses, once)
//   node tools/e2e/studio-touchup.cjs [--shots]
//
// Exits with status 1 if a check fails. --shots saves screenshots to tools/e2e/shots/.
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const B = path.join(__dirname, '..', 'compositor-bench', 'cases') + path.sep
const APP = 'file://' + path.join(__dirname, '..', '..', 'nano-banana.html')
const SHOTS = process.argv.includes('--shots') ? path.join(__dirname, 'shots') : null
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name) }) : null)
const read = (c, f) => fs.readFileSync(B + c + '/' + f)
const b64 = (c, f) => read(c, f).toString('base64')
const meta = (c) => JSON.parse(read(c, 'meta.json'))
const image = (data) => JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data } }] }, finishReason: 'STOP' }] })
const text = (t) => JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: 'STOP' }] })
let pass = 0, fail = 0
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); ok ? pass++ : fail++ }

async function open(browser, kase, { locator, oldWayOnly } = {}) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  const calls = { image: 0, locate: 0, locateOld: 0, locateBodies: [], oldBodies: [] }
  await p.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const url = route.request().url()
    // "Find the object" asks through the Interactions API first, and the older
    // generateContent way if that fails
    const body = route.request().postDataJSON()
    if (/\/interactions$/.test(url)) {
      calls.locate++
      calls.locateBodies.push(body)
      if (locator === 'error' || oldWayOnly)
        return route.fulfill({ status: oldWayOnly ? 404 : 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 500, message: 'backend unavailable' } }) })
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'i1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: locator }] }] }) })
    }
    if (/gemini-4-hydrogen|gemini-4-carbon/.test(url)) {
      calls.locateOld++
      calls.oldBodies.push(body)
      if (locator === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 500, message: 'backend unavailable' } }) })
      return route.fulfill({ contentType: 'application/json', body: text(locator) })
    }
    calls.image++
    await route.fulfill({ contentType: 'application/json', body: image(calls.image === 1 ? b64(kase, 'orig.png') : b64(kase, 'result.png')) })
  })
  await p.goto(APP)
  await p.evaluate(() => {
    localStorage.clear(); localStorage.setItem('nbr.apiKey', 'g')
    localStorage.setItem('nbr.settings.v1', JSON.stringify({ targetCount: 1, prompt: 'x', attemptsCap: 3 })); localStorage.setItem('nbr.capDefault50', '1')
    localStorage.setItem('nbr.promptModules.v1', JSON.stringify({ mode: 'simple', modules: [] }))
  })
  await p.reload()
  await p.click('button:has-text("Generate 1 image")'); await p.waitForSelector('main img[alt^="Generated"]')
  await p.locator('button:has-text("✏️ Edit")').first().click(); await p.waitForSelector('[role=dialog] svg')
  return { p, calls, errors }
}
const stage = (p) => p.locator('[role=dialog] svg.touch-none').first().boundingBox()
async function clickAt(p, x, y) { const box = await stage(p); await p.mouse.click(box.x + box.width * x, box.y + box.height * y) }
async function arrowAndApply(p, m) {
  await clickAt(p, m.x, m.y)
  await p.keyboard.type('remove this')
  await p.click('[role=dialog] button:has-text("Apply edit")')
  await p.waitForFunction(() => /Done in|Done on|Gave up|went wrong|Stopped/.test(document.querySelector('[role=dialog]').innerText), null, { timeout: 90000 })
  return p.evaluate(() => document.querySelector('[role=dialog]').innerText)
}
// Pixels of two versions (by alt text), compared
async function diff(p, a, b, discs = []) {
  return p.evaluate(async ({ a, b, discs }) => {
    const imgs = [...document.querySelectorAll('[role=dialog] section img')]
    const load = async (alt) => createImageBitmap(await (await fetch(((i) => i.dataset.full || i.src)(imgs.find((i) => i.alt === alt)))).blob())
    const [A, C] = [await load(a), await load(b)]
    const px = (bm) => { const cv = new OffscreenCanvas(bm.width, bm.height); const x = cv.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height).data }
    const pa = px(A), pc = px(C), W = A.width, H = A.height, unit = Math.min(W, H)
    let changed = 0, outside = 0
    const inDisc = discs.map(() => ({ total: 0, changed: 0 }))
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const d = pa[i] !== pc[i] || pa[i + 1] !== pc[i + 1] || pa[i + 2] !== pc[i + 2]
      if (d) changed++
      let near = false
      discs.forEach((t, k) => {
        const r = Math.hypot(x - t.x * W, y - t.y * H) / unit
        if (r <= t.r) { inDisc[k].total++; if (d) inDisc[k].changed++ }
        if (r <= t.r + 0.07) near = true
      })
      if (d && !near) outside++
    }
    return { size: [W, H], changed, changedPct: +(100 * changed / (W * H)).toFixed(2), outside, inDisc }
  }, { a, b, discs })
}

// Pixels that were still the original's in `before` and are not in `after`, away from the spots
async function disturbed(p, before, after, discs) {
  return p.evaluate(async ({ before, after, discs }) => {
    const imgs = [...document.querySelectorAll('[role=dialog] section img')]
    const load = async (alt) => createImageBitmap(await (await fetch(((i) => i.dataset.full || i.src)(imgs.find((i) => i.alt === alt)))).blob())
    const [O, A, C] = [await load('Original'), await load(before), await load(after)]
    const px = (bm) => { const cv = new OffscreenCanvas(bm.width, bm.height); const x = cv.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height).data }
    const po = px(O), pa = px(A), pc = px(C), W = O.width, H = O.height, unit = Math.min(W, H)
    const same = (u, v, i) => u[i] === v[i] && u[i + 1] === v[i + 1] && u[i + 2] === v[i + 2]
    let count = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (!same(po, pa, i) || same(po, pc, i)) continue
      if (discs.some((t) => Math.hypot(x - t.x * W, y - t.y * H) / unit <= t.r + 0.07)) continue
      count++
    }
    return count
  }, { before, after, discs })
}

;(async () => {
  const browser = await chromium.launch()

  // ---- 1. Touch-ups: the spoon's handle is left behind; three clicks take it
  {
    const kase = 'C-remove-spoon__mild', m = meta(kase)
    const { p, calls, errors } = await open(browser, kase)
    const txt = await arrowAndApply(p, m.marks[0])
    check('spoon edit done', /Done/.test(txt), (txt.match(/Done[^\n]*/) || [''])[0])
    const callsBefore = calls.image
    await p.click('[role=dialog] button:has-text("Touch up")')
    await p.waitForSelector('[role=dialog] button:has-text("Take from the model")')
    // the handle: native (394,200) (402,140) (408,90) on a 600x400 photo
    const spots = [[394, 200], [402, 140], [408, 90]].map(([x, y]) => ({ x: x / 600, y: y / 400, r: 0.07 }))
    for (const s of spots) await clickAt(p, s.x, s.y)
    await shot(p, '1-touch-take.png')
    const applyLabel = await p.locator('[role=dialog] button:has-text("no new request")').innerText()
    check('apply button counts the spots', /Apply 3/.test(applyLabel), applyLabel)
    await p.click('[role=dialog] button:has-text("no new request")')
    await p.waitForFunction(() => [...document.querySelectorAll('[role=dialog] section img')].some((i) => i.alt === 'Version 2'), null, { timeout: 60000 })
    check('no request was made for the touch-up', calls.image === callsBefore, `image calls ${callsBefore} → ${calls.image}`)
    const moved = await disturbed(p, 'Version 1', 'Version 2', spots)
    check('next to nothing that was still the original is touched away from the spots (the seam may settle a few px differently)', moved < 300, moved + ' px')
    const d02 = await diff(p, 'Original', 'Version 2', spots)
    check('the spots are now taken from the model', d02.inDisc.every((k) => k.changed > 0.5 * k.total), JSON.stringify(d02.inDisc))
    check('touch-up mode ended and version 2 is on screen', (await p.locator('[role=dialog] span.absolute.left-3').innerText()) === 'Version 2')
    check('the touched-up version can be touched up again, and its whole picture used', !(await p.locator('[role=dialog] button:has-text("Touch up")').isDisabled()) && !(await p.locator('[role=dialog] button:has-text("Use whole picture")').isDisabled()))

    // put the original back at the spoon's bowl (the arrow itself)
    await p.click('[role=dialog] button:has-text("Touch up")')
    await p.click('[role=dialog] button:has-text("Put the original back")')
    await p.click('[role=dialog] button:text-is("S")')
    const back = { x: m.marks[0].x, y: m.marks[0].y, r: 0.035 }
    await clickAt(p, back.x, back.y)
    await shot(p, '2-touch-back.png')
    await p.click('[role=dialog] button:has-text("no new request")')
    await p.waitForFunction(() => [...document.querySelectorAll('[role=dialog] section img')].some((i) => i.alt === 'Version 3'), null, { timeout: 60000 })
    const d03 = await diff(p, 'Original', 'Version 3', [back])
    check('inside the put-back spot the picture is the original again', d03.inDisc[0].changed === 0, JSON.stringify(d03.inDisc))
    const moved3 = await disturbed(p, 'Version 2', 'Version 3', [back])
    check('putting back touches next to nothing that was still the original elsewhere', moved3 < 300, moved3 + ' px')
    check('still no request', calls.image === callsBefore)
    const gallery = await p.locator('main img[alt^="Generated"], main img').count()
    console.log('     gallery pictures:', gallery, '| errors:', errors)
    check('no page errors', errors.length === 0, errors.join(' | '))
    await p.close()
  }

  // ---- 2. Find the object: a thing that looks like what is behind it is only
  // taken as far as its clear change goes without it
  const kase = 'S-arm-thin-line__mild', m = meta(kase)
  // where the thing is, as Gemini would say it: [ymin, xmin, ymax, xmax] on 0-1000
  const where = meta('S-arm-thin-line-found__mild').options.extents[0].box
  const box2d = [where.y0, where.x0, where.y1, where.x1].map((v) => Math.round(v * 1000))
  let partial = 0
  {
    const { p, calls, errors } = await open(browser, kase)
    const txt = await arrowAndApply(p, m.marks[0])
    partial = (await diff(p, 'Original', 'Version 1')).changedPct
    check('without "find the object" only part of the thing is taken', /Done/.test(txt) && partial < 3, partial + '% of the picture')
    check('no locator request when the switch is off', calls.locate === 0 && calls.locateOld === 0)
    check('no page errors', errors.length === 0, errors.join(' | '))
    await p.close()
  }
  {
    // the box of the limb (from the ground truth), as Gemini would give it: [ymin,xmin,ymax,xmax] 0-1000
    const located = JSON.stringify({ objects: [{ arrow: 1, label: 'left arm', box_2d: box2d }], faces: [{ box_2d: [110, 340, 360, 540] }] })
    const { p, calls, errors } = await open(browser, kase, { locator: '```json\n' + located + '\n```' })
    await clickAt(p, m.marks[0].x, m.marks[0].y)
    await p.keyboard.type('remove this')
    const box = p.locator('[role=dialog] label:has-text("find the object") input')
    check('"find the object" is off to begin with', !(await box.isChecked()))
    await box.check()
    // The model is picked from a menu that always offers every model (as a
    // text field with suggestions it only offered what matched the text in
    // it: after picking one model the others could not be reached)
    const menu = p.locator('[role=dialog] select[aria-label="Gemini model that finds the object"]')
    const offered = () => menu.locator('option').allTextContents()
    check('the model menu shows the default and offers every model', (await menu.inputValue()) === 'gemini-4-hydrogen' && (await offered()).join('|') === 'gemini-4-hydrogen (default)|gemini-4-carbon|Other model…', (await offered()).join('|'))
    await menu.selectOption('gemini-4-carbon')
    check('with another model picked, the menu still offers them all', (await menu.inputValue()) === 'gemini-4-carbon' && (await offered()).join('|') === 'gemini-4-hydrogen (default)|gemini-4-carbon|Other model…', (await offered()).join('|'))
    await menu.selectOption({ label: 'Other model…' })
    const typed = p.locator('[role=dialog] input[aria-label="Gemini model that finds the object (typed)"]')
    await typed.fill('my-own-model')
    await p.click('[role=dialog] button[aria-label="Back to the list of models"]')
    check('a model ID can be typed, and stays on offer next to the others', (await menu.inputValue()) === 'my-own-model' && (await offered()).join('|') === 'gemini-4-hydrogen (default)|gemini-4-carbon|my-own-model|Other model…', (await offered()).join('|'))
    await menu.selectOption('gemini-4-hydrogen')
    check('and the first model can be gone back to', (await menu.inputValue()) === 'gemini-4-hydrogen' && /"locatorModel":"gemini-4-hydrogen"/.test(await p.evaluate(() => localStorage.getItem('nbr.studio.v1')) || ''))
    await shot(p, '3-find-switch.png')
    await p.click('[role=dialog] button:has-text("Apply edit")')
    await p.waitForFunction(() => /Done in|Done on|Gave up|went wrong|Stopped/.test(document.querySelector('[role=dialog]').innerText), null, { timeout: 90000 })
    const txt = await p.evaluate(() => document.querySelector('[role=dialog]').innerText)
    check('with it the edit is done', /Done/.test(txt), (txt.match(/Done[^\n]*|Gave up[^\n]*/) || [''])[0].slice(0, 80))
    const sent = calls.locateBodies[0] || {}
    check('one locator request (Interactions API), with two pictures and the instruction', calls.locate === 1 && calls.locateOld === 0 && sent.model === 'gemini-4-hydrogen' && sent.input.filter((x) => x.type === 'image').length === 2 && /remove this/.test(JSON.stringify(sent.input)), `calls ${calls.locate}+${calls.locateOld}, model ${sent.model}`)
    check('the default model is left at its own thinking level', sent.generation_config === undefined)
    check('the pictures are not stored on Google’s side', sent.store === false)
    check('the note says what was found', /Found: left arm \(1\) · 1 face guarded/.test(txt), (txt.match(/Found:[^\n]*/) || ['(none)'])[0])
    const d = await diff(p, 'Original', 'Version 1')
    check('all of the thing is taken', d.changedPct > 4 && d.changedPct > 1.5 * partial, `${d.changedPct}% of the picture (${partial}% without)`)
    // the guarded face: [110,340,360,540] on 0-1000 of a 1024 px picture
    const face = await p.evaluate(async () => {
      const imgs = [...document.querySelectorAll('[role=dialog] section img')]
      const load = async (alt) => createImageBitmap(await (await fetch(((i) => i.dataset.full || i.src)(imgs.find((i) => i.alt === alt)))).blob())
      const [A, C] = [await load('Original'), await load('Version 1')]
      const px = (bm) => { const cv = new OffscreenCanvas(bm.width, bm.height); const x = cv.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height).data }
      const pa = px(A), pc = px(C), W = A.width, H = A.height
      let changed = 0
      for (let y = Math.round(0.11 * H); y < Math.round(0.36 * H); y++) for (let x = Math.round(0.34 * W); x < Math.round(0.54 * W); x++) {
        const i = (y * W + x) * 4
        if (pa[i] !== pc[i] || pa[i + 1] !== pc[i + 1] || pa[i + 2] !== pc[i + 2]) changed++
      }
      return changed
    })
    check('the guarded face is the original, pixel for pixel', face === 0, face + ' px changed')
    // hold "what changed": boxes are drawn
    const btn = p.locator('[role=dialog] button:has-text("Hold: what changed")'); const bb = await btn.boundingBox()
    await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await p.mouse.down()
    const labels = await p.evaluate(() => [...document.querySelectorAll('[role=dialog] svg[aria-hidden] text')].map((t) => t.textContent))
    await shot(p, '4-found-boxes.png')
    await p.mouse.up()
    check('the found boxes are shown', labels.includes('left arm') && labels.includes('face — guarded'), JSON.stringify(labels))
    const stored = await p.evaluate(() => localStorage.getItem('nbr.studio.v1'))
    check('the switch is remembered', /"findObject":true/.test(stored || ''), stored)
    check('no page errors', errors.length === 0, errors.join(' | '))
    await p.close()
  }
  {
    // a model only served the older way, and a model picked from the menu
    const located = JSON.stringify({ objects: [{ arrow: 1, label: 'arm', box_2d: box2d }], faces: [] })
    const { p, calls, errors } = await open(browser, kase, { locator: 'Here you go: ' + located, oldWayOnly: true })
    await clickAt(p, m.marks[0].x, m.marks[0].y)
    await p.keyboard.type('remove this')
    await p.locator('[role=dialog] label:has-text("find the object") input').check()
    await p.selectOption('[role=dialog] select[aria-label="Gemini model that finds the object"]', 'gemini-4-carbon')
    await p.click('[role=dialog] button:has-text("Apply edit")')
    await p.waitForFunction(() => /Done in|Done on|Gave up|went wrong|Stopped/.test(document.querySelector('[role=dialog]').innerText), null, { timeout: 90000 })
    const txt = await p.evaluate(() => document.querySelector('[role=dialog]').innerText)
    check('falls back to the older request when the Interactions API refuses, with the typed model', /Done/.test(txt) && calls.locate === 1 && calls.locateOld === 1 && calls.locateBodies[0].model === 'gemini-4-carbon' && /Found: arm \(1\)/.test(txt), `calls ${calls.locate}+${calls.locateOld}, ${(txt.match(/Found:[^\n]*/) || ['(no note)'])[0]}`)
    check('with no face reported the note says so', /no face reported/.test(txt), (txt.match(/Found:[^\n]*/) || ['(no note)'])[0])
    check('Carbon is asked to think at its low level, either way', calls.locateBodies[0].generation_config?.thinking_level === 'low' && calls.oldBodies[0]?.generationConfig?.thinkingConfig?.thinkingLevel === 'LOW', JSON.stringify([calls.locateBodies[0].generation_config, calls.oldBodies[0]?.generationConfig?.thinkingConfig]))
    check('no page errors beyond the refused request', errors.filter((e) => !/404/.test(e)).length === 0, errors.join(' | '))
    await p.close()
  }
  {
    // an answer that doesn't say where the faces are is not gone by
    const located = JSON.stringify({ objects: [{ arrow: 1, label: 'arm', box_2d: box2d }] })
    const { p, errors } = await open(browser, kase, { locator: located })
    await clickAt(p, m.marks[0].x, m.marks[0].y)
    await p.keyboard.type('remove this')
    await p.locator('[role=dialog] label:has-text("find the object") input').check()
    await p.click('[role=dialog] button:has-text("Apply edit")')
    await p.waitForFunction(() => /Done in|Done on|Gave up|went wrong|Stopped/.test(document.querySelector('[role=dialog]').innerText), null, { timeout: 120000 })
    const txt = await p.evaluate(() => document.querySelector('[role=dialog]').innerText)
    const same = (await diff(p, 'Original', 'Version 1')).changedPct
    check('an answer without a list of faces is not gone by', same === partial && /didn’t say where the faces are/.test(txt), `${same}% vs ${partial}%; ${(txt.match(/“Find the object”[^\n]*/) || ['(no note)'])[0].slice(0, 90)}`)
    check('no page errors', errors.length === 0, errors.join(' | '))
    await p.close()
  }
  {
    // the locator fails: the edit goes on as it would without, with a note
    const { p, calls, errors } = await open(browser, kase, { locator: 'error' })
    await clickAt(p, m.marks[0].x, m.marks[0].y)
    await p.keyboard.type('remove this')
    await p.locator('[role=dialog] label:has-text("find the object") input').check()
    await p.click('[role=dialog] button:has-text("Apply edit")')
    await p.waitForFunction(() => /Done in|Done on|Gave up|went wrong|Stopped/.test(document.querySelector('[role=dialog]').innerText), null, { timeout: 120000 })
    const txt = await p.evaluate(() => document.querySelector('[role=dialog]').innerText)
    const same = (await diff(p, 'Original', 'Version 1')).changedPct
    check('a failed locator leaves the edit as it is without it, and says why', /Done/.test(txt) && same === partial && /didn’t get an answer \(backend unavailable\)/.test(txt), (txt.match(/“Find the object”[^\n]*/) || ['(no note)'])[0].slice(0, 110))
    console.log('     locator calls:', calls.locate, '+', calls.locateOld, '| image calls:', calls.image, '| errors:', errors.filter((e) => !/500/.test(e)))
    await p.close()
  }
  await browser.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
