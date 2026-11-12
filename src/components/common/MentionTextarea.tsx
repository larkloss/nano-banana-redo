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

// "@" being typed just before the caret: where it starts and the digits so far
const TYPING = /(^|[^\w@.])@(\d{0,2})$/

interface Menu {
  // index of the "@"
  start: number
  digits: string
  // viewport position of the line below it
  left: number
  top: number
  active: number
}

// A textarea where typing "@" offers the reference photos by number, the way
// a chat app offers people: arrows to move, Enter or Tab to take, Esc to
// leave it. With no reference photos it is a plain textarea.
export function MentionTextarea({ value, onChange, textareaRef, disabled, placeholder, rows, className }: Props) {
  const targets = useContext(MentionContext)
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const ref = textareaRef ?? ownRef
  const [menu, setMenu] = useState<Menu | null>(null)
  // An "@" the user pressed Esc on stays closed until they move on from it
  const dismissed = useRef<number | null>(null)
  // Where the caret goes once an inserted mention has rendered
  const pendingCaret = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (pendingCaret.current === null || !ref.current) return
    ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  }, [value, ref])

  const options = menu ? targets.filter((t) => String(t.number).startsWith(menu.digits)) : []
  const open = menu !== null && options.length > 0

  // The menu is pinned to the viewport: close it rather than let it drift
  useEffect(() => {
    if (!open) return
    const close = () => setMenu(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const refresh = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart
    const typing = el.selectionEnd === caret ? el.value.slice(0, caret).match(TYPING) : null
    if (!typing || targets.length === 0) {
      dismissed.current = null
      setMenu(null)
      return
    }
    const start = caret - typing[2].length - 1
    if (dismissed.current === start) return
    dismissed.current = null
    const point = caretPoint(el, start)
    setMenu((prev) => ({
      start,
      digits: typing[2],
      left: point.left,
      top: point.top,
      active: prev && prev.start === start && prev.digits === typing[2] ? prev.active : 0,
    }))
  }

  const take = (number: number) => {
    const el = ref.current
    if (!el || !menu) return
    const caret = el.selectionStart
    const gap = /^\s/.test(value.slice(caret)) ? '' : ' '
    const inserted = `@${number}${gap}`
    pendingCaret.current = menu.start + inserted.length + (gap ? 0 : 1)
    onChange(value.slice(0, menu.start) + inserted + value.slice(caret))
    setMenu(null)
  }

  return (
    <>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          refresh(e.target)
        }}
        onKeyDown={(e) => {
          if (!open || !menu || e.nativeEvent.isComposing) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setMenu({ ...menu, active: (menu.active + step + options.length) % options.length })
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            take(options[Math.min(menu.active, options.length - 1)].number)
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
          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) refresh(e.currentTarget)
        }}
        onClick={(e) => refresh(e.currentTarget)}
        onBlur={() => setMenu(null)}
        disabled={disabled}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        className={className}
      />
      {open && menu && (
        <ul
          role="listbox"
          aria-label="Reference photos"
          className="soft-shadow fixed z-[60] max-h-64 w-56 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-1"
          style={{ left: Math.min(menu.left, window.innerWidth - 236), top: menu.top }}
          // keep the caret in the text while picking with the mouse
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((target, i) => (
            <li key={target.number} role="option" aria-selected={i === menu.active}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => take(target.number)}
                onMouseEnter={() => setMenu({ ...menu, active: i })}
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs ${
                  i === menu.active ? 'bg-blue-600 text-white' : 'text-zinc-300'
                }`}
              >
                <img src={target.objectUrl} alt="" className="h-9 w-9 shrink-0 rounded-md object-cover" />
                <span className="font-semibold">@{target.number}</span>
                <span className={`min-w-0 flex-1 truncate ${i === menu.active ? 'text-white/80' : 'text-zinc-500'}`}>
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

// Viewport position just under the character at `index`, found by laying the
// text out again in a hidden copy of the textarea
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

function caretPoint(el: HTMLTextAreaElement, index: number): { left: number; top: number } {
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
  marker.textContent = el.value.slice(index) || '.'
  copy.appendChild(marker)
  document.body.appendChild(copy)
  const box = el.getBoundingClientRect()
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4
  const point = {
    left: box.left + marker.offsetLeft - el.scrollLeft,
    top: box.top + marker.offsetTop - el.scrollTop + lineHeight + 4,
  }
  copy.remove()
  return point
}
