import { useEffect, useMemo, useRef, useState } from 'react'
import type { Provider, Settings } from '../types'
import { loadSettings, saveSettings, loadApiKeys, saveApiKey, type ApiKeys, type ApiKeyIndex } from '../lib/storage'
import { getModel, getProvider } from '../lib/models'

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [geminiKeys, setGeminiKeys] = useState<ApiKeys>(() => loadApiKeys('gemini'))
  const [xaiKeys, setXaiKeys] = useState<ApiKeys>(() => loadApiKeys('xai'))
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => saveSettings(settings), 500)
    return () => clearTimeout(saveTimer.current)
  }, [settings])

  const provider = getProvider(settings.modelId)
  const apiKeys = provider === 'xai' ? xaiKeys : geminiKeys

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
        // A typed model-ID override belongs to the model it was typed for
        if (getProvider(patch.modelId) !== getProvider(prev.modelId)) next.xaiModelId = ''
      }
      return next
    })
  }

  // Wholesale swap from a synced file — API keys are not part of Settings and
  // therefore never travel with it
  const replaceSettings = (next: Settings) => setSettings(next)

  // Writes to whichever provider's key set is currently selected
  const setApiKey = (index: ApiKeyIndex, key: string) => {
    const setter = provider === 'xai' ? setXaiKeys : setGeminiKeys
    setter((prev) => {
      const next: ApiKeys = [...prev]
      next[index] = key
      return next
    })
    saveApiKey(index, key, provider)
  }

  const keysByProvider = useMemo<Record<Provider, ApiKeys>>(
    () => ({ gemini: geminiKeys, xai: xaiKeys }),
    [geminiKeys, xaiKeys],
  )

  return { settings, update, replaceSettings, provider, apiKeys, setApiKey, keysByProvider }
}
