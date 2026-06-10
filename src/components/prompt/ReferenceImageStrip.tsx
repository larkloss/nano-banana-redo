import { useRef } from 'react'
import type { ReferenceImage } from '../../types'
import { fileToReference } from '../../lib/imageUtils'

const MAX_REFERENCES = 6

interface Props {
  references: ReferenceImage[]
  onChange: (refs: ReferenceImage[]) => void
  disabled: boolean
}

export function ReferenceImageStrip({ references, onChange, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = async (files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'))
    const room = MAX_REFERENCES - references.length
    const added = await Promise.all(
      images.slice(0, room).map(async (file) => {
        const { base64, mimeType } = await fileToReference(file)
        return {
          id: crypto.randomUUID(),
          name: file.name,
          mimeType,
          base64,
          objectUrl: URL.createObjectURL(file),
        } satisfies ReferenceImage
      }),
    )
    if (added.length > 0) onChange([...references, ...added])
  }

  const remove = (id: string) => {
    const target = references.find((r) => r.id === id)
    if (target) URL.revokeObjectURL(target.objectUrl)
    onChange(references.filter((r) => r.id !== id))
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {references.map((ref) => (
        <div key={ref.id} className="group relative">
          <img
            src={ref.objectUrl}
            alt={ref.name}
            title={ref.name}
            className="h-20 w-20 rounded-md border border-zinc-700 object-cover"
          />
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(ref.id)}
              className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-zinc-700 text-xs text-zinc-200 hover:bg-red-600 group-hover:flex"
              title="Remove reference"
            >
              ×
            </button>
          )}
        </div>
      ))}
      {references.length < MAX_REFERENCES && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-400 disabled:opacity-50"
        >
          <span className="text-lg leading-none">+</span>
          <span className="text-[9px]">Reference</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
