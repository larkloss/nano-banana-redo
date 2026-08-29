import type { PromptModule, PromptWorkspace, Provider, Settings, VideoSettings } from '../types'
import { MODELS, getModel } from './models'
import { VEO_MODELS } from './veoModels'

const SETTINGS_KEY = 'nbr.settings.v1'
// Per-provider key sets — a Gemini key and an xAI key are stored side by side
// so switching models never means re-entering credentials.
const PROVIDER_KEY_NAMES: Record<Provider, readonly [string, string, string]> = {
  gemini: ['nbr.apiKey', 'nbr.apiKey2', 'nbr.apiKey3'],
  xai: ['nbr.xaiApiKey', 'nbr.xaiApiKey2', 'nbr.xaiApiKey3'],
}
// One-shot marker: bumps previously-persisted attempts caps to the new
// default of 50 without resetting any other stored settings
const CAP_MIGRATION_KEY = 'nbr.capDefault50'

export type ApiKeys = [string, string, string]
export type ApiKeyIndex = 0 | 1 | 2

export const DEFAULT_SETTINGS: Settings = {
  modelId: MODELS[0].id,
  systemInstruction: '',
  aspectRatio: 'auto',
  imageSize: '1K',
  xaiResolution: '1k',
  xaiQuality: 'medium',
  omniResolution: '720p',
  xaiModelId: '',
  format: 'png',
  targetCount: 5,
  attemptsCap: 50,
  prompt: '',
}

// Shared by localStorage loading and by settings adopted from a synced file,
// so anything hand-edited or written by an older version is clamped the same
// way. Never carries API keys — those live in their own storage entries.
export function normalizeSettings(raw: unknown): Settings {
  const parsed = { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings>) } as Settings
  if (!MODELS.some((m) => m.id === parsed.modelId)) parsed.modelId = DEFAULT_SETTINGS.modelId
  const model = getModel(parsed.modelId)
  if (parsed.aspectRatio !== 'auto' && !model.aspectRatios.includes(parsed.aspectRatio)) {
    parsed.aspectRatio = 'auto'
  }
  if (!['1K', '2K', '4K'].includes(parsed.imageSize)) parsed.imageSize = '1K'
  if (parsed.xaiResolution !== '2k') parsed.xaiResolution = '1k'
  if (parsed.xaiQuality !== 'low') parsed.xaiQuality = 'medium'
  if (!['360p', '720p', '1080p', '4k'].includes(parsed.omniResolution)) parsed.omniResolution = '720p'
  if (typeof parsed.xaiModelId !== 'string') parsed.xaiModelId = ''
  if (parsed.format !== 'jpg') parsed.format = 'png'
  if (typeof parsed.systemInstruction !== 'string') parsed.systemInstruction = ''
  if (typeof parsed.prompt !== 'string') parsed.prompt = ''
  parsed.targetCount = clampInt(parsed.targetCount, 1, 12, 5)
  parsed.attemptsCap = clampInt(parsed.attemptsCap, 1, 200, 50)
  return parsed
}

export function loadSettings(): Settings {
  const migrateCap = consumeCapMigration(CAP_MIGRATION_KEY)
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = normalizeSettings(JSON.parse(raw))
    if (migrateCap) {
      parsed.attemptsCap = DEFAULT_SETTINGS.attemptsCap
      saveSettings(parsed)
    }
    return parsed
  } catch {
    return DEFAULT_SETTINGS
  }
}

const WORKSPACE_KEY = 'nbr.promptModules.v1'
export const VIDEO_WORKSPACE_KEY = 'nbr.videoPromptModules.v1'

// Only module NAMES are seeded — content stays empty so nothing personal ever
// lands in the repo; the user pastes their template once (or uses the
// import-split dialog) and it persists in localStorage.
const DEFAULT_MODULE_NAMES = [
  'Style & Quality',
  'Core Subject',
  'Hair',
  'Outfit Top',
  'Outfit Skirt',
  'Shoes',
  'Bag',
  'Pose & Environment',
]

export const VIDEO_MODULE_NAMES = [
  'Style & Quality',
  'Core Subject',
  'Wardrobe',
  'Action & Camera',
  'Environment',
  'Audio',
]

export function defaultWorkspace(defaultNames: string[] = DEFAULT_MODULE_NAMES): PromptWorkspace {
  return {
    mode: 'modular',
    modules: defaultNames.map((name) => emptyModule(name)),
  }
}

export function emptyModule(name: string, text = ''): PromptModule {
  return {
    id: crypto.randomUUID(),
    name,
    enabled: true,
    text,
    variants: [],
    activeVariantId: null,
    collapsed: false,
  }
}

export function loadPromptWorkspace(
  storageKey: string = WORKSPACE_KEY,
  defaultNames: string[] = DEFAULT_MODULE_NAMES,
): PromptWorkspace {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return defaultWorkspace(defaultNames)
    const parsed = JSON.parse(raw) as PromptWorkspace
    if (parsed.mode !== 'simple' && parsed.mode !== 'modular') parsed.mode = 'modular'
    if (!Array.isArray(parsed.modules)) return defaultWorkspace(defaultNames)
    parsed.modules = parsed.modules
      .filter((m) => m && typeof m === 'object')
      .map((m) => ({
        id: typeof m.id === 'string' ? m.id : crypto.randomUUID(),
        name: typeof m.name === 'string' ? m.name : 'Module',
        enabled: m.enabled !== false,
        text: typeof m.text === 'string' ? m.text : '',
        variants: Array.isArray(m.variants)
          ? m.variants
              .filter((v) => v && typeof v.text === 'string')
              .map((v) => ({
                id: typeof v.id === 'string' ? v.id : crypto.randomUUID(),
                name: typeof v.name === 'string' ? v.name : 'Variant',
                text: v.text,
              }))
          : [],
        activeVariantId: typeof m.activeVariantId === 'string' ? m.activeVariantId : null,
        collapsed: m.collapsed === true,
      }))
    return parsed
  } catch {
    return defaultWorkspace(defaultNames)
  }
}

export function savePromptWorkspace(workspace: PromptWorkspace, storageKey: string = WORKSPACE_KEY): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(workspace))
  } catch {
    // storage full or unavailable — workspace just won't persist
  }
}

const VIDEO_SETTINGS_KEY = 'nbr.videoSettings.v1'

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  modelId: VEO_MODELS[2].id, // Lite by default — cheapest, safe for experimenting
  aspectRatio: '16:9',
  resolution: '720p',
  durationSeconds: 8,
  generateAudio: true,
  negativePrompt: '',
  seed: null,
  personGeneration: 'allow_adult',
  enhancePrompt: true,
  inputMode: 'references',
  // Videos cost real money per attempt — default to a single one per run
  targetCount: 1,
  attemptsCap: 5,
  prompt: '',
}

export function loadVideoSettings(): VideoSettings {
  try {
    const raw = localStorage.getItem(VIDEO_SETTINGS_KEY)
    if (!raw) return DEFAULT_VIDEO_SETTINGS
    const parsed = { ...DEFAULT_VIDEO_SETTINGS, ...JSON.parse(raw) } as VideoSettings
    if (!VEO_MODELS.some((m) => m.id === parsed.modelId)) parsed.modelId = DEFAULT_VIDEO_SETTINGS.modelId
    if (parsed.aspectRatio !== '9:16') parsed.aspectRatio = '16:9'
    if (parsed.resolution !== '1080p') parsed.resolution = '720p'
    if (![4, 6, 8].includes(parsed.durationSeconds)) parsed.durationSeconds = 8
    parsed.generateAudio = parsed.generateAudio !== false
    if (typeof parsed.negativePrompt !== 'string') parsed.negativePrompt = ''
    if (typeof parsed.seed !== 'number' || !Number.isFinite(parsed.seed)) parsed.seed = null
    if (parsed.personGeneration !== 'dont_allow') parsed.personGeneration = 'allow_adult'
    parsed.enhancePrompt = parsed.enhancePrompt !== false
    if (parsed.inputMode !== 'frames') parsed.inputMode = 'references'
    parsed.targetCount = clampInt(parsed.targetCount, 1, 8, 1)
    parsed.attemptsCap = clampInt(parsed.attemptsCap, 1, 50, 5)
    if (typeof parsed.prompt !== 'string') parsed.prompt = ''
    return parsed
  } catch {
    return DEFAULT_VIDEO_SETTINGS
  }
}

export function saveVideoSettings(settings: VideoSettings): void {
  try {
    localStorage.setItem(VIDEO_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage full or unavailable — settings just won't persist
  }
}

// Returns true exactly once per browser profile, then never again — so the
// new default is applied to already-persisted settings a single time and any
// later user choice sticks.
export function consumeCapMigration(markerKey: string): boolean {
  try {
    if (localStorage.getItem(markerKey)) return false
    localStorage.setItem(markerKey, '1')
    return true
  } catch {
    return false
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage full or unavailable — settings just won't persist
  }
}

export function loadApiKeys(provider: Provider = 'gemini'): ApiKeys {
  const names = PROVIDER_KEY_NAMES[provider]
  try {
    return [
      localStorage.getItem(names[0]) ?? '',
      localStorage.getItem(names[1]) ?? '',
      localStorage.getItem(names[2]) ?? '',
    ]
  } catch {
    return ['', '', '']
  }
}

export function saveApiKey(index: ApiKeyIndex, key: string, provider: Provider = 'gemini'): void {
  try {
    const name = PROVIDER_KEY_NAMES[provider][index]
    if (key) localStorage.setItem(name, key)
    else localStorage.removeItem(name)
  } catch {
    // ignore
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : NaN
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
