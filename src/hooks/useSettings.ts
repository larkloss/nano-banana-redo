import { useEffect, useRef, useState } from 'react'
import type { Settings } from '../types'
import { loadSettings, saveSettings, loadApiKeys, saveApiKey, type ApiKeys, type ApiKeyIndex } from '../lib/storage'
import { getModel } from '../lib/models'

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [apiKeys, setApiKeysState] = useState<ApiKeys>(loadApiKeys)
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
      return next
    })
  }

  const setApiKey = (index: ApiKeyIndex, key: string) => {
    setApiKeysState((prev) => {
      const next: ApiKeys = [...prev]
      next[index] = key
      return next
    })
    saveApiKey(index, key)
  }

  return { settings, update, apiKeys, setApiKey }
}
