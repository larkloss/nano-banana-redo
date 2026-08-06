import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (value: string) => void
  label: string
  disabled?: boolean
  placeholder?: string
  rows?: number
  className?: string
}

// Textarea with a corner "⤢" button that pops the same value into a large
// modal editor. The modal binds the SAME value/onChange (live sync, no draft),
// so debounced persistence and variant dirty-markers behave exactly as if the
// user typed inline.
export function ExpandableTextarea({ value, onChange, label, disabled, placeholder, rows, className }: Props) {
  const [expanded, setExpanded] = useState(false)
  // Stable identity — a new function every render would re-trigger the modal's
  // mount effects on each keystroke and yank the cursor to the end of the text
  const closeExpanded = useCallback(() => setExpanded(false), [])

  return (
    <div className="relative">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        className={className}
      />
      {!disabled && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title={`Expand "${label}" into a large editor`}
          className="absolute right-1.5 top-1.5 rounded-md border border-zinc-700/60 bg-zinc-900/80 px-1.5 py-0.5 text-[11px] leading-none text-zinc-500 opacity-60 transition-opacity hover:bg-zinc-800 hover:text-zinc-200 hover:opacity-100"
        >
          ⤢
        </button>
      )}
      {expanded && (
        <ExpandedEditor
          value={value}
          onChange={onChange}
          label={label}
          placeholder={placeholder}
          onClose={closeExpanded}
        />
      )}
    </div>
  )
}

function ExpandedEditor({
  value,
  onChange,
  label,
  placeholder,
  onClose,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder?: string
  onClose: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Mount-only: place the cursor at the end when the modal opens. Must not
  // re-run on later renders or it would snap the cursor back on every edit.
  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div
        className="flex h-[80vh] w-[min(56rem,92vw)] flex-col rounded-xl border border-zinc-700 bg-zinc-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200">{label}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="min-h-0 w-full flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-950 p-3 text-sm leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500"
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[10px] text-zinc-600">{value.length} chars · edits apply immediately</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
