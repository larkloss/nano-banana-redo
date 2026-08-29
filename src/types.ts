export type AspectRatio = 'auto' | string

export type ImageSize = '1K' | '2K' | '4K'

export type OutputFormat = 'png' | 'jpg'

export type Provider = 'gemini' | 'xai'

// xAI's image resolution switch (distinct from Gemini's 1K/2K/4K imageSize)
export type XaiResolution = '1k' | '2k'

// Only grok-imagine-image-2.0 accepts this; medium is the server default
export type XaiQuality = 'low' | 'medium'

// Gemini Omni video output resolution; 360p is the cheap/fast draft tier
export type OmniResolution = '360p' | '720p' | '1080p' | '4k'

export interface Settings {
  modelId: string
  systemInstruction: string
  aspectRatio: AspectRatio
  imageSize: ImageSize
  xaiResolution: XaiResolution
  xaiQuality: XaiQuality
  omniResolution: OmniResolution
  // Overrides the selected xAI preset's ID — lets a brand-new model be used
  // by typing its ID, without waiting for a code change. Empty = use preset.
  xaiModelId: string
  format: OutputFormat
  targetCount: number
  attemptsCap: number
  prompt: string
}

export interface PromptVariant {
  id: string
  name: string
  text: string
}

export interface PromptModule {
  id: string
  // UI label only — never included in the assembled prompt
  name: string
  enabled: boolean
  text: string
  variants: PromptVariant[]
  // Variant last loaded into `text`; editing afterwards marks it dirty in the UI
  activeVariantId: string | null
  collapsed: boolean
}

export type PromptMode = 'simple' | 'modular'

export interface PromptWorkspace {
  mode: PromptMode
  modules: PromptModule[]
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
  // 'video' items come from Gemini Omni and play instead of rendering as a still
  kind: 'image' | 'video'
  blob: Blob
  objectUrl: string
  width: number
  height: number
  // Seconds, video only
  duration?: number
  mimeType: string
  format: OutputFormat
  attempt: number
  modelId: string
  createdAt: number
}

export type RunStatus =
  | 'idle'
  | 'running'
  | 'complete'
  | 'cap-reached'
  | 'stopped'
  | 'error'

export type LaneStatus = 'idle' | 'running' | 'backoff' | 'done' | 'dead'

export interface LaneState {
  status: LaneStatus
  lastReason: string | null
  backoffUntil: number | null
}

export interface RunState {
  status: RunStatus
  collected: number
  target: number
  attempts: number
  cap: number
  lanes: LaneState[]
  lastFailure: string | null
  errorMessage: string | null
}

export interface ParsedImagePart {
  base64: string
  mimeType: string
}

// ---------------------------------------------------------------------------
// Video app (Veo)
// ---------------------------------------------------------------------------

// 'references' → up to 3 asset images for character consistency;
// 'frames' → first-frame image-to-video with optional last frame.
// The Veo API forbids mixing the two, hence a mode switch.
export type VideoInputMode = 'references' | 'frames'

export interface VideoSettings {
  modelId: string
  aspectRatio: '16:9' | '9:16'
  resolution: '720p' | '1080p'
  durationSeconds: 4 | 6 | 8
  generateAudio: boolean
  negativePrompt: string
  seed: number | null
  personGeneration: 'allow_adult' | 'dont_allow'
  // Server default is ON; we only send the flag when the user opts out
  enhancePrompt: boolean
  inputMode: VideoInputMode
  targetCount: number
  attemptsCap: number
  prompt: string
}

export interface GeneratedVideo {
  id: string
  blob: Blob
  objectUrl: string
  mimeType: string
  modelId: string
  durationSeconds: number
  resolution: string
  aspectRatio: string
  attempt: number
  createdAt: number
}

// A video attempt is a long-running operation, so lanes surface which phase
// they are in (submit → poll for minutes → download the finished file).
export type VideoLaneStatus =
  | 'idle'
  | 'submitting'
  | 'polling'
  | 'downloading'
  | 'backoff'
  | 'done'
  | 'dead'

export interface VideoLaneState {
  status: VideoLaneStatus
  lastReason: string | null
  backoffUntil: number | null
  // When the current phase started — lets the UI show elapsed polling time
  phaseStartedAt: number | null
}

export interface VideoRunState {
  status: RunStatus
  collected: number
  target: number
  attempts: number
  cap: number
  lanes: VideoLaneState[]
  lastFailure: string | null
  errorMessage: string | null
}

export type VideoResult =
  | { kind: 'video'; blob: Blob; mimeType: string }
  // Safety-filtered or empty response — counts as a completed attempt, retried
  | { kind: 'filtered'; reason: string }

export type VideoEngineEvent =
  | { type: 'video'; blob: Blob; mimeType: string; attempt: number; lane: number }
  | { type: 'progress'; collected: number; attempts: number; cap: number }
  | { type: 'failure'; reason: string; attempts: number; cap: number; lane: number }
  | { type: 'lane'; lane: number; status: VideoLaneStatus; reason?: string; backoffUntil?: number }

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
  | { type: 'image'; image: ParsedImagePart; attempt: number; lane: number }
  | { type: 'progress'; collected: number; attempts: number; cap: number }
  | { type: 'failure'; reason: string; attempts: number; cap: number; lane: number }
  | { type: 'lane'; lane: number; status: LaneStatus; reason?: string; backoffUntil?: number }

export interface RunSummary {
  result: 'complete' | 'cap-reached' | 'stopped' | 'error'
  collected: number
  attempts: number
  errorMessage?: string
}
