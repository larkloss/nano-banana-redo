import { useEffect, useRef, useState } from 'react'
import type { EditSettings } from '../types'
import { loadEditSettings, saveEditSettings } from '../lib/storage'
import { loadApiKeys, saveApiKey } from '../../lib/storage'

export function useEditSettings() {
  const [settings, setSettings] = useState<EditSettings>(loadEditSettings)
  const [apiKeys, setApiKeysState] = useState<[string, string]>(loadApiKeys)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => saveEditSettings(settings), 500)
    return () => clearTimeout(saveTimer.current)
  }, [settings])

  const update = (patch: Partial<EditSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
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
