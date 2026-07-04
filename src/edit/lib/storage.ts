import type { EditSettings } from '../types'
import { consumeCapMigration } from '../../lib/storage'

const EDIT_SETTINGS_KEY = 'nbr.edit.settings.v1'
const EDIT_CAP_MIGRATION_KEY = 'nbr.edit.capDefault50'

export const EDIT_MODELS = ['gemini-3.1-flash-image', 'gemini-3-pro-image-preview'] as const

export const DEFAULT_EDIT_SETTINGS: EditSettings = {
  modelId: EDIT_MODELS[0],
  imageSize: '1K',
  candidates: 1,
  attemptsCap: 50,
  feather: 12,
  seamless: true,
  format: 'png',
  prompt: '',
}

export function loadEditSettings(): EditSettings {
  const migrateCap = consumeCapMigration(EDIT_CAP_MIGRATION_KEY)
  try {
    const raw = localStorage.getItem(EDIT_SETTINGS_KEY)
    if (!raw) return DEFAULT_EDIT_SETTINGS
    const parsed = { ...DEFAULT_EDIT_SETTINGS, ...JSON.parse(raw) } as EditSettings
    if (!EDIT_MODELS.includes(parsed.modelId as (typeof EDIT_MODELS)[number])) {
      parsed.modelId = DEFAULT_EDIT_SETTINGS.modelId
    }
    if (!['1K', '2K', '4K'].includes(parsed.imageSize)) parsed.imageSize = '1K'
    if (parsed.format !== 'jpg') parsed.format = 'png'
    if (typeof parsed.prompt !== 'string') parsed.prompt = ''
    if (typeof parsed.seamless !== 'boolean') parsed.seamless = true
    parsed.candidates = clampInt(parsed.candidates, 1, 4, 1)
    parsed.attemptsCap = clampInt(parsed.attemptsCap, 1, 200, 50)
    parsed.feather = clampInt(parsed.feather, 0, 64, 12)
    if (migrateCap) {
      parsed.attemptsCap = DEFAULT_EDIT_SETTINGS.attemptsCap
      saveEditSettings(parsed)
    }
    return parsed
  } catch {
    return DEFAULT_EDIT_SETTINGS
  }
}

export function saveEditSettings(settings: EditSettings): void {
  try {
    localStorage.setItem(EDIT_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage full or unavailable — settings just won't persist
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : NaN
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
