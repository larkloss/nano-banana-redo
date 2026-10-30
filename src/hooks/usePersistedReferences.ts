import { useEffect, useRef, useState } from 'react'
import type { ReferenceImage } from '../types'
import { loadStoredReferences, saveStoredReferences } from '../lib/refStore'
import { base64ToBlob } from '../lib/imageUtils'

// Drop-in replacement for useState<ReferenceImage[]> that restores references
// from IndexedDB on mount and persists every change, so a page reload doesn't
// lose the character reference photos.
export function usePersistedReferences(slot: string): [ReferenceImage[], (refs: ReferenceImage[]) => void] {
  const [references, setReferences] = useState<ReferenceImage[]>([])
  // No writes until the initial load resolves — otherwise the initial empty
  // state would wipe what's already stored.
  const loadedRef = useRef(false)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void loadStoredReferences(slot).then((stored) => {
      if (cancelled) return
      loadedRef.current = true
      if (stored.length === 0) return
      // If the user already added references before the load resolved, theirs win
      setReferences((prev) =>
        prev.length > 0
          ? prev
          : stored.map((s) => ({
              id: typeof s.id === 'string' ? s.id : crypto.randomUUID(),
              name: typeof s.name === 'string' ? s.name : 'reference',
              mimeType: s.mimeType,
              base64: s.base64,
              objectUrl: URL.createObjectURL(base64ToBlob(s.base64, s.mimeType)),
            })),
      )
    })
    return () => {
      cancelled = true
    }
  }, [slot])

  useEffect(() => {
    if (!loadedRef.current) return
    clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void saveStoredReferences(
        slot,
        references.map(({ id, name, mimeType, base64 }) => ({ id, name, mimeType, base64 })),
      )
    }, 400)
    return () => clearTimeout(saveTimer.current)
  }, [references, slot])

  return [references, setReferences]
}
