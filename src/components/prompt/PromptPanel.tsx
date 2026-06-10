import { useState } from 'react'
import type { ReferenceImage } from '../../types'
import { ReferenceImageStrip } from './ReferenceImageStrip'
import { fileToReference } from '../../lib/imageUtils'

interface Props {
  prompt: string
  onPromptChange: (prompt: string) => void
  references: ReferenceImage[]
  onReferencesChange: (refs: ReferenceImage[]) => void
  disabled: boolean
}

export function PromptPanel({ prompt, onPromptChange, references, onReferencesChange, disabled }: Props) {
  const [dragOver, setDragOver] = useState(false)

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (disabled) return
    const images = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    const added = await Promise.all(
      images.map(async (file) => {
        const { base64, mimeType } = await fileToReference(file)
        return {
          id: crypto.randomUUID(),
          name: file.name,
          mimeType,
          base64,
          objectUrl: URL.createObjectURL(file),
        }
      }),
    )
    onReferencesChange([...references, ...added].slice(0, 6))
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`relative rounded-xl border bg-zinc-900/60 p-4 transition-colors ${
        dragOver ? 'border-blue-500' : 'border-zinc-800'
      }`}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-blue-500/10 text-sm text-blue-300">
          Drop reference images
        </div>
      )}
      <textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        disabled={disabled}
        placeholder="Describe the Abigail Chase artwork you want… (your fixed prompt goes here)"
        rows={6}
        spellCheck={false}
        className="w-full resize-y rounded-md bg-transparent text-sm leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none disabled:opacity-60"
      />
      <div className="mt-3 border-t border-zinc-800 pt-3">
        <div className="mb-2 text-xs font-medium text-zinc-400">
          Reference images <span className="font-normal text-zinc-600">(optional — drag &amp; drop or click +)</span>
        </div>
        <ReferenceImageStrip references={references} onChange={onReferencesChange} disabled={disabled} />
      </div>
    </div>
  )
}
