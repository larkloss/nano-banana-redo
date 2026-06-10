import { useEffect, useRef, useState } from 'react'
import type { Settings } from '../types'
import { loadSettings, saveSettings, loadApiKey, saveApiKey } from '../lib/storage'
import { getModel } from '../lib/models'

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [apiKey, setApiKeyState] = useState<string>(loadApiKey)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => saveSettings(settings), 500)
    return () => clearTimeout(saveTimer.current)
  }, [settings])

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      // Keep dependent fields valid when the model changes
      if (patch.modelId && patch.modelId !== prev.modelId) {
        const model = getModel(patch.modelId)
        if (next.aspectRatio !== 'auto' && !model.aspectRatios.includes(next.aspectRatio)) {
          next.aspectRatio = 'auto'
        }
        if (!model.supportsImageSize) next.imageSize = '1K'
      }
      // Suggest a proportional attempts cap when target count changes
      if (patch.targetCount !== undefined && patch.attemptsCap === undefined) {
        next.attemptsCap = Math.min(50, Math.max(next.targetCount, patch.targetCount * 3))
      }
      return next
    })
  }

  const setApiKey = (key: string) => {
    setApiKeyState(key)
    saveApiKey(key)
  }

  return { settings, update, apiKey, setApiKey }
}
