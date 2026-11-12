import JSZip from 'jszip'
import type { GeneratedImage, OutputFormat, ParsedImagePart } from '../types'
import { getModel } from './models'

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

// The format a blob REALLY is, read from its magic bytes. Providers' declared
// mime types are not trustworthy here — Gemini has been seen labelling JPEG
// bytes as image/png — and a wrong label used to skip the re-encode, leaving
// a .png file that was actually a JPEG.
export async function sniffImageMimeType(blob: Blob, fallback: string): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45) {
    return 'image/webp'
  }
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif'
  return fallback
}

export async function processImagePart(
  part: ParsedImagePart,
  format: OutputFormat,
  meta: { attempt: number; modelId: string },
): Promise<GeneratedImage> {
  const raw = base64ToBlob(part.base64, part.mimeType)
  // Decide on the real bytes, not the label the API attached to them
  const actual = await sniffImageMimeType(raw, part.mimeType)
  const bitmap = await createImageBitmap(raw)
  let blob = raw
  let mimeType = actual
  if (format === 'jpg' && actual !== 'image/jpeg') {
    blob = await toJpeg(bitmap)
    mimeType = 'image/jpeg'
  } else if (format === 'png' && actual !== 'image/png') {
    blob = await toPng(bitmap)
    mimeType = 'image/png'
  } else if (blob.type !== actual) {
    // Right format already, just mislabelled — fix the blob's type so the
    // browser's download and preview treat it correctly
    blob = new Blob([raw], { type: actual })
  }
  const image: GeneratedImage = {
    id: crypto.randomUUID(),
    kind: 'image',
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

async function toJpeg(bitmap: ImageBitmap, quality = 0.92): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')!
  // JPEG has no alpha channel; composite over white
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, bitmap.width, bitmap.height)
  ctx.drawImage(bitmap, 0, 0)
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

// Video results skip all the canvas work — the bytes are already an mp4; only
// the dimensions and duration are probed so the card can label them.
export async function processVideoPart(
  part: ParsedImagePart,
  meta: { attempt: number; modelId: string },
): Promise<GeneratedImage> {
  const blob = base64ToBlob(part.base64, part.mimeType)
  const objectUrl = URL.createObjectURL(blob)
  const probe = await probeVideo(objectUrl)
  return {
    id: crypto.randomUUID(),
    kind: 'video',
    blob,
    objectUrl,
    width: probe.width,
    height: probe.height,
    duration: probe.duration,
    mimeType: part.mimeType,
    format: 'png',
    attempt: meta.attempt,
    modelId: meta.modelId,
    createdAt: Date.now(),
  }
}

function probeVideo(url: string): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    const done = () =>
      resolve({
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      })
    video.onloadedmetadata = done
    video.onerror = () => resolve({ width: 0, height: 0, duration: 0 })
    video.src = url
  })
}

// The largest side an uploaded picture keeps. The models answer at 4K at
// most, and a patch pasted into something bigger would look soft.
const MAX_UPLOAD_SIDE = 4096

// Brings one of the user's own pictures into the gallery so it can be
// edited. PNGs and upright JPEGs are kept byte for byte; anything else (a
// phone photo stored sideways, WebP, GIF, AVIF, an oversized picture) is
// redrawn the way the browser shows it and kept as a lossless PNG, so the
// providers and the "only around the arrows" compositor all see the same
// pixels. Throws when the browser can't read the file as a picture.
export async function uploadToImage(file: File): Promise<{ image: GeneratedImage; note: string | null }> {
  const bitmap = await createImageBitmap(file)
  try {
    const actual = await sniffImageMimeType(file, file.type)
    const long = Math.max(bitmap.width, bitmap.height)
    const scale = Math.min(1, MAX_UPLOAD_SIDE / long)
    const asIs =
      scale === 1 && (actual === 'image/png' || (actual === 'image/jpeg' && (await jpegOrientation(file)) === 1))
    let blob: Blob
    let width = bitmap.width
    let height = bitmap.height
    if (asIs) {
      blob = file.type === actual ? file : new Blob([file], { type: actual })
    } else {
      width = Math.max(1, Math.round(bitmap.width * scale))
      height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bitmap, 0, 0, width, height)
      blob = await canvas.convertToBlob({ type: 'image/png' })
    }
    const image: GeneratedImage = {
      id: crypto.randomUUID(),
      kind: 'image',
      blob,
      objectUrl: URL.createObjectURL(blob),
      width,
      height,
      mimeType: blob.type,
      format: blob.type === 'image/jpeg' ? 'jpg' : 'png',
      attempt: 0,
      modelId: '',
      createdAt: Date.now(),
      uploaded: { name: file.name || 'Pasted picture' },
    }
    const note =
      scale < 1
        ? `${image.uploaded!.name} was ${bitmap.width}×${bitmap.height} — scaled down to ${width}×${height}, the largest the models work with.`
        : null
    return { image, note }
  } finally {
    bitmap.close()
  }
}

// EXIF orientation of a JPEG (1 = stored upright, also when there is none)
async function jpegOrientation(blob: Blob): Promise<number> {
  const view = new DataView(await blob.slice(0, 256 * 1024).arrayBuffer())
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1
  let offset = 2
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset)
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break
    const size = view.getUint16(offset + 2)
    // APP1 segment starting with "Exif"
    if (marker === 0xffe1 && offset + 18 <= view.byteLength && view.getUint32(offset + 4) === 0x45786966) {
      const tiff = offset + 10
      const little = view.getUint16(tiff) === 0x4949
      const ifd = tiff + view.getUint32(tiff + 4, little)
      if (ifd + 2 > view.byteLength) return 1
      const count = view.getUint16(ifd, little)
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12
        if (entry + 12 > view.byteLength) return 1
        if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little)
      }
      return 1
    }
    offset += 2 + size
  }
  return 1
}

// Who made a picture, for labels: the model's name, or "Uploaded"
export function sourceLabel(image: GeneratedImage): string {
  return image.uploaded ? 'Uploaded' : getModel(image.modelId).label
}

export function makeFilename(image: GeneratedImage, index: number): string {
  if (image.kind === 'video') {
    const stamp = new Date(image.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const slug = getModel(image.modelId).filenameSlug
    const ext = image.mimeType.includes('webm') ? 'webm' : 'mp4'
    return `abigail-${slug}_${stamp}_${String(index + 1).padStart(2, '0')}.${ext}`
  }
  const ext = image.format === 'jpg' ? 'jpg' : 'png'
  const stamp = new Date(image.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const slug = image.uploaded ? 'upload' : getModel(image.modelId).filenameSlug
  const edit = image.edit ? `-edit-v${image.edit.version}` : ''
  return `abigail-${slug}${edit}_${stamp}_${String(index + 1).padStart(2, '0')}.${ext}`
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

// Inline image data has a ~20MB request ceiling on Gemini, and a 4K PNG can
// eat most of it on its own, so oversized edit sources travel as a
// high-quality JPEG instead. Everything else is sent byte-for-byte.
const MAX_SOURCE_BYTES = 7 * 1024 * 1024

export async function imageToReference(image: GeneratedImage): Promise<ParsedImagePart> {
  let blob = image.blob
  if (blob.size > MAX_SOURCE_BYTES) {
    const bitmap = await createImageBitmap(blob)
    blob = await toJpeg(bitmap, 0.95)
    bitmap.close()
  }
  return { base64: await blobToBase64(blob), mimeType: blob.type || image.mimeType }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
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
