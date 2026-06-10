import { useState } from 'react'
import type { BaseImage, Candidate } from '../types'
import { downloadBlob } from '../../lib/imageUtils'

interface Props {
  candidates: Candidate[]
  base: BaseImage
  format: 'png' | 'jpg'
  onAccept: (candidate: Candidate) => void
  disabled: boolean
}

export function ResultsPanel({ candidates, base, format, onAccept, disabled }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)

  if (candidates.length === 0) return null
  const selected = candidates.find((c) => c.id === selectedId) ?? candidates[candidates.length - 1]

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">
          Results <span className="font-normal text-zinc-600">— composited at {base.width}×{base.height}, outside the selection untouched</span>
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onPointerDown={() => setShowOriginal(true)}
            onPointerUp={() => setShowOriginal(false)}
            onPointerLeave={() => setShowOriginal(false)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Hold to compare
          </button>
          <button
            type="button"
            onClick={() =>
              downloadBlob(selected.compositeBlob, `nano-banana-edit_${Date.now()}.${format === 'jpg' ? 'jpg' : 'png'}`)
            }
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Download
          </button>
          <button
            type="button"
            onClick={() => onAccept(selected)}
            disabled={disabled}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            ✓ Accept as new base
          </button>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-lg bg-zinc-950">
        <img
          src={showOriginal ? base.objectUrl : selected.compositeUrl}
          alt="Edit result"
          className="mx-auto max-h-[48vh] object-contain"
          draggable={false}
        />
        {showOriginal && (
          <span className="absolute left-2 top-2 rounded bg-zinc-800/90 px-2 py-0.5 text-[10px] text-zinc-300">
            Original
          </span>
        )}
      </div>

      {candidates.length > 1 && (
        <div className="flex gap-2 overflow-x-auto">
          {candidates.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedId(c.id)}
              className={`shrink-0 overflow-hidden rounded-md border-2 ${
                c.id === selected.id ? 'border-blue-500' : 'border-transparent opacity-70 hover:opacity-100'
              }`}
            >
              <img src={c.compositeUrl} alt={`Candidate ${i + 1}`} className="h-20 w-20 object-cover" />
            </button>
          ))}
        </div>
      )}

      <p className="text-[10px] text-zinc-600">
        Attempt {selected.attempt} · alignment offset ({selected.offset.dx}, {selected.offset.dy})px · region diff{' '}
        {selected.insideDiff.toFixed(1)}
      </p>
    </div>
  )
}
