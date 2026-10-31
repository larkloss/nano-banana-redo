// Copies the committed single-file apps into ./site, the folder the Worker
// serves. Runs automatically before `wrangler deploy` / `wrangler dev`.
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'

const PAGES = [
  ['nano-banana.html', 'index.html'],
  ['nano-banana-edit.html', 'edit.html'],
  ['nano-banana-video.html', 'video.html'],
]

rmSync('site', { recursive: true, force: true })
mkdirSync('site')
for (const [from, to] of PAGES) {
  if (!existsSync(from)) throw new Error(`${from} is missing — run "npm run build:singles" first`)
  copyFileSync(from, `site/${to}`)
}
console.log(`prepared site/ with ${PAGES.length} pages`)
