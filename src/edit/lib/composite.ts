import type { OutputFormat, ParsedImagePart } from '../../types'
import { base64ToBlob } from '../../lib/imageUtils'
import { featherAlphaInward } from './mask'

// Composite the model result over the original: the result layer is scaled to
// the original size, shifted by the alignment offset, clipped by the inward-
// feathered mask, then drawn over the untouched original. Every pixel outside
// the selection comes from the original image.
export async function compositeResult(
  original: ImageBitmap,
  part: ParsedImagePart,
  alphaMask: OffscreenCanvas,
  featherPx: number,
  offset: { dx: number; dy: number },
  format: OutputFormat,
): Promise<Blob> {
  const W = original.width
  const H = original.height
  const result = await createImageBitmap(base64ToBlob(part.base64, part.mimeType))

  const layer = new OffscreenCanvas(W, H)
  const lctx = layer.getContext('2d')!
  lctx.imageSmoothingQuality = 'high'
  lctx.drawImage(result, 0, 0, result.width, result.height, offset.dx, offset.dy, W, H)
  lctx.globalCompositeOperation = 'destination-in'
  lctx.drawImage(featherAlphaInward(alphaMask, featherPx), 0, 0)
  result.close()

  const out = new OffscreenCanvas(W, H)
  const octx = out.getContext('2d')!
  octx.drawImage(original, 0, 0)
  octx.drawImage(layer, 0, 0)

  return out.convertToBlob(
    format === 'jpg' ? { type: 'image/jpeg', quality: 0.92 } : { type: 'image/png' },
  )
}
