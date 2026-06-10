import type { ImageSize, OutputFormat, ParsedImagePart } from '../types'

export type Tool = 'rect' | 'ellipse' | 'lasso' | 'polygon'

export type Shape =
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'lasso'; points: { x: number; y: number }[] }
  | { kind: 'polygon'; points: { x: number; y: number }[] }

export interface BaseImage {
  bitmap: ImageBitmap
  width: number
  height: number
  base64: string
  mimeType: string
  objectUrl: string
}

export interface Candidate {
  id: string
  part: ParsedImagePart
  offset: { dx: number; dy: number }
  insideDiff: number
  compositeBlob: Blob
  compositeUrl: string
  attempt: number
}

export interface EditSettings {
  modelId: string
  imageSize: ImageSize
  candidates: number
  attemptsCap: number
  feather: number
  seamless: boolean
  format: OutputFormat
  prompt: string
}
