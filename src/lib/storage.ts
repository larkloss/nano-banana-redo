import type { Settings } from '../types'
import { MODELS, getModel } from './models'

const SETTINGS_KEY = 'nbr.settings.v1'
const API_KEY_KEYS = ['nbr.apiKey', 'nbr.apiKey2', 'nbr.apiKey3'] as const

export type ApiKeys = [string, string, string]
export type ApiKeyIndex = 0 | 1 | 2

export const DEFAULT_SETTINGS: Settings = {
  modelId: MODELS[0].id,
  systemInstruction: '',
  aspectRatio: 'auto',
  imageSize: '1K',
  format: 'png',
  targetCount: 5,
  attemptsCap: 15,
  prompt: '',
}

export function loadSettings(): Settings {
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
    parsed.attemptsCap = clampInt(parsed.attemptsCap, 1, 50, 15)
    return parsed
  } catch {
    return DEFAULT_SETTINGS
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
