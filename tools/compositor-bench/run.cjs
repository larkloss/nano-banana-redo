// Runs every case (or those whose name contains one of the filters) through
// the compositor as it is in src/ right now, in headless Chromium.
//
//   node run.cjs <tag> [filters...] [--maps]
//
// Writes out/<tag>/<case>/{composite.png,mask.png,out.json}; with --maps also
// the detection's maps (strong, weak, joined, first, grown) as PNGs.
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const HERE = __dirname
const args = process.argv.slice(2)
const withMaps = args.includes('--maps')
const [tag = 'run', ...filters] = args.filter((a) => !a.startsWith('--'))

async function main() {
  // The harness is bundled afresh on every run, so it always tests the
  // current source
  const build = path.join(HERE, '.build')
  fs.mkdirSync(build, { recursive: true })
  esbuild.buildSync({
    entryPoints: [path.join(HERE, 'harness.ts')],
    bundle: true,
    format: 'iife',
    outfile: path.join(build, 'harness.js'),
    logLevel: 'warning',
  })
  fs.writeFileSync(
    path.join(build, 'harness.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="harness.js"></script></body></html>',
  )

  const casesDir = path.join(HERE, 'cases')
  if (!fs.existsSync(casesDir)) throw new Error('No cases yet: run `python sim.py` first')
  const cases = fs
    .readdirSync(casesDir)
    .filter((d) => !d.startsWith('_') && (!filters.length || filters.some((f) => d.includes(f))))
    .sort()

  const browser = await chromium.launch()
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto('file://' + path.join(build, 'harness.html'))

  for (const id of cases) {
    const dir = path.join(casesDir, id)
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
    const orig = fs.readFileSync(path.join(dir, 'orig.png')).toString('base64')
    const res = fs.readFileSync(path.join(dir, 'result.png')).toString('base64')
    // meta.options: what the app would know beyond the two pictures (the
    // extent of the thing an arrow points at, guarded areas, touch-ups)
    const out = await page.evaluate(({ o, r, m, maps, options }) => window.runCase(o, r, m, maps, options), {
      o: orig,
      r: res,
      m: meta.marks,
      maps: withMaps,
      options: meta.options,
    })
    const od = path.join(HERE, 'out', tag, id)
    fs.mkdirSync(od, { recursive: true })
    for (const name of ['composite', 'mask']) {
      if (out[name]) fs.writeFileSync(path.join(od, `${name}.png`), Buffer.from(out[name], 'base64'))
      delete out[name]
    }
    for (const [name, b64] of Object.entries(out.maps || {}))
      fs.writeFileSync(path.join(od, `map-${name}.png`), Buffer.from(b64, 'base64'))
    delete out.maps
    fs.writeFileSync(path.join(od, 'out.json'), JSON.stringify(out))
    const summary =
      out.kind === 'ok'
        ? `cov ${(out.info.coverage * 100).toFixed(2)}% arrows ${out.info.arrowsChanged.map(Number).join('')} limit ${out.info.reachedLimit}`
        : out.reason
    console.log(id.padEnd(28), out.kind.padEnd(7), summary, `${Math.round(out.ms)}ms`)
  }
  await browser.close()
  if (errors.length) {
    console.log('PAGE ERRORS', errors)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
