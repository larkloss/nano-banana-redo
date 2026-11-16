import { useEffect, useRef, useState } from 'react'
import { MAX_MARKS, arrowTail, markColor, type EditMark } from '../../lib/annotate'
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
  const imgRef = useRef<HTMLImageElement>(null)
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const drag = useRef<Drag | null>(null)
  // Where the next touch-up would land (shows its size before the click)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)

  // The overlay has to sit exactly on the rendered picture, which moves and
  // resizes with the layout; ResizeObserver also reports once on observe
  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const measure = () =>
      setBox({ left: img.offsetLeft, top: img.offsetTop, width: img.clientWidth, height: img.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(img)
    // The picture is centred in the stage: the stage changing size moves it
    // even when the picture itself keeps its size
    if (img.parentElement) observer.observe(img.parentElement)
    img.addEventListener('load', measure)
    return () => {
      observer.disconnect()
      img.removeEventListener('load', measure)
    }
  }, [src])

  const toPicture = (e: React.PointerEvent, svg: Element) => {
    const rect = svg.getBoundingClientRect()
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
  }
  const endDrag = () => {
    drag.current = null
  }

  const aspect = box && box.height > 0 ? box.width / box.height : 1
  const unit = box ? Math.min(box.width, box.height) : 0

  return (
    <>
      <img ref={imgRef} src={src} alt={alt} className="max-h-full max-w-full object-contain" draggable={false} />
      {box && overlayUrl && (
        <img
          aria-hidden
          alt=""
          src={overlayUrl}
          draggable={false}
          className="pointer-events-none absolute"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
      {box && boxes && boxes.length > 0 && (
        <svg
          aria-hidden
          className="pointer-events-none absolute"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
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
          className="absolute touch-none select-none"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height, cursor: 'crosshair' }}
          viewBox={`0 0 ${box.width} ${box.height}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            const p = toPicture(e, e.currentTarget)
            touchUp.onAdd(clamp01(p.x), clamp01(p.y))
          }}
          onPointerMove={(e) => setHover(toPicture(e, e.currentTarget))}
          onPointerLeave={() => setHover(null)}
        >
          {[...touchUp.applied.map((t) => ({ t, fresh: false })), ...touchUp.pending.map((t) => ({ t, fresh: true }))].map(
            ({ t, fresh }, i) => (
              <circle
                key={i}
                cx={t.x * box.width}
                cy={t.y * box.height}
                r={Math.max(3, t.r * unit)}
                fill={t.take ? 'rgba(48,209,88,0.28)' : 'rgba(255,159,10,0.28)'}
                stroke={t.take ? '#30d158' : '#ff9f0a'}
                strokeWidth={fresh ? 2.5 : 1.5}
                strokeDasharray={fresh ? undefined : '4 4'}
                opacity={fresh ? 1 : 0.6}
              />
            ),
          )}
          {hover && (
            <circle
              cx={hover.x * box.width}
              cy={hover.y * box.height}
              r={Math.max(3, touchUp.size * unit)}
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
          className="absolute touch-none select-none"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height, cursor: 'crosshair' }}
          viewBox={`0 0 ${box.width} ${box.height}`}
          onPointerDown={(e) => {
            // Only a plain press (left button, finger, pen tip) places arrows
            if (e.button !== 0) return
            // Keeps the browser from moving focus away from the new row's input
            e.preventDefault()
            if (drag.current) return
            if (marks.length >= MAX_MARKS) return
            const p = toPicture(e, e.currentTarget)
            onAdd(clamp01(p.x), clamp01(p.y))
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return
            d.moved = true
            const p = toPicture(e, e.currentTarget)
            onMove(d.id, clamp01(p.x + d.dx), clamp01(p.y + d.dy))
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        >
          {marks.map((mark, i) => {
            const color = markColor(i).css
            const tail = arrowTail(mark, aspect)
            const tx = mark.x * box.width
            const ty = mark.y * box.height
            const sx = tail.x * box.width
            const sy = tail.y * box.height
            const angle = Math.atan2(ty - sy, tx - sx)
            const head = Math.max(10, unit * 0.035)
            const tagR = Math.max(10, unit * 0.03)
            const active = mark.id === activeId
            const grab = (e: React.PointerEvent) => {
              if (e.button !== 0) return
              e.stopPropagation()
              e.preventDefault()
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
              <g key={mark.id} style={{ cursor: 'grab' }} onPointerDown={grab}>
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
    </>
  )
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
