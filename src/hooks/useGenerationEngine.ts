import { useCallback, useState } from 'react'
import type { GeneratedImage, ReferenceImage, Settings } from '../types'
import { useRetryRun } from './useRetryRun'

// The generator's main run: retries until the target count is collected and
// keeps every result in the session gallery (newest first).
export function useGenerationEngine() {
  const { runState, start: startRun, stop, reset, isRunning } = useRetryRun()
  const [images, setImages] = useState<GeneratedImage[]>([])

  const addImage = useCallback((image: GeneratedImage) => {
    setImages((prev) => [image, ...prev])
  }, [])

  const start = useCallback(
    async (keys: string[], settings: Settings, references: ReferenceImage[]) => {
      await startRun(keys, settings, references, addImage)
    },
    [startRun, addImage],
  )

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id))
  }, [])

  // Object URLs are not revoked here: the edit studio may still be showing
  // these images as versions. They are released when the tab closes.
  const clearImages = useCallback(() => {
    setImages([])
    reset()
  }, [reset])

  return { runState, images, start, stop, addImage, removeImage, clearImages, isRunning }
}
