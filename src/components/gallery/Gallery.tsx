import { useState } from 'react'
import type { GeneratedImage } from '../../types'
import { ImageCard } from './ImageCard'
import { Lightbox } from './Lightbox'
import { downloadAllAsZip } from '../../lib/imageUtils'

interface Props {
  images: GeneratedImage[]
  onClear: () => void
  isRunning: boolean
}

export function Gallery({ images, onClear, isRunning }: Props) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [zipping, setZipping] = useState(false)

  if (images.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-600">
        Generated images will appear here
      </div>
    )
  }

  return (
    <div className="flex-1">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs text-zinc-500">{images.length} image(s) this session</span>
        <div className="flex gap-2">
          {images.length >= 2 && (
            <button
              type="button"
              disabled={zipping}
              onClick={() => {
                setZipping(true)
                void downloadAllAsZip(images).finally(() => setZipping(false))
              }}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {zipping ? 'Zipping…' : 'Download all (.zip)'}
            </button>
          )}
          <button
            type="button"
            onClick={onClear}
            disabled={isRunning}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {images.map((image, i) => (
          <ImageCard key={image.id} image={image} index={i} onOpen={() => setLightboxIndex(i)} />
        ))}
      </div>
      {lightboxIndex !== null && (
        <Lightbox
          images={images}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
        />
      )}
    </div>
  )
}
