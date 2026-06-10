import { useEffect, useRef, useState } from 'react'
import type { Settings } from '../types'
import { loadSettings, saveSettings, loadApiKeys, saveApiKey } from '../lib/storage'
import { getModel } from '../lib/models'

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [apiKeys, setApiKeysState] = useState<[string, string]>(loadApiKeys)
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

  const setApiKey = (index: 0 | 1, key: string) => {
    setApiKeysState((prev) => {
      const next: [string, string] = [...prev]
      next[index] = key
      return next
    })
    saveApiKey(index, key)
  }

  return { settings, update, apiKeys, setApiKey }
}
