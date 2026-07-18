import { useState } from 'react'
import type { PromptWorkspaceApi } from '../../hooks/usePromptWorkspace'
import { ModuleCard } from './ModuleCard'
import { ImportSplitDialog } from './ImportSplitDialog'
import { saveTextAsMarkdown, promptFilename } from '../../lib/saveText'

interface Props {
  api: PromptWorkspaceApi
  simplePrompt: string
  disabled: boolean
}

export function ModularPromptEditor({ api, simplePrompt, disabled }: Props) {
  const [importOpen, setImportOpen] = useState(false)
  const { workspace, assembled } = api

  return (
    <div className="space-y-2">
      {workspace.modules.map((module, i) => (
        <ModuleCard
          key={module.id}
          module={module}
          isFirst={i === 0}
          isLast={i === workspace.modules.length - 1}
          api={api}
          disabled={disabled}
        />
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={api.addModule}
          disabled={disabled}
          className="rounded-md border border-dashed border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-300 disabled:opacity-40"
        >
          + Add module
        </button>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          disabled={disabled}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
        >
          Import &amp; split…
        </button>
        <span className="ml-auto text-[10px] text-zinc-600">{assembled.length} chars assembled</span>
        <button
          type="button"
          onClick={() => void saveTextAsMarkdown(assembled, promptFilename())}
          disabled={!assembled}
          title="Save the assembled prompt as a .md file"
          className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
        >
          ↓ Save prompt (.md)
        </button>
      </div>

      <details className="rounded-lg border border-zinc-800 bg-zinc-950/50">
        <summary className="cursor-pointer px-3 py-2 text-[11px] text-zinc-500 hover:text-zinc-400">
          Assembled prompt preview — exactly what is sent on Run
        </summary>
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-zinc-800 p-3 text-[11px] leading-relaxed text-zinc-400">
          {assembled || '(empty — enable modules or add text)'}
        </pre>
      </details>

      {importOpen && (
        <ImportSplitDialog
          simplePrompt={simplePrompt}
          onConfirm={(parts) => {
            api.replaceModules(parts)
            setImportOpen(false)
          }}
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  )
}
