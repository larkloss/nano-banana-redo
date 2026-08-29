import type { Provider } from '../types'

export interface ModelInfo {
  id: string
  label: string
  description: string
  provider: Provider
  // Video models return an mp4 instead of a still, which changes the prompt
  // editor (one whole box), the option set and how results are displayed
  output: 'image' | 'video'
  supportsImageSize: boolean
  supportsThinking: boolean
  supportsSystemInstruction: boolean
  // xAI exposes a 1k/2k resolution switch instead of Gemini's 1K/2K/4K sizes
  supportsResolution: boolean
  // Reference images: Gemini takes them inline; xAI routes them through a
  // separate image-editing endpoint that this app doesn't call yet
  supportsReferences: boolean
  aspectRatios: string[]
  // Short tag used in downloaded filenames, e.g. abigail-<filenameSlug>_<timestamp>_01.png
  filenameSlug: string
}

const BASE_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const EXTENDED_RATIOS = [...BASE_RATIOS, '1:4', '4:1', '1:8', '8:1']
// xAI's documented set (plus the shared "Auto" chip, which maps to aspect_ratio: auto)
const XAI_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '2:1',
  '1:2',
  '19.5:9',
  '9:19.5',
  '20:9',
  '9:20',
]

const OMNI_RATIOS = ['16:9', '9:16']

export const OMNI_RESOLUTIONS = ['360p', '720p', '1080p', '4k'] as const

export const MODELS: ModelInfo[] = [
  {
    id: 'gemini-3.1-flash-image',
    label: 'Nano Banana 2',
    description: 'Gemini 3.1 Flash Image · fast, up to 4K · high thinking',
    provider: 'gemini',
    output: 'image',
    supportsImageSize: true,
    supportsThinking: true,
    supportsSystemInstruction: true,
    supportsResolution: false,
    supportsReferences: true,
    aspectRatios: EXTENDED_RATIOS,
    filenameSlug: 'nano-banana-2',
  },
  {
    id: 'gemini-3-pro-image-preview',
    label: 'Nano Banana Pro',
    description: 'Gemini 3 Pro Image · highest quality, up to 4K',
    provider: 'gemini',
    output: 'image',
    supportsImageSize: true,
    supportsThinking: false,
    supportsSystemInstruction: true,
    supportsResolution: false,
    supportsReferences: true,
    aspectRatios: EXTENDED_RATIOS,
    filenameSlug: 'pro',
  },
  {
    id: 'gemini-2.5-flash-image',
    label: 'Nano Banana',
    description: 'Gemini 2.5 Flash Image · 1K only',
    provider: 'gemini',
    output: 'image',
    supportsImageSize: false,
    supportsThinking: false,
    supportsSystemInstruction: true,
    supportsResolution: false,
    supportsReferences: true,
    aspectRatios: BASE_RATIOS,
    filenameSlug: 'nano-banana',
  },
  {
    id: 'gemini-omni-1.1-flash',
    label: 'Gemini Omni 1.1 Flash',
    description: 'Video with audio · 360p draft → 4K · uses your Gemini key',
    provider: 'gemini',
    output: 'video',
    supportsImageSize: false,
    supportsThinking: false,
    // Omni rejects system instructions, temperature and negative prompts —
    // negatives go in the prompt itself ("no dialogue", "no scene cuts")
    supportsSystemInstruction: false,
    supportsResolution: false,
    supportsReferences: true,
    aspectRatios: OMNI_RATIOS,
    filenameSlug: 'omni',
  },
  {
    id: 'grok-imagine-image-2.0',
    label: 'Grok Imagine 2.0',
    description: 'xAI Imagine 2.0 · newest · adds a low/medium quality switch',
    provider: 'xai',
    output: 'image',
    supportsImageSize: false,
    supportsThinking: false,
    supportsSystemInstruction: false,
    supportsResolution: true,
    supportsReferences: true,
    aspectRatios: XAI_RATIOS,
    filenameSlug: 'grok2',
  },
  {
    id: 'grok-imagine-image-quality',
    label: 'Grok Imagine Quality',
    description: 'xAI Imagine · $0.05/image · 1k/2k · needs an xAI key',
    provider: 'xai',
    output: 'image',
    supportsImageSize: false,
    supportsThinking: false,
    supportsSystemInstruction: false,
    supportsResolution: true,
    supportsReferences: true,
    aspectRatios: XAI_RATIOS,
    filenameSlug: 'grok-quality',
  },
  {
    id: 'grok-imagine-image',
    label: 'Grok Imagine',
    description: 'xAI Imagine · $0.02/image · cheaper drafts',
    provider: 'xai',
    output: 'image',
    supportsImageSize: false,
    supportsThinking: false,
    supportsSystemInstruction: false,
    supportsResolution: true,
    supportsReferences: true,
    aspectRatios: XAI_RATIOS,
    filenameSlug: 'grok',
  },
]

export function getModel(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]
}

export function getProvider(id: string): Provider {
  return getModel(id).provider
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  gemini: 'Google Gemini',
  xai: 'xAI Grok',
}
