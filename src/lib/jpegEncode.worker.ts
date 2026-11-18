// Background thread for the full-colour JPEG encoder (see jpegExport.ts): a
// 4K picture takes a second or two, which must not freeze the page
import { encodeJpeg, readPixels } from './jpegEncode'

interface Job {
  id: number
  picture: Blob
  quality: number
  maxSide?: number
}

async function encode({ id, picture, quality, maxSide }: Job): Promise<void> {
  try {
    const pixels = await readPixels(picture, maxSide)
    const bytes = encodeJpeg(pixels.data, pixels.width, pixels.height, quality)
    self.postMessage({ id, bytes }, { transfer: [bytes.buffer] })
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}

// One picture at a time: "Download all" asks for every picture at once, and
// each is tens of MB once decoded. The next one is decoded only after the one
// before has handed over its bytes. (`encode` reports its own failures, so
// the chain never breaks.)
let queue: Promise<void> = Promise.resolve()

self.onmessage = (event: MessageEvent<Job>) => {
  const job = event.data
  queue = queue.then(() => encode(job))
}
