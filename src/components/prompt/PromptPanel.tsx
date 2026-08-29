import { useState } from 'react'
import type { ReferenceImage } from '../../types'
import type { PromptWorkspaceApi } from '../../hooks/usePromptWorkspace'
import { ReferenceImageStrip } from './ReferenceImageStrip'
import { ModularPromptEditor } from './ModularPromptEditor'
import { ExpandableTextarea } from '../common/ExpandableTextarea'
import { fileToReference } from '../../lib/imageUtils'
import { saveTextAsMarkdown, promptFilename } from '../../lib/saveText'

interface Props {
  prompt: string
  onPromptChange: (prompt: string) => void
  workspaceApi: PromptWorkspaceApi
  references: ReferenceImage[]
  onReferencesChange: (refs: ReferenceImage[]) => void
  // Provider-specific caveat about how the references will actually be used
  referenceNote?: string | null
  maxReferences?: number
  // Video models take one whole description; the modular builder is hidden
  singleBox?: boolean
  disabled: boolean
}

export function PromptPanel({
  prompt,
  onPromptChange,
  workspaceApi,
  references,
  onReferencesChange,
  referenceNote,
  maxReferences = 6,
  singleBox = false,
  disabled,
}: Props) {
  const [dragOver, setDragOver] = useState(false)
  const mode = workspaceApi.workspace.mode

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
    onReferencesChange([...references, ...added].slice(0, maxReferences))
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

      <div className="mb-3 flex items-center justify-between">
        {singleBox ? (
          <span className="text-xs font-medium text-zinc-400">
            Video prompt{' '}
            <span className="font-normal text-zinc-600">
              — one whole description: scene, camera, action, audio, timing
            </span>
          </span>
        ) : (
          <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
            <TabButton active={mode === 'modular'} onClick={() => workspaceApi.setMode('modular')} disabled={disabled}>
              Modular
            </TabButton>
            <TabButton active={mode === 'simple'} onClick={() => workspaceApi.setMode('simple')} disabled={disabled}>
              Simple
            </TabButton>
          </div>
        )}
        {(singleBox || mode === 'simple') && (
          <button
            type="button"
            onClick={() => void saveTextAsMarkdown(prompt, promptFilename())}
            disabled={!prompt.trim()}
            title="Save the prompt as a .md file — Chrome/Edge ask where to save it"
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
          >
            ↓ Save prompt (.md)
          </button>
        )}
      </div>

      {singleBox || mode === 'simple' ? (
        <ExpandableTextarea
          value={prompt}
          onChange={onPromptChange}
          label="Prompt"
          disabled={disabled}
          placeholder={
            singleBox
              ? 'Describe the shot — subject, camera move, lighting, audio. Negatives go here too ("no dialogue", "single unbroken shot").'
              : 'Describe the Abigail Chase artwork you want… (your fixed prompt goes here)'
          }
          rows={singleBox ? 10 : 8}
          className="w-full resize-y rounded-md bg-transparent text-sm leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none disabled:opacity-60"
        />
      ) : (
        <ModularPromptEditor api={workspaceApi} simplePrompt={prompt} disabled={disabled} />
      )}

      <div className="mt-3 border-t border-zinc-800 pt-3">
        <div className="mb-2 text-xs font-medium text-zinc-400">
          Reference images <span className="font-normal text-zinc-600">(optional — drag &amp; drop or click +)</span>
        </div>
        <ReferenceImageStrip
          references={references}
          onChange={onReferencesChange}
          disabled={disabled}
          max={maxReferences}
        />
        {referenceNote && <p className="mt-2 text-[10px] text-amber-400/90">{referenceNote}</p>}
      </div>
    </div>
  )
}

function TabButton({
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
