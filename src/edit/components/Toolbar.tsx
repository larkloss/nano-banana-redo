import type { Tool } from '../types'

interface Props {
  tool: Tool
  onToolChange: (tool: Tool) => void
  feather: number
  onFeatherChange: (px: number) => void
  canUndo: boolean
  onUndo: () => void
  canClear: boolean
  onClear: () => void
  onReplaceImage: () => void
  disabled: boolean
}

const TOOLS: { value: Tool; label: string; icon: string }[] = [
  { value: 'rect', label: 'Rectangle', icon: '▭' },
  { value: 'ellipse', label: 'Ellipse', icon: '◯' },
  { value: 'lasso', label: 'Lasso', icon: '✎' },
]

export function Toolbar({
  tool,
  onToolChange,
  feather,
  onFeatherChange,
  canUndo,
  onUndo,
  canClear,
  onClear,
  onReplaceImage,
  disabled,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="flex gap-1">
        {TOOLS.map((t) => (
          <button
            key={t.value}
            type="button"
            title={t.label}
            disabled={disabled}
            onClick={() => onToolChange(t.value)}
            className={`rounded-md border px-2.5 py-1 text-xs disabled:opacity-50 ${
              tool === t.value
                ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <span className="h-5 w-px bg-zinc-800" />
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo || disabled}
        className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
      >
        ⌫ Undo
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={!canClear || disabled}
        className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
      >
        Clear selection
      </button>
      <span className="h-5 w-px bg-zinc-800" />
      <label className="flex items-center gap-2 text-xs text-zinc-400">
        Feather
        <input
          type="range"
          min={0}
          max={64}
          value={feather}
          disabled={disabled}
          onChange={(e) => onFeatherChange(Number(e.target.value))}
          className="w-24 accent-blue-500"
        />
        <span className="w-8 text-zinc-500">{feather}px</span>
      </label>
      <span className="ml-auto" />
      <button
        type="button"
        onClick={onReplaceImage}
        disabled={disabled}
        className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
      >
        Replace image
      </button>
    </div>
  )
}
