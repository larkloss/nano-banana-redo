// Are two bench runs the same, byte for byte? For changes that must not touch
// a single pixel (memory, speed, tidying): run the bench before and after,
// then
//
//   node same.cjs before after
//
// Compares the sha256 of every composite.png and mask.png (and of any map-*.png),
// and what the compositor reported (accepted or not, why, its statistics;
// not the timings). An argument with a slash in it is taken as a directory,
// anything else as a tag under out/. Exits with status 1 on any difference.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const dirOf = (arg) => (arg.includes('/') ? path.resolve(arg) : path.join(__dirname, 'out', arg))
const [a, b] = process.argv.slice(2).map(dirOf)
if (!a || !b) {
  console.error('usage: node same.cjs <tag or dir> <tag or dir>')
  process.exit(2)
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
// out.json without what legitimately differs between two runs
const report = (file) => {
  const out = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete out.ms
  delete out.prepMs
  return JSON.stringify(out)
}
const cases = (dir) => fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort()

const inA = cases(a)
const inB = cases(b)
const differences = []
let files = 0
let composites = 0
for (const id of new Set([...inA, ...inB])) {
  if (!inA.includes(id) || !inB.includes(id)) {
    differences.push(`${id}: only in ${inA.includes(id) ? a : b}`)
    continue
  }
  const names = new Set([...fs.readdirSync(path.join(a, id)), ...fs.readdirSync(path.join(b, id))])
  for (const name of [...names].sort()) {
    const fa = path.join(a, id, name)
    const fb = path.join(b, id, name)
    if (!fs.existsSync(fa) || !fs.existsSync(fb)) {
      differences.push(`${id}/${name}: only in one run`)
      continue
    }
    files++
    if (name === 'composite.png') composites++
    const same = name === 'out.json' ? report(fa) === report(fb) : sha256(fa) === sha256(fb)
    if (!same) differences.push(`${id}/${name}: differs`)
  }
}

console.log(`${inA.length} and ${inB.length} cases, ${files} files compared (${composites} composites)`)
if (differences.length) {
  console.log(`${differences.length} DIFFERENCES`)
  for (const d of differences) console.log('  ' + d)
  process.exit(1)
}
console.log('identical')
