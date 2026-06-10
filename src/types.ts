export type AspectRatio = 'auto' | string

export type ImageSize = '1K' | '2K' | '4K'

export type OutputFormat = 'png' | 'jpg'

export interface Settings {
  modelId: string
  systemInstruction: string
  aspectRatio: AspectRatio
  imageSize: ImageSize
  format: OutputFormat
  targetCount: number
  attemptsCap: number
  prompt: string
}

export interface ReferenceImage {
  id: string
  name: string
  mimeType: string
  base64: string
  objectUrl: string
}

export interface GeneratedImage {
  id: string
  blob: Blob
  objectUrl: string
  width: number
  height: number
  mimeType: string
  format: OutputFormat
  attempt: number
  modelId: string
  createdAt: number
}

export type RunStatus =
  | 'idle'
  | 'running'
  | 'backoff'
  | 'complete'
  | 'cap-reached'
  | 'stopped'
  | 'error'

export interface RunState {
  status: RunStatus
  collected: number
  target: number
  attempts: number
  cap: number
  lastFailure: string | null
  backoffUntil: number | null
  errorMessage: string | null
}

export interface ParsedImagePart {
  base64: string
  mimeType: string
}

export interface ParsedResponse {
  images: ParsedImagePart[]
  blockReason?: string
  finishReason?: string
  text?: string
}

export type AttemptOutcome =
  | { kind: 'success'; images: ParsedImagePart[] }
  | { kind: 'moderation'; reason: string }
  | { kind: 'empty'; reason: string }
  | { kind: 'transient'; reason: string; retryDelayMs?: number }
  | { kind: 'fatal'; message: string }
  | { kind: 'aborted' }

export type EngineEvent =
  | { type: 'image'; image: ParsedImagePart; attempt: number }
  | { type: 'progress'; collected: number; attempts: number; cap: number }
  | { type: 'failure'; reason: string; attempts: number; cap: number }
  | { type: 'backoff'; delayMs: number; reason: string }

export interface RunSummary {
  result: 'complete' | 'cap-reached' | 'stopped' | 'error'
  collected: number
  attempts: number
  errorMessage?: string
}
