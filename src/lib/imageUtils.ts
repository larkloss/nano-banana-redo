import JSZip from 'jszip'
import type { GeneratedImage, OutputFormat, ParsedImagePart } from '../types'
import { getModel } from './models'

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

export async function processImagePart(
  part: ParsedImagePart,
  format: OutputFormat,
  meta: { attempt: number; modelId: string },
): Promise<GeneratedImage> {
  const raw = base64ToBlob(part.base64, part.mimeType)
  const bitmap = await createImageBitmap(raw)
  let blob = raw
  let mimeType = part.mimeType
  if (format === 'jpg' && part.mimeType !== 'image/jpeg') {
    blob = await toJpeg(bitmap)
    mimeType = 'image/jpeg'
  } else if (format === 'png' && part.mimeType !== 'image/png') {
    // xAI returns JPEG — re-encode so a .png filename holds real PNG bytes
    blob = await toPng(bitmap)
    mimeType = 'image/png'
  }
  const image: GeneratedImage = {
    id: crypto.randomUUID(),
    blob,
    objectUrl: URL.createObjectURL(blob),
    width: bitmap.width,
    height: bitmap.height,
    mimeType,
    format,
    attempt: meta.attempt,
    modelId: meta.modelId,
    createdAt: Date.now(),
  }
  bitmap.close()
  return image
}

async function toPng(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

async function toJpeg(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')!
  // JPEG has no alpha channel; composite over white
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, bitmap.width, bitmap.height)
  ctx.drawImage(bitmap, 0, 0)
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
}

export function makeFilename(image: GeneratedImage, index: number): string {
  const ext = image.format === 'jpg' ? 'jpg' : 'png'
  const stamp = new Date(image.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const slug = getModel(image.modelId).filenameSlug
  return `abigail-${slug}_${stamp}_${String(index + 1).padStart(2, '0')}.${ext}`
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export async function downloadAllAsZip(images: GeneratedImage[]): Promise<void> {
  const zip = new JSZip()
  images.forEach((img, i) => zip.file(makeFilename(img, i), img.blob))
  const blob = await zip.generateAsync({ type: 'blob' })
  downloadBlob(blob, `abigail-chase_${Date.now()}.zip`)
}

export function fileToReference(file: File): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve({ base64: result.split(',')[1], mimeType: file.type || 'image/png' })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
