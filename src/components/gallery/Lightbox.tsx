import { useEffect } from 'react'
import type { GeneratedImage } from '../../types'
import { downloadImage } from '../../lib/imageUtils'
import { useZoom } from '../common/useZoom'
import { ZoomButtons, ZoomPane } from '../common/ZoomPane'

interface Props {
  images: GeneratedImage[]
  index: number
  onClose: () => void
  onNavigate: (index: number) => void
  onEdit?: (image: GeneratedImage) => void
}

// The gallery's large view of one picture. A picture can be zoomed to look at
// its details (buttons in the corner, + − 0, Ctrl + wheel, two fingers, double
// click for real size) and dragged around while zoomed; another picture starts
// at fit again.

// Room to scroll a zoomed picture past its top and bottom edges, out from
// under the buttons
const OVERSCROLL = 64

export function Lightbox({ images, index, onClose, onNavigate, onEdit }: Props) {
  const image = images[index]
  const { zoom, sizerRef, paneRef, contentRef } = useZoom({ resetKey: image?.id, overscroll: OVERSCROLL })
  // Zoomed in, the picture has the whole window and the buttons move to its edges
  const zoomed = zoom.zoomed

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
  const alt = image.uploaded ? `Uploaded ${index + 1}` : `Generated ${index + 1}`

  return (
    <div
      // (Ctrl + wheel zooms the picture from anywhere in here: see useZoom)
      data-zoom-scope
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
      onClick={onClose}
    >
      {image.kind !== 'video' && (
        <ZoomPane zoom={zoom} paneRef={paneRef} contentRef={contentRef}>
          <img
            src={image.objectUrl}
            alt={alt}
            draggable={false}
            // (square corners once zoomed in: the picture's own corners are part
            // of what is looked at — and a hand, as it can be dragged around)
            className={`block h-full w-full select-none object-contain ${
              !zoomed ? 'rounded-2xl' : zoom.hand === 'dragging' ? '' : 'cursor-grab'
            }`}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => zoom.toggle({ x: e.clientX, y: e.clientY })}
          />
        </ZoomPane>
      )}
      {/* Clicks pass through this box to the picture in the pane behind it; its own buttons take theirs */}
      <div
        className={`pointer-events-none max-h-full max-w-full ${zoomed ? '' : 'relative'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {image.kind === 'video' ? (
          <video
            src={image.objectUrl}
            controls
            autoPlay
            loop
            playsInline
            className="pointer-events-auto max-h-[85vh] max-w-full rounded-lg bg-black"
          />
        ) : (
          // Laid out exactly as the picture was before it could be zoomed, and
          // never seen: its box is the fitted size, and the buttons around the
          // fitted picture hang on it
          <img
            ref={sizerRef}
            src={image.objectUrl}
            alt=""
            aria-hidden
            draggable={false}
            className="invisible max-h-[85vh] max-w-full object-contain"
          />
        )}
        <div
          className={`pointer-events-auto absolute flex items-center gap-2 text-xs text-white/80 ${
            zoomed ? 'right-4 top-4 rounded-full bg-black/70 py-1 pl-3.5 pr-1' : '-top-10 right-0'
          }`}
        >
          <span>
            {index + 1}/{images.length} · {image.width}×{image.height}
          </span>
          {onEdit && image.kind === 'image' && (
            <button
              type="button"
              onClick={() => onEdit(image)}
              className="rounded-full bg-blue-600 px-3.5 py-1.5 font-medium text-white hover:bg-blue-500"
            >
              ✏️ Edit this picture
            </button>
          )}
          <button
            type="button"
            onClick={() => void downloadImage(image, index)}
            className="rounded-full bg-white/10 px-3.5 py-1.5 text-white hover:bg-white/20"
          >
            Download
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white/10 px-3 py-1.5 text-white hover:bg-white/20"
          >
            ✕
          </button>
        </div>
        {index > 0 && (
          <NavButton side="left" overPicture={zoomed} onClick={() => onNavigate(index - 1)} />
        )}
        {index < images.length - 1 && (
          <NavButton side="right" overPicture={zoomed} onClick={() => onNavigate(index + 1)} />
        )}
      </div>
      {image.kind !== 'video' && <ZoomButtons zoom={zoom} className="absolute bottom-5 right-5" />}
    </div>
  )
}

interface NavProps {
  side: 'left' | 'right'
  // Beside the fitted picture, or — over a zoomed one — at the window's edge on a darker disc
  overPicture: boolean
  onClick: () => void
}

function NavButton({ side, overPicture, onClick }: NavProps) {
  const place = overPicture
    ? `bg-black/70 hover:bg-black/90 ${side === 'left' ? 'left-4' : 'right-4'}`
    : `bg-white/10 hover:bg-white/20 ${side === 'left' ? '-left-14' : '-right-14'}`
  return (
    <button
      type="button"
      onClick={onClick}
      title={side === 'left' ? 'Previous picture (← key)' : 'Next picture (→ key)'}
      aria-label={side === 'left' ? 'Previous picture' : 'Next picture'}
      className={`pointer-events-auto absolute top-1/2 -translate-y-1/2 rounded-full p-3 text-white ${place}`}
    >
      {side === 'left' ? '←' : '→'}
    </button>
  )
}
