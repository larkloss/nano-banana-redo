import { useRef, useState } from 'react'
import type { BaseImage } from '../types'
import { fileToBaseImage } from '../lib/baseImage'

interface Props {
  onLoad: (image: BaseImage) => void
}

export function BaseImageDrop({ onLoad }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = async (file: File) => {
    if (!file.type.startsWith('image/')) return
    setLoading(true)
    try {
      onLoad(await fileToBaseImage(file))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const file = e.dataTransfer.files[0]
        if (file) void load(file)
      }}
      onClick={() => inputRef.current?.click()}
      className={`flex flex-1 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-10 text-sm transition-colors ${
        dragOver ? 'border-blue-500 bg-blue-500/5 text-blue-300' : 'border-zinc-700 text-zinc-500 hover:border-zinc-500'
      }`}
    >
      <span className="text-3xl">🖼️</span>
      <span>{loading ? 'Loading…' : 'Drop an image here, or click to choose'}</span>
      <span className="text-[10px] text-zinc-600">
        Then select the region(s) to re-render — everything outside stays untouched.
      </span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void load(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
