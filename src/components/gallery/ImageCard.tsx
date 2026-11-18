import { useRef } from 'react'
import type { GeneratedImage } from '../../types'
import { getModel } from '../../lib/models'
import { downloadImage, saveFormat, sourceLabel } from '../../lib/imageUtils'

interface Props {
  image: GeneratedImage
  index: number
  onOpen: () => void
  // Absent for videos — only stills can go into the edit studio
  onEdit?: () => void
}

export function ImageCard({ image, index, onOpen, onEdit }: Props) {
  const time = new Date(image.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  // The card shows a reduced copy (a 4K picture decoded for every card made
  // the page stall), but whatever takes the picture out of the page — a drag
  // to the desktop, "Save image as", "Copy image" — must take the picture
  // itself. So the picture itself is put in the moment a button goes down on
  // it, before any of those can start, and the copy comes back once that was
  // only a click or the drag is over.
  const picture = useRef<HTMLImageElement>(null)
  const show = (url: string | undefined) => {
    const img = picture.current
    if (img && url && image.cardUrl && img.getAttribute('src') !== url) img.src = url
  }
  const showItself = () => show(image.objectUrl)
  const showCopy = () => show(image.cardUrl)

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
          <button
            type="button"
            onClick={() => {
              showCopy()
              onOpen()
            }}
            onPointerDown={showItself}
            onContextMenu={showItself}
            onDragStart={showItself}
            onDragEnd={showCopy}
            className="block w-full cursor-zoom-in overflow-hidden"
          >
            <img
              ref={picture}
              src={image.cardUrl ?? image.objectUrl}
              // (where the picture itself is, for the checks in tools/e2e)
              data-full={image.objectUrl}
              alt={image.uploaded ? `Uploaded ${index + 1}` : `Generated ${index + 1}`}
              loading="lazy"
              className="aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
          </button>
        )}
        {image.uploaded && (
          <span
            className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white"
            title={image.uploaded.name}
          >
            ⬆ Uploaded
          </span>
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
          title={
            image.uploaded
              ? `${image.uploaded.name} · ${image.width}×${image.height} · ${time}`
              : `${image.width}×${image.height} · ${getModel(image.modelId).label} · attempt ${image.attempt} · ${time}`
          }
        >
          {sourceLabel(image)} · {time}
        </span>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 rounded-full bg-blue-500/15 px-2.5 py-1 text-[11px] font-medium text-blue-300 hover:bg-blue-500/25"
            title={image.uploaded ? 'Edit this picture' : 'Keep editing this picture with new instructions'}
          >
            ✏️ Edit
          </button>
        )}
        <button
          type="button"
          onClick={() => void downloadImage(image, index)}
          className="shrink-0 rounded-full px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          title={`Download ${saveFormat(image)}`}
        >
          ↓
        </button>
      </div>
    </div>
  )
}
