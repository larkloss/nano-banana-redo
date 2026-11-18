// Background thread for the local-edit compositor (see localEditClient.ts)
import {
  composeLocalEdit,
  prepareLocalEdit,
  releaseLocalEdit,
  type LocalEditJob,
  type LocalEditOptions,
} from './localEdit'
import type { EditMark } from './annotate'

type Request =
  | { id: number; type: 'prepare'; source: Blob; marks: EditMark[] }
  | { id: number; type: 'compose'; result: Blob; options?: LocalEditOptions }
  | { id: number; type: 'release' }

let job: LocalEditJob | null = null

async function handle(msg: Request): Promise<void> {
  try {
    if (msg.type === 'prepare') {
      job = await prepareLocalEdit(msg.source, msg.marks)
      self.postMessage({ id: msg.id, ok: true })
    } else if (msg.type === 'compose') {
      if (!job) throw new Error('not prepared')
      const bitmap = await createImageBitmap(msg.result)
      try {
        self.postMessage({ id: msg.id, ok: true, outcome: await composeLocalEdit(job, bitmap, msg.options) })
      } finally {
        bitmap.close()
      }
    } else {
      if (job) releaseLocalEdit(job)
      job = null
      self.postMessage({ id: msg.id, ok: true })
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

// One request at a time, in the order they arrive. With several keys or
// candidates the answers come in together, and a composite holds several
// full-size copies of the picture while it works: decoding the next answer
// only when the one before is finished keeps that to one set, not one per
// answer. (`handle` reports its own failures, so the chain never breaks.)
let queue: Promise<void> = Promise.resolve()

self.onmessage = (event: MessageEvent<Request>) => {
  const msg = event.data
  queue = queue.then(() => handle(msg))
}
