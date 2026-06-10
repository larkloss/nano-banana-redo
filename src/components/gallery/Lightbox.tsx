import { useEffect } from 'react'
import type { GeneratedImage } from '../../types'
import { downloadBlob, makeFilename } from '../../lib/imageUtils'

interface Props {
  images: GeneratedImage[]
  index: number
  onClose: () => void
  onNavigate: (index: number) => void
}

export function Lightbox({ images, index, onClose, onNavigate }: Props) {
  const image = images[index]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1)
      if (e.key === 'ArrowRight' && index < images.length - 1) onNavigate(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images.length, onClose, onNavigate])

  if (!image) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
      onClick={onClose}
    >
      <div className="relative max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
        <img
          src={image.objectUrl}
          alt={`Generated ${index + 1}`}
          className="max-h-[85vh] max-w-full rounded-lg object-contain"
        />
        <div className="absolute -top-9 right-0 flex items-center gap-3 text-xs text-zinc-300">
          <span>
            {index + 1}/{images.length} · {image.width}×{image.height}
          </span>
          <button
            type="button"
            onClick={() => downloadBlob(image.blob, makeFilename(image, index))}
            className="rounded-md bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"
          >
            Download
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"
          >
            ✕
          </button>
        </div>
        {index > 0 && (
          <NavButton side="left" onClick={() => onNavigate(index - 1)} />
        )}
        {index < images.length - 1 && (
          <NavButton side="right" onClick={() => onNavigate(index + 1)} />
        )}
      </div>
    </div>
  )
}

function NavButton({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`absolute top-1/2 -translate-y-1/2 rounded-full bg-zinc-800/80 p-3 text-zinc-200 hover:bg-zinc-700 ${
        side === 'left' ? '-left-14' : '-right-14'
      }`}
    >
      {side === 'left' ? '←' : '→'}
    </button>
  )
}
