import { useMemo, useState } from 'react'
import { splitPromptIntoModules, type SplitResult } from '../../lib/promptAssembly'

interface Props {
  simplePrompt: string
  onConfirm: (parts: SplitResult[]) => void
  onClose: () => void
}

export function ImportSplitDialog({ simplePrompt, onConfirm, onClose }: Props) {
  const [text, setText] = useState('')
  const parts = useMemo(() => splitPromptIntoModules(text), [text])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200">Import &amp; split a full prompt</h3>
          <div className="flex gap-2">
            {simplePrompt.trim() && (
              <button
                type="button"
                onClick={() => setText(simplePrompt)}
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800"
              >
                Load from Simple tab
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800"
            >
              ✕
            </button>
          </div>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          spellCheck={false}
          placeholder={'Paste the full prompt template here. Sections are detected from paragraphs starting with "[SECTION]:" or "Label:" markers.'}
          className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500"
        />

        {parts.length > 0 && (
          <div className="max-h-40 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
            <p className="mb-1.5 text-[10px] font-medium text-zinc-500">
              Will create {parts.length} module(s):
            </p>
            {parts.map((p, i) => (
              <p key={i} className="truncate text-[10px] text-zinc-400">
                <span className="text-blue-300">{p.name}</span>
                <span className="text-zinc-600"> — {p.text.split('\n', 1)[0]}</span>
              </p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[10px] text-amber-400/80">
            Confirming replaces ALL current modules (variants included).
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(parts)}
            disabled={parts.length === 0}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
          >
            Replace modules
          </button>
        </div>
      </div>
    </div>
  )
}
