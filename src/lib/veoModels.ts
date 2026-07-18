import type { VideoSettings } from '../types'

export interface VeoModelInfo {
  id: string
  label: string
  description: string
  filenameSlug: string
  // Approximate USD per output second, used only for the cost estimate label
  pricePerSecond: { '720p': number; '1080p': number }
}

// All three Veo 3.1 tiers are paid preview — there is no free-tier video
// quota. IDs are preview names Google may rename at GA; keep them here only.
export const VEO_MODELS: VeoModelInfo[] = [
  {
    id: 'veo-3.1-generate-preview',
    label: 'Veo 3.1 Quality',
    description: 'Highest fidelity · ~$0.20–0.40/s',
    filenameSlug: 'veo31',
    pricePerSecond: { '720p': 0.2, '1080p': 0.4 },
  },
  {
    id: 'veo-3.1-fast-generate-preview',
    label: 'Veo 3.1 Fast',
    description: 'Faster, ~60% cheaper · ~$0.10–0.15/s',
    filenameSlug: 'veo31-fast',
    pricePerSecond: { '720p': 0.1, '1080p': 0.15 },
  },
  {
    id: 'veo-3.1-lite-generate-preview',
    label: 'Veo 3.1 Lite',
    description: 'Cheapest, great for drafts · ~$0.03–0.08/s',
    filenameSlug: 'veo31-lite',
    pricePerSecond: { '720p': 0.05, '1080p': 0.08 },
  },
]

export function getVeoModel(id: string): VeoModelInfo {
  return VEO_MODELS.find((m) => m.id === id) ?? VEO_MODELS[0]
}

// Rough per-video cost estimate — prices are approximate preview list prices
// and only meant to stop accidental expensive runs, not for billing math.
export function estimateVideoCost(settings: VideoSettings): number {
  const model = getVeoModel(settings.modelId)
  return model.pricePerSecond[settings.resolution] * settings.durationSeconds
}
