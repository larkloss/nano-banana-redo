import { useEffect, useRef, useState } from 'react'
import type { EditSettings } from '../types'
import { loadEditSettings, saveEditSettings } from '../lib/storage'
import { loadApiKeys, saveApiKey, type ApiKeys, type ApiKeyIndex } from '../../lib/storage'

export function useEditSettings() {
  const [settings, setSettings] = useState<EditSettings>(loadEditSettings)
  const [apiKeys, setApiKeysState] = useState<ApiKeys>(loadApiKeys)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => saveEditSettings(settings), 500)
    return () => clearTimeout(saveTimer.current)
  }, [settings])

  const update = (patch: Partial<EditSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
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
