import { useState } from 'react'
import type { ReferenceImage, VideoInputMode } from '../../types'
import { ReferenceImageStrip } from '../../components/prompt/ReferenceImageStrip'
import { fileToReference } from '../../lib/imageUtils'

interface Props {
  mode: VideoInputMode
  onModeChange: (mode: VideoInputMode) => void
  references: ReferenceImage[]
  onReferencesChange: (refs: ReferenceImage[]) => void
  firstFrame: ReferenceImage[]
  onFirstFrameChange: (refs: ReferenceImage[]) => void
  lastFrame: ReferenceImage[]
  onLastFrameChange: (refs: ReferenceImage[]) => void
  disabled: boolean
}

// The Veo API forbids mixing reference images with first/last-frame input,
// hence the mode switch. Only the active mode's images are sent on Run.
export function VideoInputPanel({
  mode,
  onModeChange,
  references,
  onReferencesChange,
  firstFrame,
  onFirstFrameChange,
  lastFrame,
  onLastFrameChange,
  disabled,
}: Props) {
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
        } satisfies ReferenceImage
      }),
    )
    if (mode === 'references') {
      onReferencesChange([...references, ...added].slice(0, 3))
    } else {
      // First dropped image fills the first frame, second fills the last frame
      const [a, b] = added
      if (firstFrame.length === 0 && a) {
        onFirstFrameChange([a])
        if (b && lastFrame.length === 0) onLastFrameChange([b])
      } else if (lastFrame.length === 0 && a) {
        onLastFrameChange([a])
      }
    }
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
          Drop images
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium text-zinc-400">Image input</span>
        <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
          <ModeButton active={mode === 'references'} onClick={() => onModeChange('references')} disabled={disabled}>
            References
          </ModeButton>
          <ModeButton active={mode === 'frames'} onClick={() => onModeChange('frames')} disabled={disabled}>
            First / last frame
          </ModeButton>
        </div>
        <span className="text-[10px] text-zinc-600">
          {mode === 'references'
            ? 'Up to 3 images of the character/outfit for consistency — cannot be combined with frame input.'
            : 'The video starts on the first frame; add a last frame for a transition between the two.'}
        </span>
      </div>

      {mode === 'references' ? (
        <ReferenceImageStrip references={references} onChange={onReferencesChange} disabled={disabled} max={3} />
      ) : (
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="mb-1.5 text-[10px] font-medium text-zinc-500">First frame (required)</p>
            <ReferenceImageStrip
              references={firstFrame}
              onChange={onFirstFrameChange}
              disabled={disabled}
              max={1}
              addLabel="First frame"
            />
          </div>
          <div>
            <p className="mb-1.5 text-[10px] font-medium text-zinc-500">Last frame (optional)</p>
            <ReferenceImageStrip
              references={lastFrame}
              onChange={onLastFrameChange}
              disabled={disabled}
              max={1}
              addLabel="Last frame"
            />
          </div>
        </div>
      )}
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean
  onClick: () => void
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1 text-xs transition-colors disabled:opacity-50 ${
        active ? 'bg-blue-500/15 font-medium text-blue-300' : 'text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {children}
    </button>
  )
}
