import type { ReactNode, Ref } from 'react'
import type { Zoom } from './useZoom'

// The scrolling pane a zoomed picture lives in. It covers its positioned
// parent; the picture (and whatever is drawn on it) goes in as children and
// gets a box of the fitted size times the zoom — centred while that is
// smaller than the pane, scrolled once it is larger.
interface PaneProps {
  zoom: Zoom
  // From the same useZoom call
  paneRef: Ref<HTMLDivElement>
  contentRef: Ref<HTMLDivElement>
  children: ReactNode
}

export function ZoomPane({ zoom, paneRef, contentRef, children }: PaneProps) {
  return (
    <div
      ref={paneRef}
      data-zoom-pane
      // touch-none: two fingers pinch the picture, not the page
      className="absolute inset-0 touch-none"
      style={{
        // (at fit there is nothing to scroll, and no scrollbar may appear over a rounding error)
        overflow: zoom.zoomed ? 'auto' : 'hidden',
        // The scroll position is set by hand after each zoom step
        overflowAnchor: 'none',
        cursor: zoom.hand === 'dragging' ? 'grabbing' : zoom.hand === 'ready' ? 'grab' : undefined,
      }}
    >
      {/* At least as large as the pane, so the auto margins centre a small picture */}
      <div className="box-border flex min-h-full w-max min-w-full" style={{ paddingBlock: zoom.overscroll }}>
        <div ref={contentRef} className="relative m-auto flex-none" style={{ width: zoom.width, height: zoom.height }}>
          {children}
        </div>
      </div>
    </div>
  )
}

// The buttons: − 46% + Fit 100%. The number is the share of the picture's own
// pixels: at 100% one picture pixel takes one screen pixel.
export function ZoomButtons({ zoom, className = '' }: { zoom: Zoom; className?: string }) {
  if (!zoom.fit) return null
  // 32px for a mouse, 40px for a finger
  const button =
    'flex h-8 min-w-8 touch-manipulation items-center justify-center rounded-full px-2 hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent pointer-coarse:h-10 pointer-coarse:min-w-10'
  return (
    <div
      role="group"
      aria-label="Zoom"
      className={`flex select-none items-center gap-0.5 rounded-full bg-black/60 p-0.5 text-[11px] font-medium text-white ${className}`}
      // A press here is nobody else's: it must not close what is behind, and
      // it leaves the cursor in the text field it was in
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={zoom.zoomOut}
        disabled={!zoom.canZoomOut}
        title="Zoom out (− key)"
        aria-label="Zoom out"
        className={`${button} text-base leading-none`}
      >
        −
      </button>
      <span
        className="min-w-10 text-center tabular-nums"
        title="Size on screen, compared with the picture’s real size. Zoomed in, drag the picture to move around"
      >
        {zoom.percent === null ? '…' : `${zoom.percent}%`}
      </span>
      <button
        type="button"
        onClick={zoom.zoomIn}
        disabled={!zoom.canZoomIn}
        title="Zoom in (+ key, or Ctrl + scroll wheel)"
        aria-label="Zoom in"
        className={`${button} text-base leading-none`}
      >
        +
      </button>
      <button
        type="button"
        onClick={zoom.toFit}
        disabled={!zoom.zoomed}
        title="Show the whole picture (0 key)"
        aria-label="Fit the whole picture in view"
        className={button}
      >
        Fit
      </button>
      <button
        type="button"
        onClick={zoom.toActual}
        disabled={!zoom.canActual}
        title="Real size: one picture pixel per screen pixel"
        aria-label="Zoom to 100%, the picture’s real size"
        className={button}
      >
        100%
      </button>
    </div>
  )
}
