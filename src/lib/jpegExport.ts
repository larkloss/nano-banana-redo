import { encodeJpeg, readPixels } from './jpegEncode'
import JpegWorker from './jpegEncode.worker?worker&inline'

// A picture as a JPEG that keeps colour at full resolution (see
// jpegEncode.ts for why not the browser's own encoder). Encoded on a
// background thread; if that can't be started, here instead — the page
// just pauses for a moment.
let worker: Worker | null = null
let broken = false
let nextId = 1
const waiting = new Map<number, { resolve: (blob: Blob) => void; reject: (error: Error) => void }>()

function startWorker(): Worker {
  const started: Worker = new JpegWorker()
  started.onmessage = (event: MessageEvent<{ id: number; bytes?: Uint8Array<ArrayBuffer>; error?: string }>) => {
    const entry = waiting.get(event.data.id)
    if (!entry) return
    waiting.delete(event.data.id)
    if (event.data.bytes) entry.resolve(new Blob([event.data.bytes], { type: 'image/jpeg' }))
    else entry.reject(new Error(event.data.error ?? 'JPEG encoding failed'))
  }
  started.onerror = () => {
    broken = true
    worker = null
    waiting.forEach((entry) => entry.reject(new Error('JPEG encoder stopped')))
    waiting.clear()
  }
  return started
}

// `maxSide`: also scale the picture down to that size if it is larger
export async function toFullColourJpeg(picture: Blob, quality: number, maxSide?: number): Promise<Blob> {
  if (!broken) {
    try {
      worker ??= startWorker()
      const running = worker
      return await new Promise<Blob>((resolve, reject) => {
        const id = nextId++
        waiting.set(id, { resolve, reject })
        running.postMessage({ id, picture, quality, maxSide })
      })
    } catch {
      // fall through to encoding on this thread
    }
  }
  const pixels = await readPixels(picture, maxSide)
  const bytes = encodeJpeg(pixels.data, pixels.width, pixels.height, quality)
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
}
