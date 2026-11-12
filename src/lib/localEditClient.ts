import type { GenerateCaller } from './gemini'
import type { ParsedImagePart } from '../types'
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
  // Set when an answer showed that this edit can't work this way at all
  // (the model won't keep the picture's shape) — the run stops with it
  problem: string | null
}

// The compositor itself is gone (its worker crashed): nothing more can be
// composited in this run
class EditorDead extends Error {}

export async function createLocalEditor(source: Blob, marks: EditMark[]): Promise<LocalEditor> {
  try {
    return await workerEditor(source, marks)
  } catch {
    return inThreadEditor(source, marks)
  }
}

async function workerEditor(source: Blob, marks: EditMark[]): Promise<LocalEditor> {
  const worker: Worker = new LocalEditWorker()
  let nextId = 1
  let dead: Error | null = null
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const fail = (error: Error) => {
    dead = error
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
  worker.onerror = (event) => fail(new EditorDead(event.message || 'local edit worker failed'))
  const call = <T>(message: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      if (dead) return reject(dead)
      const id = nextId++
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      worker.postMessage({ ...message, id })
    })

  try {
    await call({ type: 'prepare', source, marks })
  } catch (err) {
    worker.terminate()
    throw err
  }
  return {
    compose: (result) => call<LocalComposite>({ type: 'compose', result }),
    // Also drops any composite still being worked on
    release: () => {
      worker.terminate()
      fail(new EditorDead('released'))
    },
    extras: new Map(),
    problem: null,
  }
}

async function inThreadEditor(source: Blob, marks: EditMark[]): Promise<LocalEditor> {
  const job = await prepareLocalEdit(source, marks)
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
    problem: null,
  }
}

// Wraps the provider call: each answer becomes the composited picture before
// the retry engine sees it, or a failed attempt when it can't be used (so the
// retry loop simply tries again). Stop works here too: a composite still
// being worked on when it's pressed is dropped.
// `unframe`: for a picture that was sent inside a frame (see frame.ts), cuts
// the picture itself back out of each answer first.
export function makeLocalEditCaller(
  inner: GenerateCaller,
  editor: LocalEditor,
  unframe?: (answer: Blob) => Promise<Blob>,
): GenerateCaller {
  return async (params, signal) => {
    const parsed = await inner(params, signal)
    if (parsed.images.length === 0) return parsed
    let raw = parsed.images[0]
    let outcome: LocalComposite
    try {
      let answer = base64ToBlob(raw.base64, raw.mimeType)
      if (unframe) {
        answer = await untilAborted(unframe(answer), signal)
        raw = { base64: await blobToBase64(answer), mimeType: answer.type }
      }
      outcome = await untilAborted(editor.compose(answer), signal)
    } catch (err) {
      if (signal.aborted || err instanceof EditorDead) throw err
      // An answer that can't be read is one failed attempt, not the end
      return { images: [], finishReason: 'STOP', text: 'the answer could not be read' }
    }
    if (outcome.kind === 'reject') {
      if (outcome.final) {
        editor.problem = outcome.reason
        // No status, no "network": the engine treats it as fatal for this key
        throw new Error(outcome.reason)
      }
      return { images: [], finishReason: 'STOP', text: outcome.reason }
    }
    const part: ParsedImagePart = { base64: await blobToBase64(outcome.blob), mimeType: outcome.blob.type }
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError')
    editor.extras.set(part.base64, { raw, mask: outcome.mask, info: outcome.info })
    return { ...parsed, images: [part] }
  }
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Stopped', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
