import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MentionContext } from './mentionContext'

interface Props {
  value: string
  onChange: (value: string) => void
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  disabled?: boolean
  placeholder?: string
  rows?: number
  className?: string
}

// "@" being typed just before the caret (also the full-width ＠, and right
// after another mention): the digits so far
const TYPING = /(?:^|[^\w@＠.])(?:[@＠][1-9]\d?)*[@＠](\d{0,2})$/

interface Menu {
  // index of the "@"
  start: number
  digits: string
  // viewport box of the line it is on
  left: number
  lineTop: number
  lineBottom: number
  active: number
}

// A textarea where typing "@" offers the reference photos by number, the way
// a chat app offers people: arrows to move, Enter or Tab to take, Esc to
// leave it. With no reference photos it is a plain textarea.
export function MentionTextarea({ value, onChange, textareaRef, disabled, placeholder, rows, className }: Props) {
  const targets = useContext(MentionContext)
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const ref = textareaRef ?? ownRef
  const listRef = useRef<HTMLUListElement>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  // An "@" the user pressed Esc on stays closed until they move on from it
  const dismissed = useRef<number | null>(null)
  // Where the caret goes once an inserted mention has rendered (only if the
  // text that renders is the one it was meant for)
  const pendingCaret = useRef<{ value: string; caret: number } | null>(null)

  useLayoutEffect(() => {
    const pending = pendingCaret.current
    pendingCaret.current = null
    if (pending && pending.value === value) ref.current?.setSelectionRange(pending.caret, pending.caret)
  }, [value, ref])

  const options = menu ? targets.filter((t) => String(t.number).startsWith(menu.digits)) : []
  const open = menu !== null && options.length > 0 && !disabled
  const active = menu ? Math.min(menu.active, options.length - 1) : 0

  // The menu is pinned to the viewport: close it rather than let it drift
  // when the page moves under it (scrolling the list itself is fine)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e.target instanceof Node && listRef.current?.contains(e.target)) return
      setMenu(null)
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // Keep the highlighted photo in sight in a long list
  useEffect(() => {
    if (open) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  // `mayOpen`: typing opens the menu; clicking or moving the caret onto an
  // "@2" that is already there only keeps an open menu up to date
  const refresh = (el: HTMLTextAreaElement, mayOpen: boolean) => {
    const caret = el.selectionStart
    const typing = el.selectionEnd === caret ? el.value.slice(0, caret).match(TYPING) : null
    if (!typing || targets.length === 0) {
      dismissed.current = null
      setMenu(null)
      return
    }
    const start = caret - typing[1].length - 1
    if (dismissed.current === start) return
    dismissed.current = null
    const point = caretPoint(el, start)
    // not for a line that is scrolled out of sight: the menu would take the
    // keys without being seen
    if (point.lineBottom < 0 || point.lineTop > window.innerHeight) {
      setMenu(null)
      return
    }
    setMenu((prev) => {
      if (!prev && !mayOpen) return null
      return {
        start,
        digits: typing[1],
        ...point,
        active: prev && prev.start === start && prev.digits === typing[1] ? prev.active : 0,
      }
    })
  }

  const take = (number: number) => {
    const el = ref.current
    if (!el || !menu) return
    const caret = el.selectionStart
    const gap = /^\s/.test(value.slice(caret)) ? '' : ' '
    const inserted = `@${number}${gap}`
    const after = menu.start + inserted.length + (gap ? 0 : 1)
    setMenu(null)
    if (value.slice(menu.start, caret) === `@${number}`) {
      // already written out: just step past it (and the space after it)
      const past = caret + (gap ? 0 : 1)
      el.setSelectionRange(past, past)
      return
    }
    // Typed in through the browser's own editing, so Ctrl+Z still works
    el.setSelectionRange(menu.start, caret)
    if (document.execCommand('insertText', false, inserted)) {
      el.setSelectionRange(after, after)
      return
    }
    const next = value.slice(0, menu.start) + inserted + value.slice(caret)
    pendingCaret.current = { value: next, caret: after }
    onChange(next)
  }

  // Below the line if there is room, above it otherwise
  const below = menu ? window.innerHeight - menu.lineBottom - 12 : 0
  const above = menu ? menu.lineTop - 12 : 0
  const flip = below < 160 && above > below

  return (
    <>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          refresh(e.target, true)
        }}
        onKeyDown={(e) => {
          if (!open || !menu || e.nativeEvent.isComposing) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setMenu({ ...menu, active: (active + step + options.length) % options.length })
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            take(options[active].number)
          } else if (e.key === 'Escape') {
            // only the menu closes, not a dialog this box may sit in
            e.preventDefault()
            e.stopPropagation()
            e.nativeEvent.stopImmediatePropagation()
            dismissed.current = menu.start
            setMenu(null)
          }
        }}
        onKeyUp={(e) => {
          // the caret may have moved (arrows, Home/End); menu keys are handled above
          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) refresh(e.currentTarget, false)
        }}
        onClick={(e) => refresh(e.currentTarget, false)}
        onBlur={() => setMenu(null)}
        disabled={disabled}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        className={className}
      />
      {open && menu && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Reference photos"
          className="soft-shadow fixed z-[60] w-56 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-1"
          style={{
            left: Math.max(8, Math.min(menu.left, window.innerWidth - 236)),
            maxHeight: Math.max(96, Math.min(256, flip ? above : below)),
            ...(flip ? { bottom: window.innerHeight - menu.lineTop + 4 } : { top: menu.lineBottom + 4 }),
          }}
          // keep the caret in the text while picking with the mouse
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((target, i) => (
            <li key={target.number} role="option" aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => take(target.number)}
                onMouseMove={() => {
                  if (i !== active) setMenu({ ...menu, active: i })
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs ${
                  i === active ? 'bg-blue-600 text-white' : 'text-zinc-300'
                }`}
              >
                <img src={target.objectUrl} alt="" className="h-9 w-9 shrink-0 rounded-md object-cover" />
                <span className="font-semibold">@{target.number}</span>
                <span className={`min-w-0 flex-1 truncate ${i === active ? 'text-white/80' : 'text-zinc-500'}`}>
                  {target.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

// Viewport box of the line the character at `index` is on (its left edge at
// that character), found by laying the text out again in a hidden copy of
// the textarea
const COPIED = [
  'boxSizing',
  'width',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'wordSpacing',
  'textIndent',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
] as const

function caretPoint(el: HTMLTextAreaElement, index: number): { left: number; lineTop: number; lineBottom: number } {
  const style = getComputedStyle(el)
  const copy = document.createElement('div')
  for (const key of COPIED) copy.style[key] = style[key]
  copy.style.position = 'absolute'
  copy.style.visibility = 'hidden'
  copy.style.whiteSpace = 'pre-wrap'
  copy.style.overflowWrap = 'break-word'
  copy.style.borderStyle = 'solid'
  copy.textContent = el.value.slice(0, index)
  const marker = document.createElement('span')
  // only what is needed to place the "@": a long prompt isn't laid out twice per key
  marker.textContent = el.value.slice(index, index + 64) || '.'
  copy.appendChild(marker)
  document.body.appendChild(copy)
  const box = el.getBoundingClientRect()
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4
  const lineTop = box.top + marker.offsetTop - el.scrollTop
  const point = { left: box.left + marker.offsetLeft - el.scrollLeft, lineTop, lineBottom: lineTop + lineHeight }
  copy.remove()
  return point
}
