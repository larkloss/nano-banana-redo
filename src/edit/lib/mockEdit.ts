import type { GenerateCaller } from '../../lib/gemini'
import type { ParsedResponse } from '../../types'
import { base64ToBlob } from '../../lib/imageUtils'
import { blobToBase64 } from './mask'

// Dev-only fake model (?mock=1) exercising the full edit pipeline without
// quota: a real masked "edit" with a deliberate misalignment (tests the
// aligner end-to-end), a no-op (tests unchanged-result detection), a 429
// (tests lane backoff), then a clean edit.
let step = 0

export const mockEditCaller: GenerateCaller = async (params, signal) => {
  await new Promise((r) => setTimeout(r, 800))
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const [base, mask] = params.references
  const current = step % 4
  step += 1

  switch (current) {
    case 0:
      return edited(base, mask, { dx: 5, dy: -3 })
    case 1:
      return { images: [{ base64: base.base64, mimeType: base.mimeType }], finishReason: 'STOP' }
    case 2:
      throw Object.assign(new Error('mock rate limit {"retryDelay": "3s"}'), { status: 429 })
    default:
      return edited(base, mask, { dx: 0, dy: 0 })
  }
}

async function edited(
  base: { base64: string; mimeType: string },
  mask: { base64: string; mimeType: string },
  shift: { dx: number; dy: number },
): Promise<ParsedResponse> {
  const baseBmp = await createImageBitmap(base64ToBlob(base.base64, base.mimeType))
  const maskBmp = await createImageBitmap(base64ToBlob(mask.base64, mask.mimeType))
  const w = baseBmp.width
  const h = baseBmp.height

  // Build the "edit": hue-rotated copy of the base, kept only where the B/W
  // mask is white (luminance keying via multiply of the mask).
  const editLayer = new OffscreenCanvas(w, h)
  const ectx = editLayer.getContext('2d')!
  ectx.filter = 'hue-rotate(140deg) saturate(1.6)'
  ectx.drawImage(baseBmp, 0, 0, w, h)
  ectx.filter = 'none'
  ectx.globalCompositeOperation = 'multiply'
  ectx.drawImage(maskBmp, 0, 0, w, h)
  // multiply leaves black outside; rebuild alpha from the mask
  ectx.globalCompositeOperation = 'destination-in'
  const alphaFromMask = new OffscreenCanvas(w, h)
  const actx = alphaFromMask.getContext('2d')!
  actx.drawImage(maskBmp, 0, 0, w, h)
  const imgData = actx.getImageData(0, 0, w, h)
  for (let i = 0; i < imgData.data.length; i += 4) imgData.data[i + 3] = imgData.data[i]
  actx.putImageData(imgData, 0, 0)
  ectx.drawImage(alphaFromMask, 0, 0)

  const frame = new OffscreenCanvas(w, h)
  const fctx = frame.getContext('2d')!
  fctx.drawImage(baseBmp, 0, 0)
  fctx.drawImage(editLayer, 0, 0)

  // Deliberate whole-frame misalignment, simulating the model quirk
  const out = new OffscreenCanvas(w, h)
  const octx = out.getContext('2d')!
  octx.drawImage(baseBmp, 0, 0) // pad so shifted edges aren't transparent
  octx.drawImage(frame, shift.dx, shift.dy)

  baseBmp.close()
  maskBmp.close()
  const base64 = await blobToBase64(await out.convertToBlob({ type: 'image/png' }))
  return { images: [{ base64, mimeType: 'image/png' }], finishReason: 'STOP' }
}
