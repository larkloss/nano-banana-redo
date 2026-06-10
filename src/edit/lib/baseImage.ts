import type { BaseImage } from '../types'
import { fileToReference } from '../../lib/imageUtils'

export async function fileToBaseImage(file: File | Blob, name?: string): Promise<BaseImage> {
  const { base64, mimeType } = await fileToReference(
    file instanceof File ? file : new File([file], name ?? 'image.png', { type: file.type }),
  )
  const bitmap = await createImageBitmap(file)
  return {
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    base64,
    mimeType,
    objectUrl: URL.createObjectURL(file),
  }
}
