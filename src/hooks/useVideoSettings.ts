import { useEffect, useRef, useState } from 'react'
import type { VideoSettings } from '../types'
import { loadVideoSettings, saveVideoSettings, loadApiKeys, saveApiKey, type ApiKeys, type ApiKeyIndex } from '../lib/storage'

// API keys are shared with the generator app (same localStorage entries), so
// keys entered once work in every tool.
export function useVideoSettings() {
  const [settings, setSettings] = useState<VideoSettings>(loadVideoSettings)
  const [apiKeys, setApiKeysState] = useState<ApiKeys>(loadApiKeys)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => saveVideoSettings(settings), 500)
    return () => clearTimeout(saveTimer.current)
  }, [settings])

  const update = (patch: Partial<VideoSettings>) => setSettings((prev) => ({ ...prev, ...patch }))

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
