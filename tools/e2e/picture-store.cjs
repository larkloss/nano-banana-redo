// End-to-end check of where pictures are kept: on the browser's own disk
// storage for the page (IndexedDB) instead of in memory, byte for byte, with
// each tab's pictures its own, left-overs of closed tabs deleted at the next
// start, and everything freed when the gallery is cleared.
//
//   npm run build:single                           (the page under test)
//   (cd tools/compositor-bench && python sim.py)   (the picture it uses, once)
//   node tools/e2e/picture-store.cjs
//
// Exits with status 1 if a check fails.
const { chromium } = require('playwright')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const APP = 'file://' + path.join(__dirname, '..', '..', 'nano-banana.html')
const PICTURE = fs.readFileSync(path.join(__dirname, '..', 'compositor-bench', 'cases', 'A-4k__mild', 'orig.png'))
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); ok ? pass++ : fail++ }

// A tab with the app in it, the model's answer faked: always the same picture
async function tab(context, errors) {
  const p = await context.newPage()
  p.on('pageerror', (e) => errors.push(e.message))
  await p.route('https://generativelanguage.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PICTURE.toString('base64') } }] }, finishReason: 'STOP' }] }) }))
  await p.goto(APP)
  await p.evaluate(() => {
    localStorage.setItem('nbr.apiKey', 'g')
    localStorage.setItem('nbr.settings.v1', JSON.stringify({ targetCount: 1, prompt: 'x', attemptsCap: 3 })); localStorage.setItem('nbr.capDefault50', '1')
    localStorage.setItem('nbr.promptModules.v1', JSON.stringify({ mode: 'simple', modules: [] }))
  })
  await p.reload()
  return p
}
const generate = async (p, count) => {
  await p.click('button:has-text("Generate 1 image")')
  await p.waitForFunction((n) => document.querySelectorAll('main img[alt^="Generated"]').length >= n, count, { timeout: 60000 })
}
// What the store holds: one entry per stored picture, with the tab it belongs to
const stored = (p) => p.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('nano-banana-pictures')
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const db = open.result
    if (!db.objectStoreNames.contains('blobs')) { db.close(); return resolve([]) }
    const all = db.transaction('blobs').objectStore('blobs').getAll()
    all.onsuccess = () => { db.close(); resolve(all.result.map((row) => ({ session: row.session, bytes: row.blob.size, type: row.blob.type }))) }
    all.onerror = () => reject(all.error)
  }
}))
// The bytes behind the first gallery picture, hashed in the page
const shown = (p) => p.evaluate(async () => {
  const img = document.querySelector('main img[alt^="Generated"]')
  // (the card shows a reduced copy; the picture itself is at data-full)
  const src = img.dataset.full || img.src
  try {
    const bytes = await (await fetch(src)).arrayBuffer()
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
    return { hash, bytes: bytes.byteLength, natural: img.naturalWidth, src, card: img.getAttribute('src') }
  } catch (err) {
    return { error: String(err), src }
  }
})

;(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nbr-store-'))
  const context = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 900 } })
  const errors = []
  try {
    const a = await tab(context, errors)
    await generate(a, 1)
    let rows = await stored(a)
    check('a picture is stored once, whole', rows.length === 1 && rows[0].bytes === PICTURE.length && rows[0].type === 'image/png', JSON.stringify(rows))
    const first = await shown(a)
    check('what the gallery shows is the stored picture, byte for byte', first.hash === sha256(PICTURE) && first.natural > 0, `${first.bytes} bytes`)
    // The card shows a reduced copy; whatever could take the picture out of
    // the page gets the picture itself
    check('the card shows a reduced copy of a big picture', first.card !== first.src && first.natural === 1024, `${first.natural} px wide`)
    const card = a.locator('main img[alt^="Generated"]').first()
    const box = await card.boundingBox()
    await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await a.mouse.down({ button: 'right' })
    const pressed = await card.evaluate((img) => ({ itself: img.getAttribute('src') === img.dataset.full }))
    await a.mouse.up({ button: 'right' })
    await a.keyboard.press('Escape')
    check('a right press on the card puts the picture itself there (for "Save image as")', pressed.itself)
    check('and it stays, for "Copy image" from the menu', await card.evaluate((img) => img.getAttribute('src') === img.dataset.full))
    await a.mouse.down()
    const held = await card.evaluate((img) => img.getAttribute('src') === img.dataset.full)
    await a.mouse.up()
    await a.waitForSelector('button:has-text("✕")')
    const after = await card.evaluate((img) => img.getAttribute('src') !== img.dataset.full)
    check('a left press does too (a drag may follow), and a plain click brings the copy back', held && after)
    const large = await a.evaluate(() => {
      const cardImg = document.querySelector('main img[alt^="Generated"]')
      const big = [...document.querySelectorAll('img')].filter((i) => i !== cardImg && !i.hasAttribute('aria-hidden') && i.naturalWidth > 0).sort((x, y) => y.naturalWidth - x.naturalWidth)[0]
      return { natural: big?.naturalWidth, itself: big?.getAttribute('src') === cardImg.dataset.full }
    })
    check('the large view shows the picture itself', large.itself && large.natural === 4096, JSON.stringify(large))
    await a.keyboard.press('Escape')
    const download = a.waitForEvent('download')
    await a.locator('main button[title^="Download"], main button:has-text("Download")').first().click()
    const saved = fs.readFileSync(await (await download).path())
    check('and so is the download', sha256(saved) === sha256(PICTURE), `${saved.length} bytes`)

    const b = await tab(context, errors)
    await generate(b, 1)
    rows = await stored(b)
    const sessions = [...new Set(rows.map((r) => r.session))]
    check('a second tab stores under an id of its own and leaves the first tab alone', rows.length === 2 && sessions.length === 2, JSON.stringify(rows))
    check('the first tab still shows its picture', (await shown(a)).hash === sha256(PICTURE))

    // Tab B generates one more; tab A is closed without a goodbye (as in a crash)
    await generate(b, 2)
    await a.close({ runBeforeUnload: false })
    await sleep(500)
    const c = await tab(context, errors)
    await sleep(1500)
    rows = await stored(c)
    check('a new tab deletes what a closed tab left behind, and nothing of a tab that is open',
      rows.length === 2 && new Set(rows.map((r) => r.session)).size === 1, JSON.stringify(rows))
    check('the open tab still shows its pictures', (await shown(b)).hash === sha256(PICTURE))

    // Clearing the gallery frees the pictures
    const before = await shown(b)
    await b.click('main button:has-text("Clear")')
    await b.click('main button:has-text("Yes")')
    await sleep(3500)
    rows = await stored(b)
    check('clearing the gallery deletes its stored pictures', rows.length === 0, JSON.stringify(rows))
    const gone = await b.evaluate(async (src) => { try { await (await fetch(src)).arrayBuffer(); return false } catch { return true } }, before.src)
    check('and lets go of the addresses they were shown from', gone)
    await generate(b, 1)
    check('pictures made after that are stored and shown as usual', (await stored(b)).length === 1 && (await shown(b)).hash === sha256(PICTURE))

    // A reload starts from nothing: what the page held before is deleted
    await b.reload()
    await sleep(1500)
    check('a reload leaves nothing behind', (await stored(b)).length === 0)
    check('no page errors', errors.length === 0, errors.join(' | '))
  } finally {
    await context.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
