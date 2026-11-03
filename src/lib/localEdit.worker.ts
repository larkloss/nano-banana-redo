// Background thread for the local-edit compositor (see localEditClient.ts)
import { composeLocalEdit, prepareLocalEdit, releaseLocalEdit, type LocalEditJob } from './localEdit'
import type { EditMark } from './annotate'
import type { OutputFormat } from '../types'

type Request =
  | { id: number; type: 'prepare'; source: Blob; marks: EditMark[]; format: OutputFormat }
  | { id: number; type: 'compose'; result: Blob }
  | { id: number; type: 'release' }

let job: LocalEditJob | null = null

self.onmessage = async (event: MessageEvent<Request>) => {
  const msg = event.data
  try {
    if (msg.type === 'prepare') {
      job = await prepareLocalEdit(msg.source, msg.marks, msg.format)
      self.postMessage({ id: msg.id, ok: true })
    } else if (msg.type === 'compose') {
      if (!job) throw new Error('not prepared')
      const bitmap = await createImageBitmap(msg.result)
      try {
        self.postMessage({ id: msg.id, ok: true, outcome: await composeLocalEdit(job, bitmap) })
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
