import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

// Zooming a picture on screen, for looking closely and for aiming at small
// things. Display only: the picture element keeps its source and is merely
// drawn larger inside a scrolling pane.
//
// Zoom 1 is "fit": the size the page's own layout gives the picture. That size
// is not worked out here but measured from a "sizer" — an invisible copy of
// the picture laid out by the same rules as before there was any zoom — so the
// fitted picture sits exactly where it always did, on every layout.

export interface Size {
  width: number
  height: number
}

interface Options {
  // Another picture altogether: back to fit
  resetKey?: string
  // Room (px) to scroll past the picture's top and bottom edges while zoomed
  // in, so its corners can be moved out from under the buttons laid over them
  overscroll?: number
}

// One press of + or −
const STEP = 1.4
// A press that travels less than this (px) is still a click, not a drag
const DRAG_THRESHOLD = 4

interface Anchor {
  // Picture point (fractions) …
  fx: number
  fy: number
  // … and the window position it has to be at
  x: number
  y: number
}

export type Hand = 'off' | 'ready' | 'dragging'

export type Zoom = ReturnType<typeof useZoom>['zoom']

// Keys are left alone while something is being typed
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable) return true
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'range'].includes(target.type)
}

export function useZoom({ resetKey, overscroll = 0 }: Options) {
  // The sizer and the pane are kept in state so the effects below run again
  // when they come and go (the large view shows videos without any of this);
  // the pane is in a ref as well, for scrolling it
  const [sizer, attachSizer] = useState<HTMLImageElement | null>(null)
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null)
  const pane = useRef<HTMLDivElement | null>(null)
  const attachPane = useCallback((el: HTMLDivElement | null) => {
    pane.current = el
    setPaneEl(el)
  }, [])
  // The box the picture is drawn in
  const content = useRef<HTMLDivElement | null>(null)
  const attachContent = useCallback((el: HTMLDivElement | null) => {
    content.current = el
  }, [])
  const [fit, setFit] = useState<Size | null>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  // A multiple of the fitted size, never below 1
  const [zoom, setZoom] = useState(1)
  const [hand, setHand] = useState<Hand>('off')

  const [key, setKey] = useState(resetKey)
  if (key !== resetKey) {
    setKey(resetKey)
    setZoom(1)
  }

  // The zoom at which one picture pixel takes one screen pixel
  const actual = fit && natural && fit.width > 0 ? Math.max(1, natural.width / fit.width) : 1
  const max = Math.max(8, 4 * actual)

  // What the event handlers go by. `shown` is the level on screen; `zoom` is
  // the level last asked for, written by the handlers themselves so that
  // several wheel events arriving before the next render each build on the last
  const live = useRef({ zoom, shown: zoom, max, actual })
  useLayoutEffect(() => {
    live.current = { zoom, shown: zoom, max, actual }
  })

  // The picture point to put back under a window position once the new size is laid out
  const pending = useRef<Anchor | null>(null)
  // The last such point, and the state it left the pane in. Scroll positions
  // are whole pixels, so the point ends up a fraction of a pixel off; reading
  // it back from the screen for the next step would let that add up over a run
  // of steps. While nothing else has moved the picture, the next step about
  // the same window position therefore goes by the same picture point
  const last = useRef<(Anchor & { left: number; top: number; width: number }) | null>(null)

  const hold = useCallback((x: number, y: number) => {
    const el = content.current
    const scroller = pane.current
    if (!el || !scroller) return
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const was = last.current
    const untouched =
      was &&
      was.x === x &&
      was.y === y &&
      was.left === scroller.scrollLeft &&
      was.top === scroller.scrollTop &&
      was.width === rect.width
    const anchor: Anchor = untouched
      ? { fx: was.fx, fy: was.fy, x, y }
      : { fx: (x - rect.left) / rect.width, fy: (y - rect.top) / rect.height, x, y }
    pending.current = anchor
    last.current = { ...anchor, left: scroller.scrollLeft, top: scroller.scrollTop, width: rect.width }
  }, [])

  const settle = useCallback(() => {
    const anchor = pending.current
    pending.current = null
    const el = content.current
    const scroller = pane.current
    if (!anchor || !el || !scroller) return
    const rect = el.getBoundingClientRect()
    scroller.scrollLeft += rect.left + anchor.fx * rect.width - anchor.x
    scroller.scrollTop += rect.top + anchor.fy * rect.height - anchor.y
    if (last.current) last.current = { ...last.current, left: scroller.scrollLeft, top: scroller.scrollTop, width: rect.width }
  }, [])

  const width = fit ? fit.width * zoom : 0
  const height = fit ? fit.height * zoom : 0
  useLayoutEffect(settle, [settle, width, height])

  const request = useCallback(
    (to: number) => {
      if (to !== live.current.zoom) {
        live.current.zoom = to
        setZoom(to)
      }
      // The level already on screen (asked for again before a render, or the
      // fingers only moved): nothing will be laid out anew, so the picture is
      // put in place right away
      if (to === live.current.shown) settle()
    },
    [settle],
  )

  // Zooms about a window position — the middle of the pane when none is given
  const zoomTo = useCallback(
    (target: number | ((from: number) => number), at?: { x: number; y: number }) => {
      const viewport = pane.current
      if (!viewport) return
      const from = live.current.zoom
      let to = Math.min(live.current.max, Math.max(1, typeof target === 'function' ? target(from) : target))
      // (steps back down don't land on exactly 1)
      if (to < 1.01) to = 1
      if (to === from) return
      const rect = viewport.getBoundingClientRect()
      const point = at ?? { x: rect.left + viewport.clientWidth / 2, y: rect.top + viewport.clientHeight / 2 }
      hold(point.x, point.y)
      request(to)
    },
    [hold, request],
  )

  // The fitted size, and the picture's own
  useEffect(() => {
    if (!sizer) return
    let aspect = 0
    const readPicture = () => {
      const w = sizer.naturalWidth
      const h = sizer.naturalHeight
      if (!w || !h) return
      setNatural((prev) => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }))
      // A picture of another shape can't be compared spot for spot: start over.
      // (Versions of one picture share their shape, so they keep the view.)
      if (aspect && Math.abs(w / h / aspect - 1) > 0.01) {
        live.current.zoom = 1
        setZoom(1)
      }
      aspect = w / h
    }
    let box = { w: 0, h: 0 }
    const observer = new ResizeObserver(([entry]) => {
      readPicture()
      const { width: w, height: h } = entry.contentRect
      if (!w || !h || (w === box.w && h === box.h)) return
      box = { w, h }
      // The pane changing size (a window resize, a bar appearing under it)
      // keeps what is in the middle of the view there
      const viewport = pane.current
      if (live.current.zoom > 1 && viewport) {
        const rect = viewport.getBoundingClientRect()
        hold(rect.left + viewport.clientWidth / 2, rect.top + viewport.clientHeight / 2)
      }
      setFit({ width: w, height: h })
    })
    observer.observe(sizer)
    sizer.addEventListener('load', readPicture)
    return () => {
      observer.disconnect()
      sizer.removeEventListener('load', readPicture)
    }
  }, [sizer, hold])

  // Wheel, fingers and dragging, on the pane itself. These are plain DOM
  // listeners in the capture phase: a wheel event can only be cancelled by a
  // non-passive listener, and what turns out to be for moving the picture (a
  // drag, a second finger) has to be kept from whatever is drawn on it — the
  // studio places an arrow where a press is let go.
  useEffect(() => {
    const viewport = pane.current
    if (!viewport || !paneEl) return
    const fingers = new Map<number, { x: number; y: number }>()
    let pinch: { distance: number; zoom: number; fx: number; fy: number } | null = null
    // Once two fingers are down, nothing those fingers do reaches the picture
    // until all are lifted — a pinch must not leave an arrow behind
    let swallow = false
    let pan: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | null = null
    let space = false

    const twoFingers = () => {
      const [a, b] = [...fingers.values()]
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) }
    }
    const onScrollbar = (e: PointerEvent) =>
      e.target === viewport && (e.offsetX >= viewport.clientWidth || e.offsetY >= viewport.clientHeight)

    const onWheel = (e: WheelEvent) => {
      // A plain wheel or two-finger swipe scrolls the pane. With Ctrl or ⌘ —
      // which is also how a trackpad pinch arrives — it zooms about the pointer
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1)
      // A mouse wheel reports about 100 a notch, a pinch a few units an event:
      // capped, a notch is a step of about 1.3 and a pinch follows the fingers
      const capped = Math.max(-25, Math.min(25, delta))
      zoomTo((from) => from * Math.exp(-capped * 0.01), { x: e.clientX, y: e.clientY })
    }

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        // (the first finger of a new touch: whatever was left over is stale)
        if (e.isPrimary) {
          fingers.clear()
          pinch = null
          swallow = false
        }
        fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (fingers.size === 2) {
          const now = twoFingers()
          const el = content.current
          const rect = el?.getBoundingClientRect()
          if (rect && rect.width && rect.height) {
            pinch = {
              distance: now.distance,
              zoom: live.current.zoom,
              fx: (now.x - rect.left) / rect.width,
              fy: (now.y - rect.top) / rect.height,
            }
            swallow = true
            pan = null
            setHand('off')
          }
        }
        if (swallow) {
          e.stopPropagation()
          e.preventDefault()
          return
        }
      }
      if (onScrollbar(e)) return
      // The zoomed picture is moved by dragging it — except by a part of it
      // that is dragged itself (marked data-own-drag: the studio's arrows).
      // With Space held or with the middle button, a press is for moving the
      // picture and nothing else, wherever it lands
      const byHand = e.button === 1 || (e.button === 0 && space)
      const plain =
        e.button === 0 &&
        live.current.zoom > 1 &&
        !(e.target instanceof Element && e.target.closest('[data-own-drag]'))
      if (!byHand && !plain) return
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false }
      // (a plain press still reaches the picture: it is a click unless it travels)
      if (!byHand) return
      e.stopPropagation()
      e.preventDefault()
      viewport.setPointerCapture(e.pointerId)
      setHand('dragging')
    }

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch' && fingers.has(e.pointerId)) {
        fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (pinch && fingers.size >= 2) {
          // The picture point that was between the fingers stays between
          // them: spreading zooms, moving both drags the picture along
          const now = twoFingers()
          let to = Math.min(live.current.max, Math.max(1, (pinch.zoom * now.distance) / pinch.distance))
          if (to < 1.01) to = 1
          pending.current = { fx: pinch.fx, fy: pinch.fy, x: now.x, y: now.y }
          last.current = null
          request(to)
        }
        if (swallow) {
          e.stopPropagation()
          return
        }
      }
      if (!pan || e.pointerId !== pan.id) return
      // (a release that never arrived here: the button is up, the drag is over)
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        pan = null
        setHand(space ? 'ready' : 'off')
        return
      }
      const dx = e.clientX - pan.x
      const dy = e.clientY - pan.y
      if (!pan.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        pan.moved = true
        if (!viewport.hasPointerCapture(e.pointerId)) viewport.setPointerCapture(e.pointerId)
        setHand('dragging')
      }
      viewport.scrollLeft = pan.left - dx
      viewport.scrollTop = pan.top - dy
      e.stopPropagation()
    }

    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        fingers.delete(e.pointerId)
        if (fingers.size < 2) pinch = null
        if (swallow) {
          e.stopPropagation()
          if (fingers.size === 0) swallow = false
          return
        }
      }
      if (!pan || e.pointerId !== pan.id) return
      if (pan.moved) {
        e.stopPropagation()
        // The click that follows a drag is not a click on anything (in the
        // large view it would close it)
        const stop = (click: MouseEvent) => {
          click.stopPropagation()
          click.preventDefault()
        }
        window.addEventListener('click', stop, { capture: true, once: true })
        setTimeout(() => window.removeEventListener('click', stop, true), 0)
      }
      pan = null
      setHand(space ? 'ready' : 'off')
    }

    // Keeps the middle button from starting the browser's own auto-scroll
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }

    // Space held with the pointer over the picture turns the pointer into a
    // hand — unless Space is doing its usual job in a text field or on a button
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTyping(e.target)) return
      if (!space) {
        if (e.target instanceof Element && e.target.closest('button, a[href], input, summary, [role=button]')) return
        if (!viewport.matches(':hover')) return
        space = true
        if (!pan) setHand('ready')
      }
      // (no page scroll, and no press of whichever button has the focus)
      e.preventDefault()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !space) return
      space = false
      e.preventDefault()
      if (!pan) setHand('off')
    }
    const onBlur = () => {
      space = false
      if (!pan) setHand('off')
    }

    viewport.addEventListener('wheel', onWheel, { passive: false })
    viewport.addEventListener('pointerdown', onDown, true)
    viewport.addEventListener('pointermove', onMove, true)
    viewport.addEventListener('pointerup', onUp, true)
    viewport.addEventListener('pointercancel', onUp, true)
    viewport.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      viewport.removeEventListener('wheel', onWheel)
      viewport.removeEventListener('pointerdown', onDown, true)
      viewport.removeEventListener('pointermove', onMove, true)
      viewport.removeEventListener('pointerup', onUp, true)
      viewport.removeEventListener('pointercancel', onUp, true)
      viewport.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [paneEl, zoomTo, request])

  // + and − zoom, 0 goes back to fit — never while typing, and never with
  // Ctrl or ⌘, which zoom the whole page
  useEffect(() => {
    // (only while there is a picture to zoom)
    if (!paneEl) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || isTyping(e.target)) return
      if (e.key === '+' || e.key === '=') zoomTo((from) => from * STEP)
      else if (e.key === '-' || e.key === '_') zoomTo((from) => from / STEP)
      else if (e.key === '0') zoomTo(1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paneEl, zoomTo])

  const zoomIn = useCallback(() => zoomTo((from) => from * STEP), [zoomTo])
  const zoomOut = useCallback(() => zoomTo((from) => from / STEP), [zoomTo])
  const toFit = useCallback(() => zoomTo(1), [zoomTo])
  const toActual = useCallback(() => zoomTo(live.current.actual), [zoomTo])
  // Between fit and real size, about a window position (a double click).
  // A picture that already fits at its real size goes to twice that instead
  const toggle = useCallback(
    (at: { x: number; y: number }) => {
      const { zoom: from, actual: real } = live.current
      zoomTo(from > 1 ? 1 : real > 1.05 ? real : 2, at)
    },
    [zoomTo],
  )

  const zoomed = zoom > 1
  const state = {
    // Size of the fitted picture (zoom 1); null until it has been measured
    fit,
    zoom,
    zoomed,
    // Size the picture is drawn at
    width,
    height,
    // Of the picture's own pixels: 100 is one picture pixel per screen pixel
    percent: fit && natural ? Math.round((zoom / actual) * 100) : null,
    overscroll: zoomed ? overscroll : 0,
    // 'ready' while Space is held over the picture, 'dragging' while it is being moved
    hand,
    canZoomIn: zoom < max,
    canZoomOut: zoomed,
    // Real size is its own level only when the fitted picture is smaller than that
    canActual: actual > 1.005 && Math.abs(zoom - actual) > actual * 0.001,
    zoomIn,
    zoomOut,
    toFit,
    toActual,
    toggle,
  }
  // The state is handed out apart from the three places it is wired to: the
  // invisible sizer picture, and the pane's two elements (see ZoomPane)
  return { zoom: state, sizerRef: attachSizer, paneRef: attachPane, contentRef: attachContent }
}
