import { useState } from 'react'
import type { ReferenceImage } from '../../types'
import { ReferenceImageStrip } from './ReferenceImageStrip'
import { fileToReference } from '../../lib/imageUtils'
import { saveTextAsMarkdown, promptFilename } from '../../lib/saveText'

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
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">Prompt</span>
        <button
          type="button"
          onClick={() => void saveTextAsMarkdown(prompt, promptFilename())}
          disabled={!prompt.trim()}
          title="Save the prompt as a .md file — Chrome/Edge ask where to save it"
          className="rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
        >
          ↓ Save prompt (.md)
        </button>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        disabled={disabled}
        placeholder="Describe the Abigail Chase artwork you want… (your fixed prompt goes here)"
        rows={8}
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
