import type { GeneratedImage } from '../../types'
import { getModel } from '../../lib/models'
import { downloadBlob, makeFilename } from '../../lib/imageUtils'

interface Props {
  image: GeneratedImage
  index: number
  onOpen: () => void
  // Absent for videos — only stills can go into the edit studio
  onEdit?: () => void
}

export function ImageCard({ image, index, onOpen, onEdit }: Props) {
  const time = new Date(image.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="soft-shadow group overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
      <div className="relative">
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
          <button type="button" onClick={onOpen} className="block w-full cursor-zoom-in overflow-hidden">
            <img
              src={image.objectUrl}
              alt={`Generated ${index + 1}`}
              loading="lazy"
              className="aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
          </button>
        )}
        {image.edit && (
          <span
            className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white"
            title={`Edit: ${image.edit.prompt}`}
          >
            ✏️ v{image.edit.version}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-zinc-500"
          title={`${image.width}×${image.height} · ${getModel(image.modelId).label} · attempt ${image.attempt} · ${time}`}
        >
          {getModel(image.modelId).label} · {time}
        </span>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 rounded-full bg-blue-500/15 px-2.5 py-1 text-[11px] font-medium text-blue-300 hover:bg-blue-500/25"
            title="Keep editing this picture with new instructions"
          >
            ✏️ Edit
          </button>
        )}
        <button
          type="button"
          onClick={() => downloadBlob(image.blob, makeFilename(image, index))}
          className="shrink-0 rounded-full px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          title={`Download ${image.kind === 'video' ? 'MP4' : image.format.toUpperCase()}`}
        >
          ↓
        </button>
      </div>
    </div>
  )
}
