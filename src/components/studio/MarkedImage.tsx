import { useRef, useState } from 'react'
import { MAX_MARKS, arrowTail, markColor, type EditMark } from '../../lib/annotate'
import { useZoom } from '../common/useZoom'
import { ZoomButtons, ZoomPane } from '../common/ZoomPane'
import type { Area, Touch } from '../../lib/localEdit'

// Touching up a finished edit: clicks pick spots (of the size and kind chosen)
// instead of placing arrows
export interface TouchUp {
  // Already part of the version on screen, and picked since
  applied: Touch[]
  pending: Touch[]
  size: number
  take: boolean
  onAdd: (x: number, y: number) => void
}

// Where a vision model found the things the arrows point at, and the faces
export interface FoundBox {
  area: Area
  kind: 'object' | 'face'
  label?: string | null
}

interface Props {
  src: string
  alt: string
  marks: EditMark[]
  activeId: string | null
  // Off while comparing or when the picture isn't the one being edited
  interactive: boolean
  onAdd: (x: number, y: number) => void
  onMove: (id: string, x: number, y: number) => void
  onActivate: (id: string) => void
  // A see-through tint laid over the picture — shows what an "only around the
  // arrows" edit replaced
  overlayUrl?: string | null
  touchUp?: TouchUp | null
  boxes?: FoundBox[]
}

// The stage picture with the user's numbered arrows on top. Click anywhere to
// point an arrow at that spot; drag any part of an arrow to move it.
//
// The picture can be zoomed (buttons in the stage's corner, + − 0, Ctrl + wheel,
// two fingers) to aim at small things: it and everything drawn on it live in
// one box inside a scrolling pane, so the marks stay on their picture
// positions, and a click lands on the picture point under the pointer at any
// zoom. The zoomed picture is moved by dragging it (or scrolling, or two
// fingers); an arrow is still moved by dragging the arrow.

// Room to scroll the zoomed picture past its top and bottom edges, so a corner
// can be moved out from under the labels and buttons that sit over the stage
const OVERSCROLL = 56

// Pointer travel (px) before a press on an arrow counts as a drag, so a click
// or a jittery tap selects the arrow instead of nudging it
const DRAG_THRESHOLD = 4

interface Drag {
  id: string
  // Tip position minus the pointer position at the press, so the arrow moves
  // with the pointer instead of its tip jumping to it
  dx: number
  dy: number
  startX: number
  startY: number
  moved: boolean
}
export function MarkedImage({
  src,
  alt,
  marks,
  activeId,
  interactive,
  onAdd,
  onMove,
  onActivate,
  overlayUrl,
  touchUp,
  boxes,
}: Props) {
  const { zoom, sizerRef, paneRef, contentRef } = useZoom({ overscroll: OVERSCROLL })
  const drag = useRef<Drag | null>(null)
  // A press that is placed only when it is let go: by then it is known not to
  // have been the start of a drag that moves the zoomed picture, or the first
  // finger of a pinch (see `press`)
  const tap = useRef<{ id: number; x: number; y: number } | null>(null)
  // Where the next touch-up would land (shows its size before the click)
  // Where the touch-up ring is, and the zoom it was put there at: once the
  // picture has moved under a still pointer (a scroll, a zoom step by key)
  // the ring would be somewhere the next click does not go, so it is not
  // shown again until the pointer moves
  const [hover, setHover] = useState<{ x: number; y: number; zoom: number } | null>(null)

  const toPicture = (e: React.PointerEvent, svg: Element) => {
    const rect = svg.getBoundingClientRect()
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
  }
  const endDrag = () => {
    drag.current = null
  }
  // A press on the fitted picture counts at once, as it always has. On the
  // zoomed picture, and for a finger, it counts when let go — where it went
  // down — unless it became a drag or a pinch first: the pane keeps the rest
  // of those to itself, so the release never arrives here
  const press = (e: React.PointerEvent, svg: Element, place: (x: number, y: number) => void) => {
    const p = toPicture(e, svg)
    if (e.pointerType !== 'touch' && !zoom.zoomed) {
      place(clamp01(p.x), clamp01(p.y))
      return
    }
    const mine = { id: e.pointerId, x: clamp01(p.x), y: clamp01(p.y) }
    tap.current = mine
    // Whichever way this press ends — even somewhere that never tells the
    // picture — it is over then (after the release has had its turn here)
    const forget = () => {
      window.removeEventListener('pointerup', forget, true)
      window.removeEventListener('pointercancel', forget, true)
      setTimeout(() => {
        if (tap.current === mine) tap.current = null
      }, 0)
    }
    window.addEventListener('pointerup', forget, true)
    window.addEventListener('pointercancel', forget, true)
  }
  const lift = (e: React.PointerEvent, place: (x: number, y: number) => void) => {
    const t = tap.current
    tap.current = null
    if (t && t.id === e.pointerId) place(t.x, t.y)
  }

  // The picture's box as drawn — the overlays' coordinates are its screen
  // pixels — and as fitted. Lines, arrow heads and number tags go by the
  // fitted size, so they stay as large on screen when the picture is zoomed in
  const box = zoom.fit ? { width: zoom.width, height: zoom.height } : null
  const aspect = box && box.height > 0 ? box.width / box.height : 1
  const unit = zoom.fit ? Math.min(zoom.fit.width, zoom.fit.height) : 0
  // (a touch-up spot is a piece of the picture: that does grow with it)
  const drawnUnit = box ? Math.min(box.width, box.height) : 0
  const cursor = zoom.hand === 'dragging' ? 'grabbing' : zoom.hand === 'ready' ? 'grab' : 'crosshair'

  return (
    <>
      {/* Laid out exactly as the picture was before it could be zoomed, and
          never seen: its box is the fitted size, and it gives the stage the
          height the picture used to give it */}
      <img
        ref={sizerRef}
        src={src}
        alt=""
        aria-hidden
        draggable={false}
        className="pointer-events-none invisible max-h-full max-w-full object-contain"
      />
      <ZoomPane zoom={zoom} paneRef={paneRef} contentRef={contentRef} onScroll={() => setHover(null)}>
        <img src={src} alt={alt} className="block h-full w-full object-contain" draggable={false} />
        {box && overlayUrl && (
          <img
            aria-hidden
            alt=""
            src={overlayUrl}
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
        )}
        {box && boxes && boxes.length > 0 && (
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox={`0 0 ${box.width} ${box.height}`}
          >
            {boxes.map((b, i) => {
              const colour = b.kind === 'face' ? '#30d158' : '#0a84ff'
              const x = b.area.x0 * box.width
              const y = b.area.y0 * box.height
              return (
                <g key={i}>
                  <rect
                    x={x}
                    y={y}
                    width={(b.area.x1 - b.area.x0) * box.width}
                    height={(b.area.y1 - b.area.y0) * box.height}
                    fill="none"
                    stroke="rgba(0,0,0,0.55)"
                    strokeWidth={4}
                  />
                  <rect
                    x={x}
                    y={y}
                    width={(b.area.x1 - b.area.x0) * box.width}
                    height={(b.area.y1 - b.area.y0) * box.height}
                    fill="none"
                    stroke={colour}
                    strokeWidth={2}
                    strokeDasharray="7 5"
                  />
                  <text
                    x={x + 5}
                    y={y + 14}
                    fill="#fff"
                    fontSize={11}
                    fontWeight="bold"
                    stroke="rgba(0,0,0,0.7)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {b.kind === 'face' ? 'face — guarded' : (b.label ?? 'found')}
                  </text>
                </g>
              )
            })}
          </svg>
        )}
        {box && touchUp && (
          <svg
            className="absolute inset-0 h-full w-full touch-none select-none"
            style={{ cursor }}
            viewBox={`0 0 ${box.width} ${box.height}`}
            onPointerDown={(e) => {
              tap.current = null
              if (e.button !== 0) return
              e.preventDefault()
              press(e, e.currentTarget, touchUp.onAdd)
            }}
            onPointerUp={(e) => lift(e, touchUp.onAdd)}
            onPointerCancel={() => (tap.current = null)}
            onPointerMove={(e) => setHover({ ...toPicture(e, e.currentTarget), zoom: zoom.zoom })}
            onPointerLeave={() => setHover(null)}
          >
            {[...touchUp.applied.map((t) => ({ t, fresh: false })), ...touchUp.pending.map((t) => ({ t, fresh: true }))].map(
              ({ t, fresh }, i) => (
                <circle
                  key={i}
                  cx={t.x * box.width}
                  cy={t.y * box.height}
                  r={Math.max(3, t.r * drawnUnit)}
                  fill={t.take ? 'rgba(48,209,88,0.28)' : 'rgba(255,159,10,0.28)'}
                  stroke={t.take ? '#30d158' : '#ff9f0a'}
                  strokeWidth={fresh ? 2.5 : 1.5}
                  strokeDasharray={fresh ? undefined : '4 4'}
                  opacity={fresh ? 1 : 0.6}
                />
              ),
            )}
            {hover && hover.zoom === zoom.zoom && (
              <circle
                cx={hover.x * box.width}
                cy={hover.y * box.height}
                r={Math.max(3, touchUp.size * drawnUnit)}
                fill="none"
                stroke={touchUp.take ? '#30d158' : '#ff9f0a'}
                strokeWidth={1.5}
                style={{ pointerEvents: 'none' }}
              />
            )}
          </svg>
        )}
        {box && interactive && !touchUp && (
          <svg
            className="absolute inset-0 h-full w-full touch-none select-none"
            style={{ cursor }}
            viewBox={`0 0 ${box.width} ${box.height}`}
            onPointerDown={(e) => {
              tap.current = null
              // Only a plain press (left button, finger, pen tip) places arrows
              if (e.button !== 0) return
              // Keeps the browser from moving focus away from the new row's input
              e.preventDefault()
              if (drag.current) return
              if (marks.length >= MAX_MARKS) return
              press(e, e.currentTarget, onAdd)
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (!d) return
              if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return
              d.moved = true
              const p = toPicture(e, e.currentTarget)
              onMove(d.id, clamp01(p.x + d.dx), clamp01(p.y + d.dy))
            }}
            onPointerUp={(e) => {
              endDrag()
              lift(e, onAdd)
            }}
            onPointerCancel={() => {
              endDrag()
              tap.current = null
            }}
            onLostPointerCapture={endDrag}
          >
            {marks.map((mark, i) => {
              const color = markColor(i).css
              const tail = arrowTail(mark, aspect)
              const tx = mark.x * box.width
              const ty = mark.y * box.height
              // The shaft keeps the length it has at fit: zoomed in, an arrow
              // drawn to scale would run right across the view, its number
              // far off screen (the guide the model gets is drawn separately)
              const sx = (mark.x + (tail.x - mark.x) / zoom.zoom) * box.width
              const sy = (mark.y + (tail.y - mark.y) / zoom.zoom) * box.height
              const angle = Math.atan2(ty - sy, tx - sx)
              const head = Math.max(10, unit * 0.035)
              const tagR = Math.max(10, unit * 0.03)
              const active = mark.id === activeId
              const grab = (e: React.PointerEvent) => {
                if (e.button !== 0) return
                e.stopPropagation()
                e.preventDefault()
                tap.current = null
                const svg = (e.currentTarget as SVGGElement).ownerSVGElement
                if (!svg) return
                svg.setPointerCapture(e.pointerId)
                const p = toPicture(e, svg)
                drag.current = {
                  id: mark.id,
                  dx: mark.x - p.x,
                  dy: mark.y - p.y,
                  startX: e.clientX,
                  startY: e.clientY,
                  moved: false,
                }
                onActivate(mark.id)
              }
              const headPoints = [
                [tx, ty],
                [tx - head * Math.cos(angle - 0.42), ty - head * Math.sin(angle - 0.42)],
                [tx - head * Math.cos(angle + 0.42), ty - head * Math.sin(angle + 0.42)],
              ]
                .map((p) => p.join(','))
                .join(' ')
              return (
                <g
                  key={mark.id}
                  // Dragging an arrow moves the arrow, not the zoomed picture under it
                  data-own-drag
                  // (the stored position, for the end-to-end checks to read)
                  data-mark-x={mark.x}
                  data-mark-y={mark.y}
                  style={{ cursor: zoom.hand === 'off' ? 'grab' : undefined }}
                  onPointerDown={grab}
                >
                  <line
                    x1={sx}
                    y1={sy}
                    x2={tx - Math.cos(angle) * head * 0.6}
                    y2={ty - Math.sin(angle) * head * 0.6}
                    stroke="rgba(0,0,0,0.5)"
                    strokeWidth={active ? 7 : 6}
                    strokeLinecap="round"
                  />
                  <line
                    x1={sx}
                    y1={sy}
                    x2={tx - Math.cos(angle) * head * 0.6}
                    y2={ty - Math.sin(angle) * head * 0.6}
                    stroke={color}
                    strokeWidth={active ? 4 : 3}
                    strokeLinecap="round"
                  />
                  <polygon points={headPoints} fill={color} stroke="rgba(0,0,0,0.5)" strokeWidth={1.5} />
                  <circle cx={sx} cy={sy} r={tagR} fill={color} stroke="#fff" strokeWidth={active ? 3 : 2} />
                  <text
                    x={sx}
                    y={sy + 1}
                    fill="#fff"
                    fontSize={tagR * 1.15}
                    fontWeight="bold"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    style={{ pointerEvents: 'none' }}
                  >
                    {i + 1}
                  </text>
                  {/* A larger invisible target on the tip makes it easy to grab */}
                  <circle cx={tx} cy={ty} r={Math.max(12, head)} fill="transparent" />
                </g>
              )
            })}
          </svg>
        )}
      </ZoomPane>
      <ZoomButtons zoom={zoom} className="absolute right-3 top-3" />
    </>
  )
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
