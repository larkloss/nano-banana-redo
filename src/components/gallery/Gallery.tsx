import { useState } from 'react'
import type { GeneratedImage } from '../../types'
import { ImageCard } from './ImageCard'
import { Lightbox } from './Lightbox'
import { downloadAllAsZip } from '../../lib/imageUtils'

interface Props {
  images: GeneratedImage[]
  onClear: () => void
  onEdit: (image: GeneratedImage) => void
  isRunning: boolean
}

export function Gallery({ images, onClear, onEdit, isRunning }: Props) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [zipping, setZipping] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  if (images.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-zinc-800 px-6 py-14 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-900 text-2xl">🍌</span>
        <p className="text-sm font-medium text-zinc-300">Your pictures will show up here</p>
        <p className="max-w-sm text-xs text-zinc-500">
          Write a prompt, press Generate, and grab a coffee — refused attempts are retried for you. Click
          “Edit” on any picture to keep refining it.
        </p>
      </div>
    )
  }

  const editable = (image: GeneratedImage) => (image.kind === 'image' ? () => onEdit(image) : undefined)

  return (
    <div className="flex-1">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-200">
          Your pictures <span className="font-normal text-zinc-500">· {images.length} this session</span>
        </h2>
        <div className="flex gap-2">
          {images.length >= 2 && (
            <button
              type="button"
              disabled={zipping}
              onClick={() => {
                setZipping(true)
                void downloadAllAsZip(images).finally(() => setZipping(false))
              }}
              className="rounded-full border border-zinc-700 px-3.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {zipping ? 'Zipping…' : '↓ Download all'}
            </button>
          )}
          {confirmClear ? (
            <span className="flex items-center gap-1 rounded-full border border-red-500/40 px-1 py-0.5 text-xs">
              <span className="px-1.5 text-zinc-400">Remove all?</span>
              <button
                type="button"
                onClick={() => {
                  setConfirmClear(false)
                  onClear()
                }}
                className="rounded-full bg-red-600 px-2.5 py-1 text-white hover:bg-red-500"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="rounded-full px-2.5 py-1 text-zinc-400 hover:bg-zinc-800"
              >
                No
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={isRunning}
              className="rounded-full border border-zinc-700 px-3.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {images.map((image, i) => (
          <ImageCard
            key={image.id}
            image={image}
            index={i}
            onOpen={() => setLightboxIndex(i)}
            onEdit={editable(image)}
          />
        ))}
      </div>
      {lightboxIndex !== null && (
        <Lightbox
          images={images}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onEdit={(image) => {
            setLightboxIndex(null)
            onEdit(image)
          }}
        />
      )}
    </div>
  )
}
