import type { GeneratedImage } from '../../types'
import { getModel } from '../../lib/models'
import { downloadBlob, makeFilename } from '../../lib/imageUtils'

interface Props {
  image: GeneratedImage
  index: number
  onOpen: () => void
}

export function ImageCard({ image, index, onOpen }: Props) {
  const time = new Date(image.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="group overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
      {image.kind === 'video' ? (
        // Played in place: a video needs its own controls, so no zoom-to-open
        <video
          src={image.objectUrl}
          controls
          loop
          playsInline
          preload="metadata"
          className="aspect-video w-full bg-black"
        />
      ) : (
        <button type="button" onClick={onOpen} className="block w-full cursor-zoom-in">
          <img
            src={image.objectUrl}
            alt={`Generated ${index + 1}`}
            loading="lazy"
            className="aspect-square w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        </button>
      )}
      <div className="flex items-center justify-between gap-2 px-2.5 py-2 text-[10px] text-zinc-500">
        <span className="truncate">
          {image.width}×{image.height}
          {image.kind === 'video' && image.duration ? ` · ${image.duration.toFixed(1)}s` : ''} ·{' '}
          {getModel(image.modelId).label} · attempt {image.attempt} · {time}
        </span>
        <button
          type="button"
          onClick={() => downloadBlob(image.blob, makeFilename(image, index))}
          className={`shrink-0 rounded px-1.5 py-0.5 text-zinc-400 transition-opacity hover:bg-zinc-700 hover:text-zinc-200 ${
            image.kind === 'video' ? '' : 'opacity-0 group-hover:opacity-100'
          }`}
          title="Download"
        >
          ↓ {image.kind === 'video' ? 'MP4' : image.format.toUpperCase()}
        </button>
      </div>
    </div>
  )
}
