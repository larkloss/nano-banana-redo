// Background thread for the full-colour JPEG encoder (see jpegExport.ts): a
// 4K picture takes a second or two, which must not freeze the page
import { encodeJpeg, readPixels } from './jpegEncode'

self.onmessage = async (event: MessageEvent<{ id: number; picture: Blob; quality: number; maxSide?: number }>) => {
  const { id, picture, quality, maxSide } = event.data
  try {
    const pixels = await readPixels(picture, maxSide)
    const bytes = encodeJpeg(pixels.data, pixels.width, pixels.height, quality)
    self.postMessage({ id, bytes }, { transfer: [bytes.buffer] })
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
