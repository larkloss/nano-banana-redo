import type { GenerateCaller } from './gemini'
import type { OutputFormat, ParsedImagePart } from '../types'
import type { EditMark } from './annotate'
import { base64ToBlob } from './imageUtils'
import { blobToBase64 } from '../edit/lib/mask'
import {
  composeLocalEdit,
  prepareLocalEdit,
  releaseLocalEdit,
  type LocalComposite,
  type LocalEditInfo,
} from './localEdit'
import LocalEditWorker from './localEdit.worker?worker&inline'

// One "only around the arrows" edit: the compositor prepared for a source
// picture, plus what each composited answer came from. The heavy work runs
// in a Web Worker so the page stays responsive (the Stop button, the spinner);
// if a worker can't be started (an unusual browser setup), it runs here
// instead, just less smoothly.
export interface LocalEditor {
  compose(result: Blob): Promise<LocalComposite>
  release(): void
  // Per composited answer, keyed by the composite's base64
  extras: Map<string, { raw: ParsedImagePart; mask: Blob; info: LocalEditInfo }>
}

export async function createLocalEditor(source: Blob, marks: EditMark[], format: OutputFormat): Promise<LocalEditor> {
  try {
    return await workerEditor(source, marks, format)
  } catch {
    return inThreadEditor(source, marks, format)
  }
}

async function workerEditor(source: Blob, marks: EditMark[], format: OutputFormat): Promise<LocalEditor> {
  const worker: Worker = new LocalEditWorker()
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const fail = (error: Error) => {
    pending.forEach((p) => p.reject(error))
    pending.clear()
  }
  worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; outcome?: unknown; error?: string }>) => {
    const entry = pending.get(event.data.id)
    if (!entry) return
    pending.delete(event.data.id)
    if (event.data.ok) entry.resolve(event.data.outcome)
    else entry.reject(new Error(event.data.error ?? 'local edit failed'))
  }
  worker.onerror = (event) => fail(new Error(event.message || 'local edit worker failed'))
  const call = <T>(message: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      worker.postMessage({ ...message, id })
    })

  try {
    await call({ type: 'prepare', source, marks, format })
  } catch (err) {
    worker.terminate()
    throw err
  }
  return {
    compose: (result) => call<LocalComposite>({ type: 'compose', result }),
    release: () => {
      worker.terminate()
      fail(new Error('released'))
    },
    extras: new Map(),
  }
}

async function inThreadEditor(source: Blob, marks: EditMark[], format: OutputFormat): Promise<LocalEditor> {
  const job = await prepareLocalEdit(source, marks, format)
  return {
    compose: async (result) => {
      const bitmap = await createImageBitmap(result)
      try {
        return await composeLocalEdit(job, bitmap)
      } finally {
        bitmap.close()
      }
    },
    release: () => releaseLocalEdit(job),
    extras: new Map(),
  }
}

// Wraps the provider call: each answer becomes the composited picture before
// the retry engine sees it, or a failed attempt when it can't be used (so the
// retry loop simply tries again).
export function makeLocalEditCaller(inner: GenerateCaller, editor: LocalEditor): GenerateCaller {
  return async (params, signal) => {
    const parsed = await inner(params, signal)
    if (parsed.images.length === 0) return parsed
    const raw = parsed.images[0]
    const outcome = await editor.compose(base64ToBlob(raw.base64, raw.mimeType))
    if (outcome.kind === 'reject') return { images: [], finishReason: 'STOP', text: outcome.reason }
    const part: ParsedImagePart = { base64: await blobToBase64(outcome.blob), mimeType: outcome.blob.type }
    editor.extras.set(part.base64, { raw, mask: outcome.mask, info: outcome.info })
    return { ...parsed, images: [part] }
  }
}
