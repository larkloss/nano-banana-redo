import type { PromptWorkspaceApi } from '../../hooks/usePromptWorkspace'
import { ModularPromptEditor } from '../../components/prompt/ModularPromptEditor'
import { saveTextAsMarkdown, promptFilename } from '../../lib/saveText'

interface Props {
  prompt: string
  onPromptChange: (prompt: string) => void
  workspaceApi: PromptWorkspaceApi
  disabled: boolean
}

// Same Modular | Simple prompt UI as the generator, but bound to the video
// app's own workspace (separate localStorage) and simple-prompt setting.
export function VideoPromptPanel({ prompt, onPromptChange, workspaceApi, disabled }: Props) {
  const mode = workspaceApi.workspace.mode

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
          <TabButton active={mode === 'modular'} onClick={() => workspaceApi.setMode('modular')} disabled={disabled}>
            Modular
          </TabButton>
          <TabButton active={mode === 'simple'} onClick={() => workspaceApi.setMode('simple')} disabled={disabled}>
            Simple
          </TabButton>
        </div>
        {mode === 'simple' && (
          <button
            type="button"
            onClick={() => void saveTextAsMarkdown(prompt, promptFilename())}
            disabled={!prompt.trim()}
            title="Save the prompt as a .md file"
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
          >
            ↓ Save prompt (.md)
          </button>
        )}
      </div>

      {mode === 'simple' ? (
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          disabled={disabled}
          placeholder="Describe the video — subject, action, camera movement, environment, audio cues…"
          rows={8}
          spellCheck={false}
          className="w-full resize-y rounded-md bg-transparent text-sm leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none disabled:opacity-60"
        />
      ) : (
        <ModularPromptEditor api={workspaceApi} simplePrompt={prompt} disabled={disabled} />
      )}
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
