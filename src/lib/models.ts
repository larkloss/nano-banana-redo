export interface ModelInfo {
  id: string
  label: string
  description: string
  supportsImageSize: boolean
  aspectRatios: string[]
}

const BASE_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const EXTENDED_RATIOS = [...BASE_RATIOS, '1:4', '4:1', '1:8', '8:1']

export const MODELS: ModelInfo[] = [
  {
    id: 'gemini-3.1-flash-image',
    label: 'Nano Banana 2',
    description: 'Gemini 3.1 Flash Image · fast, up to 4K',
    supportsImageSize: true,
    aspectRatios: EXTENDED_RATIOS,
  },
  {
    id: 'gemini-3-pro-image-preview',
    label: 'Nano Banana Pro',
    description: 'Gemini 3 Pro Image · highest quality, up to 4K',
    supportsImageSize: true,
    aspectRatios: EXTENDED_RATIOS,
  },
  {
    id: 'gemini-2.5-flash-image',
    label: 'Nano Banana',
    description: 'Gemini 2.5 Flash Image · 1K only',
    supportsImageSize: false,
    aspectRatios: BASE_RATIOS,
  },
]

export function getModel(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]
}
