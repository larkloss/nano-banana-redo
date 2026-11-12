import { useCallback, useEffect, useRef, useState } from 'react'
import type { GeneratedImage } from '../../types'
import { ImageCard } from './ImageCard'
import { Lightbox } from './Lightbox'
import { downloadAllAsZip } from '../../lib/imageUtils'

interface Props {
  images: GeneratedImage[]
  onClear: () => void
  onEdit: (image: GeneratedImage) => void
  // Brings the user's own pictures in and opens the first in the edit
  // studio; resolves to anything worth telling them (a file that couldn't
  // be read, a picture that was scaled down)
  onUpload: (files: File[]) => Promise<string[]>
  // Whether a picture pasted on the page (Ctrl+V) is taken as an upload —
  // off while the edit studio is open, so a paste can't swap it away
  pasteEnabled: boolean
  isRunning: boolean
}

export function Gallery({ images, onClear, onEdit, onUpload, pasteEnabled, isRunning }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadNotes, setUploadNotes] = useState<string[]>([])
  const [dropping, setDropping] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  // Pictures that arrive while earlier ones are still being opened wait
  // their turn rather than being dropped
  const busy = useRef(false)
  const waiting = useRef<File[]>([])
  const upload = useCallback(
    (list: FileList | File[] | null | undefined) => {
      const files = Array.from(list ?? [])
      if (files.length === 0) return
      if (busy.current) {
        waiting.current.push(...files)
        return
      }
      busy.current = true
      setUploading(true)
      setUploadNotes([])
      // the studio is about to open: not underneath a zoomed picture
      setLightboxIndex(null)
      void (async () => {
        const notes: string[] = []
        try {
          for (let batch = files; batch.length > 0; batch = waiting.current.splice(0)) {
            notes.push(...(await onUpload(batch)))
          }
        } finally {
          busy.current = false
          setUploading(false)
          setUploadNotes(notes)
        }
      })()
    },
    [onUpload],
  )
  // A copied picture or screenshot can simply be pasted
  useEffect(() => {
    if (!pasteEnabled) return
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
      if (files.length === 0) return
      // Office apps put a bitmap next to the copied text: in a text field,
      // the text is what was meant
      const target = e.target
      const inField =
        target instanceof HTMLElement && (target.isContentEditable || target.closest('textarea, input') !== null)
      if (inField && e.clipboardData?.types.includes('text/plain')) return
      e.preventDefault()
      upload(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [pasteEnabled, upload])
  // Pictures can also be dropped anywhere on the gallery — files from
  // outside, that is: dragging one of the page's own pictures also carries a
  // file in Chrome, and must not come back as an upload of itself
  const ownDrag = useRef(false)
  useEffect(() => {
    const started = () => (ownDrag.current = true)
    const ended = () => (ownDrag.current = false)
    window.addEventListener('dragstart', started, true)
    // (dragend comes after the drop; pointerdown in case it never comes)
    window.addEventListener('dragend', ended, true)
    window.addEventListener('pointerdown', ended, true)
    return () => {
      window.removeEventListener('dragstart', started, true)
      window.removeEventListener('dragend', ended, true)
      window.removeEventListener('pointerdown', ended, true)
    }
  }, [])
  const dropZone = {
    onDragOver: (e: React.DragEvent) => {
      if (ownDrag.current || !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDropping(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
    },
    onDrop: (e: React.DragEvent) => {
      if (ownDrag.current || !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDropping(false)
      upload(e.dataTransfer.files)
    },
  }
  const picker = (
    <input
      ref={fileInput}
      type="file"
      accept="image/*"
      multiple
      className="hidden"
      onChange={(e) => {
        upload(e.target.files)
        e.target.value = ''
      }}
    />
  )
  const notes = uploadNotes.length > 0 && (
    <div className="mb-3 flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-400">
      <div className="min-w-0 flex-1 space-y-0.5">
        {uploadNotes.map((note, i) => (
          <p key={i}>{note}</p>
        ))}
      </div>
      <button type="button" onClick={() => setUploadNotes([])} className="shrink-0 hover:text-amber-300" title="Dismiss">
        ✕
      </button>
    </div>
  )
  const [zipping, setZipping] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  // A pending "Remove all?" must not survive into a run that has started
  // (adjusting state during render, React's recommended alternative to an effect)
  const [wasRunning, setWasRunning] = useState(isRunning)
  if (isRunning !== wasRunning) {
    setWasRunning(isRunning)
    if (isRunning) setConfirmClear(false)
  }

  if (images.length === 0) {
    return (
      <div className="flex flex-1 flex-col" {...dropZone}>
        {notes}
        <div
          className={`flex flex-1 flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed px-6 py-14 text-center ${
            dropping ? 'border-blue-500 bg-blue-500/5' : 'border-zinc-800'
          }`}
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-900 text-2xl">🍌</span>
          <p className="text-sm font-medium text-zinc-300">Your pictures will show up here</p>
          <p className="max-w-sm text-xs text-zinc-500">
            Write a prompt, press Generate, and grab a coffee — refused attempts are retried for you. Click “Edit” on
            any picture to keep refining it.
          </p>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="mt-2 rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:border-blue-500 hover:text-blue-300 disabled:opacity-50"
            title="Edit a picture of your own — you can also drop or paste one here"
          >
            {uploading ? 'Opening…' : '⬆ Or upload a picture to edit'}
          </button>
          {picker}
        </div>
      </div>
    )
  }

  const editable = (image: GeneratedImage) => (image.kind === 'image' ? () => onEdit(image) : undefined)

  return (
    <div
      className={`flex-1 rounded-3xl ${dropping ? 'outline-dashed outline-2 outline-offset-8 outline-blue-500' : ''}`}
      {...dropZone}
    >
      {notes}
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-200">
          Your pictures <span className="font-normal text-zinc-500">· {images.length} this session</span>
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="rounded-full border border-zinc-700 px-3.5 py-1.5 text-xs text-zinc-300 hover:border-blue-500 hover:text-blue-300 disabled:opacity-50"
            title="Edit a picture of your own — you can also drop or paste one here"
          >
            {uploading ? 'Opening…' : '⬆ Upload to edit'}
          </button>
          {picker}
          {images.length >= 2 && (
            <button
              type="button"
              disabled={zipping}
              onClick={() => {
                setZipping(true)
                void downloadAllAsZip(images).finally(() => setZipping(false))
              }}
              className="rounded-full border border-zinc-700 px-3.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {zipping ? 'Zipping…' : '↓ Download all'}
            </button>
          )}
          {confirmClear && !isRunning ? (
            <span className="flex items-center gap-1 rounded-full border border-red-500/40 px-1 py-0.5 text-xs">
              <span className="px-1.5 text-zinc-400">Remove all?</span>
              <button
                type="button"
                onClick={() => {
                  setConfirmClear(false)
                  onClear()
                }}
                className="rounded-full bg-red-600 px-2.5 py-1 text-white hover:bg-red-500"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="rounded-full px-2.5 py-1 text-zinc-400 hover:bg-zinc-800"
              >
                No
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={isRunning}
              className="rounded-full border border-zinc-700 px-3.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {images.map((image, i) => (
          <ImageCard
            key={image.id}
            image={image}
            index={i}
            onOpen={() => setLightboxIndex(i)}
            onEdit={editable(image)}
          />
        ))}
      </div>
      {lightboxIndex !== null && (
        <Lightbox
          images={images}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onEdit={(image) => {
            setLightboxIndex(null)
            onEdit(image)
          }}
        />
      )}
    </div>
  )
}
