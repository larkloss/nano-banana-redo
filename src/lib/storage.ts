import type { PromptModule, PromptWorkspace, Settings } from '../types'
import { MODELS, getModel } from './models'

const SETTINGS_KEY = 'nbr.settings.v1'
const API_KEY_KEYS = ['nbr.apiKey', 'nbr.apiKey2', 'nbr.apiKey3'] as const
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
  format: 'png',
  targetCount: 5,
  attemptsCap: 50,
  prompt: '',
}

export function loadSettings(): Settings {
  const migrateCap = consumeCapMigration(CAP_MIGRATION_KEY)
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings
    if (!MODELS.some((m) => m.id === parsed.modelId)) parsed.modelId = DEFAULT_SETTINGS.modelId
    const model = getModel(parsed.modelId)
    if (parsed.aspectRatio !== 'auto' && !model.aspectRatios.includes(parsed.aspectRatio)) {
      parsed.aspectRatio = 'auto'
    }
    if (!['1K', '2K', '4K'].includes(parsed.imageSize)) parsed.imageSize = '1K'
    if (parsed.format !== 'jpg') parsed.format = 'png'
    if (typeof parsed.systemInstruction !== 'string') parsed.systemInstruction = ''
    parsed.targetCount = clampInt(parsed.targetCount, 1, 12, 5)
    parsed.attemptsCap = clampInt(parsed.attemptsCap, 1, 200, 50)
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

export function defaultWorkspace(): PromptWorkspace {
  return {
    mode: 'modular',
    modules: DEFAULT_MODULE_NAMES.map((name) => emptyModule(name)),
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

export function loadPromptWorkspace(): PromptWorkspace {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY)
    if (!raw) return defaultWorkspace()
    const parsed = JSON.parse(raw) as PromptWorkspace
    if (parsed.mode !== 'simple' && parsed.mode !== 'modular') parsed.mode = 'modular'
    if (!Array.isArray(parsed.modules)) return defaultWorkspace()
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
    return defaultWorkspace()
  }
}

export function savePromptWorkspace(workspace: PromptWorkspace): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace))
  } catch {
    // storage full or unavailable — workspace just won't persist
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

export function loadApiKeys(): ApiKeys {
  try {
    return [
      localStorage.getItem(API_KEY_KEYS[0]) ?? '',
      localStorage.getItem(API_KEY_KEYS[1]) ?? '',
      localStorage.getItem(API_KEY_KEYS[2]) ?? '',
    ]
  } catch {
    return ['', '', '']
  }
}

export function saveApiKey(index: ApiKeyIndex, key: string): void {
  try {
    if (key) localStorage.setItem(API_KEY_KEYS[index], key)
    else localStorage.removeItem(API_KEY_KEYS[index])
  } catch {
    // ignore
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : NaN
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
