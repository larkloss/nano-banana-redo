import { useCallback, useEffect, useRef, useState } from 'react'
import type { BaseImage, Shape, Tool } from '../types'
import { tracePath } from '../lib/mask'

interface Props {
  image: BaseImage
  tool: Tool
  shapes: Shape[]
  onCommitShape: (shape: Shape) => void
  disabled: boolean
}

interface FitState {
  s: number // image px -> CSS px scale
  dw: number
  dh: number
  ox: number
  oy: number
}

export function MaskCanvas({ image, tool, shapes, onCommitShape, disabled }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [fit, setFit] = useState<FitState | null>(null)
  const [draft, setDraft] = useState<Shape | null>(null)
  const dragRef = useRef<{ pointerId: number; anchor: { x: number; y: number } } | null>(null)

  // Fit-to-container math, recomputed on resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => {
      const cw = container.clientWidth
      const ch = container.clientHeight
      if (cw === 0 || ch === 0) return
      const s = Math.min(cw / image.width, ch / image.height)
      const dw = image.width * s
      const dh = image.height * s
      setFit({ s, dw, dh, ox: (cw - dw) / 2, oy: (ch - dh) / 2 })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [image])

  // Redraw the overlay (in image coordinates via setTransform)
  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay || !fit) return
    const dpr = window.devicePixelRatio || 1
    overlay.width = Math.round(fit.dw * dpr)
    overlay.height = Math.round(fit.dh * dpr)
    const ctx = overlay.getContext('2d')!
    ctx.setTransform(dpr * fit.s, 0, 0, dpr * fit.s, 0, 0)
    ctx.clearRect(0, 0, image.width, image.height)

    const drawShape = (shape: Shape, isDraft: boolean) => {
      ctx.beginPath()
      tracePath(ctx, shape)
      ctx.fillStyle = 'rgba(59, 130, 246, 0.25)'
      ctx.fill()
      ctx.lineWidth = 1.5 / fit.s
      ctx.setLineDash(isDraft ? [6 / fit.s, 4 / fit.s] : [])
      ctx.strokeStyle = isDraft ? 'rgba(147, 197, 253, 0.95)' : 'rgba(59, 130, 246, 0.95)'
      ctx.stroke()
    }
    for (const shape of shapes) drawShape(shape, false)
    if (draft) drawShape(draft, true)
  }, [fit, shapes, draft, image])

  const toImage = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const overlay = overlayRef.current!
      const r = overlay.getBoundingClientRect()
      const s = fit?.s ?? 1
      return {
        x: Math.min(image.width, Math.max(0, (e.clientX - r.left) / s)),
        y: Math.min(image.height, Math.max(0, (e.clientY - r.top) / s)),
      }
    },
    [fit, image],
  )

  const makeDraft = useCallback(
    (anchor: { x: number; y: number }, p: { x: number; y: number }, prev: Shape | null): Shape => {
      if (tool === 'rect') return { kind: 'rect', x0: anchor.x, y0: anchor.y, x1: p.x, y1: p.y }
      if (tool === 'ellipse') {
        return {
          kind: 'ellipse',
          cx: (anchor.x + p.x) / 2,
          cy: (anchor.y + p.y) / 2,
          rx: Math.abs(p.x - anchor.x) / 2,
          ry: Math.abs(p.y - anchor.y) / 2,
        }
      }
      const points = prev?.kind === 'lasso' ? prev.points : [anchor]
      const last = points[points.length - 1]
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 2) {
        return { kind: 'lasso', points: [...points, p] }
      }
      return prev ?? { kind: 'lasso', points }
    },
    [tool],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || !e.isPrimary || e.button !== 0) return
    const anchor = toImage(e)
    dragRef.current = { pointerId: e.pointerId, anchor }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDraft(tool === 'lasso' ? { kind: 'lasso', points: [anchor] } : makeDraft(anchor, anchor, null))
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    const p = toImage(e)
    setDraft((prev) => makeDraft(drag.anchor, p, prev))
  }

  const endDrag = (commit: boolean) => {
    const finished = draft
    dragRef.current = null
    setDraft(null)
    if (!commit || !finished) return
    if (!isDegenerate(finished)) onCommitShape(finished)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current && e.pointerId === dragRef.current.pointerId) endDrag(true)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) {
        dragRef.current = null
        setDraft(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div ref={containerRef} className="relative h-[52vh] min-h-72 w-full overflow-hidden rounded-xl bg-zinc-900/40">
      {fit && (
        <>
          <img
            src={image.objectUrl}
            alt="Base"
            draggable={false}
            className="absolute select-none"
            style={{ left: fit.ox, top: fit.oy, width: fit.dw, height: fit.dh }}
          />
          <canvas
            ref={overlayRef}
            className="absolute touch-none"
            style={{
              left: fit.ox,
              top: fit.oy,
              width: fit.dw,
              height: fit.dh,
              cursor: disabled ? 'default' : 'crosshair',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => endDrag(false)}
          />
        </>
      )}
    </div>
  )
}

function isDegenerate(shape: Shape): boolean {
  if (shape.kind === 'rect') return Math.abs((shape.x1 - shape.x0) * (shape.y1 - shape.y0)) < 4
  if (shape.kind === 'ellipse') return shape.rx * shape.ry * Math.PI < 4
  return shape.points.length < 3
}
