import type { GeneratedImage } from '../types'
import { releaseFromDisk } from './blobStore'
import { exportedCopy } from './imageUtils'

// What a picture (or a whole edit chain) keeps alive in the browser: the
// addresses it is shown from, and the bytes behind them. An address keeps
// its bytes in memory until it is revoked, whatever else is forgotten.
export interface Held {
  urls: string[]
  blobs: Blob[]
}

export function heldByImage(image: GeneratedImage): Held {
  const urls = [image.objectUrl, image.thumbUrl, image.cardUrl].filter((url): url is string => Boolean(url))
  return { urls, blobs: [image.blob] }
}

// Frees what `dropped` held, except anything `kept` still uses (a version of
// a chain and its gallery card are the same picture). A moment later, so
// that whatever still showed them is off the page first.
export function letGo(dropped: Held[], kept: Held[]): void {
  const urlsKept = new Set(kept.flatMap((held) => held.urls))
  const blobsKept = new Set(kept.flatMap((held) => held.blobs))
  const urls = new Set(dropped.flatMap((held) => held.urls).filter((url) => !urlsKept.has(url)))
  const blobs = new Set(dropped.flatMap((held) => held.blobs).filter((blob) => !blobsKept.has(blob)))
  if (urls.size === 0 && blobs.size === 0) return
  setTimeout(() => {
    for (const url of urls) URL.revokeObjectURL(url)
    releaseFromDisk(blobs)
    // (and the copies encoded for saving them)
    for (const blob of blobs) void exportedCopy(blob)?.then((copy) => releaseFromDisk([copy]), () => undefined)
  }, 2000)
}
