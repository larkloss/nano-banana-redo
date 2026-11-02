import { useEffect, useRef, useState } from 'react'
import { MAX_MARKS, arrowTail, markColor, type EditMark } from '../../lib/annotate'

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
}

// The stage picture with the user's numbered arrows on top. Click anywhere to
// point an arrow at that spot; drag an arrow's tip or number to adjust it.
export function MarkedImage({ src, alt, marks, activeId, interactive, onAdd, onMove, onActivate }: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const dragging = useRef<string | null>(null)

  // The overlay has to sit exactly on the rendered picture, which moves and
  // resizes with the layout; ResizeObserver also reports once on observe
  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const measure = () =>
      setBox({ left: img.offsetLeft, top: img.offsetTop, width: img.clientWidth, height: img.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(img)
    img.addEventListener('load', measure)
    return () => {
      observer.disconnect()
      img.removeEventListener('load', measure)
    }
  }, [src])

  const toPicture = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    }
  }

  const aspect = box && box.height > 0 ? box.width / box.height : 1
  const unit = box ? Math.min(box.width, box.height) : 0

  return (
    <>
      <img ref={imgRef} src={src} alt={alt} className="max-h-full max-w-full object-contain" draggable={false} />
      {box && interactive && (
        <svg
          className="absolute touch-none select-none"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height, cursor: 'crosshair' }}
          viewBox={`0 0 ${box.width} ${box.height}`}
          onPointerDown={(e) => {
            // Keeps the browser from moving focus away from the new row's input
            e.preventDefault()
            if (dragging.current) return
            if (marks.length >= MAX_MARKS) return
            const p = toPicture(e)
            onAdd(p.x, p.y)
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return
            const p = toPicture(e)
            onMove(dragging.current, p.x, p.y)
          }}
          onPointerUp={() => {
            dragging.current = null
          }}
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
              e.stopPropagation()
              e.preventDefault()
              const svg = (e.currentTarget as SVGGElement).ownerSVGElement
              svg?.setPointerCapture(e.pointerId)
              dragging.current = mark.id
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
