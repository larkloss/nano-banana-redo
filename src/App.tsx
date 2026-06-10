import { useEffect, useState } from 'react'
import type { ReferenceImage } from './types'
import { useSettings } from './hooks/useSettings'
import { useGenerationEngine } from './hooks/useGenerationEngine'
import { RunSettingsPanel } from './components/settings/RunSettingsPanel'
import { PromptPanel } from './components/prompt/PromptPanel'
import { RunBar } from './components/run/RunBar'
import { Gallery } from './components/gallery/Gallery'
import { isMockMode } from './lib/mockGemini'

function App() {
  const { settings, update, apiKeys, setApiKey } = useSettings()
  const { runState, images, start, stop, clearImages, isRunning } = useGenerationEngine()
  const [references, setReferences] = useState<ReferenceImage[]>([])

  const mock = isMockMode()
  const activeKeys = mock
    ? apiKeys.filter(Boolean).length > 0
      ? apiKeys.filter(Boolean)
      : ['mock']
    : apiKeys.filter(Boolean)
  const runDisabledHint = activeKeys.length === 0
    ? 'Set your Google AI Studio API key in the settings panel first.'
    : !settings.prompt.trim()
      ? 'Enter a prompt first.'
      : null
  const canRun = runDisabledHint === null

  // Warn before closing the tab mid-run
  useEffect(() => {
    if (!isRunning) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isRunning])

  return (
    <div className="flex h-full">
      <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        <header className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-zinc-100">Nano Banana Redo</h1>
          <span className="text-xs text-zinc-500">Abigail Chase fan-art studio · auto-retry until done</span>
          {mock && (
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
              MOCK MODE
            </span>
          )}
        </header>
        <PromptPanel
          prompt={settings.prompt}
          onPromptChange={(prompt) => update({ prompt })}
          references={references}
          onReferencesChange={setReferences}
          disabled={isRunning}
        />
        <RunBar
          runState={runState}
          isRunning={isRunning}
          canRun={canRun}
          runDisabledHint={runDisabledHint}
          onRun={() => void start(activeKeys, settings, references)}
          onStop={stop}
        />
        <Gallery images={images} onClear={clearImages} isRunning={isRunning} />
      </main>
      <RunSettingsPanel
        settings={settings}
        onUpdate={update}
        apiKeys={apiKeys}
        onApiKeyChange={setApiKey}
        disabled={isRunning}
      />
    </div>
  )
}

export default App
