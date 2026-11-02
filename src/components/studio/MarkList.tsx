import { useEffect, useLayoutEffect, useRef } from 'react'
import { MARK_ACTIONS, markColor, type EditMark } from '../../lib/annotate'

interface Props {
  marks: EditMark[]
  activeId: string | null
  onActivate: (id: string) => void
  onChange: (id: string, text: string) => void
  onRemove: (id: string) => void
  onSubmit: () => void
}

// One row per arrow on the picture: its number, what to do there, and quick
// starting points for the common cases
export function MarkList({ marks, activeId, onActivate, onChange, onRemove, onSubmit }: Props) {
  const inputs = useRef(new Map<string, HTMLInputElement>())
  // Row whose quick action just filled its input: once the new text is in,
  // put the caret at its end so typing carries on from there
  const caretToEnd = useRef<string | null>(null)
  useLayoutEffect(() => {
    const id = caretToEnd.current
    if (!id) return
    caretToEnd.current = null
    const input = inputs.current.get(id)
    if (!input) return
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  })

  // A freshly placed (or clicked) arrow puts the cursor in its row
  useEffect(() => {
    if (activeId) inputs.current.get(activeId)?.focus()
  }, [activeId])

  return (
    <div className="space-y-2 border-b border-zinc-800 px-2.5 pb-2.5 pt-2.5">
      {marks.map((mark, i) => {
        const color = markColor(i).css
        return (
          <div
            key={mark.id}
            className={`rounded-xl border p-2 ${mark.id === activeId ? 'border-blue-500 bg-blue-500/5' : 'border-zinc-800'}`}
          >
            <div className="flex items-center gap-2">
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                style={{ backgroundColor: color }}
              >
                {i + 1}
              </span>
              <input
                ref={(el) => {
                  if (el) inputs.current.set(mark.id, el)
                  else inputs.current.delete(mark.id)
                }}
                value={mark.text}
                onFocus={() => onActivate(mark.id)}
                onChange={(e) => onChange(mark.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    onSubmit()
                  }
                }}
                placeholder="What should change here?"
                className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none"
              />
              <button
                type="button"
                onClick={() => onRemove(mark.id)}
                title="Remove this arrow"
                className="shrink-0 rounded-full px-1.5 text-zinc-500 hover:text-red-400"
              >
                ✕
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1 pl-7">
              {MARK_ACTIONS.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => {
                    caretToEnd.current = mark.id
                    onChange(mark.id, action.text)
                  }}
                  className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-blue-500 hover:text-blue-300"
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
