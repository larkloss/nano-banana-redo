import { useEffect } from 'react'
import { useSettings } from './hooks/useSettings'
import { usePromptWorkspace } from './hooks/usePromptWorkspace'
import { useGenerationEngine } from './hooks/useGenerationEngine'
import { usePersistedReferences } from './hooks/usePersistedReferences'
import { RunSettingsPanel } from './components/settings/RunSettingsPanel'
import { PromptPanel } from './components/prompt/PromptPanel'
import { RunBar } from './components/run/RunBar'
import { Gallery } from './components/gallery/Gallery'
import { isMockMode } from './lib/mockGemini'
import { MAX_XAI_SOURCES } from './lib/xai'

function App() {
  const { settings, update, provider, apiKeys, setApiKey } = useSettings()
  const workspaceApi = usePromptWorkspace()
  const { runState, images, start, stop, clearImages, isRunning } = useGenerationEngine()
  const [references, setReferences] = usePersistedReferences('generator')

  const effectivePrompt =
    workspaceApi.workspace.mode === 'modular' ? workspaceApi.assembled : settings.prompt

  // With references, Grok goes through the image-edit endpoint instead of
  // text-to-image, which changes what the other controls do
  const referenceNote =
    provider !== 'xai' || references.length === 0
      ? null
      : references.length > MAX_XAI_SOURCES
        ? `xAI accepts at most ${MAX_XAI_SOURCES} source images — only the first ${MAX_XAI_SOURCES} are sent.`
        : references.length > 1
          ? `Grok edits from these ${references.length} images, in the order shown. The first one sets the output ` +
            'aspect ratio unless you pick a specific ratio above.'
          : 'Grok will edit from this image. On "Auto" the output keeps the source ratio — pick a specific ratio to override it.'

  const mock = isMockMode()
  const activeKeys = mock
    ? apiKeys.filter(Boolean).length > 0
      ? apiKeys.filter(Boolean)
      : ['mock']
    : apiKeys.filter(Boolean)
  const runDisabledHint = activeKeys.length === 0
    ? provider === 'xai'
      ? 'Set your xAI API key in the settings panel first.'
      : 'Set your Google AI Studio API key in the settings panel first.'
    : !effectivePrompt.trim()
      ? workspaceApi.workspace.mode === 'modular'
        ? 'The assembled prompt is empty — fill in or import prompt modules first.'
        : 'Enter a prompt first.'
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
          workspaceApi={workspaceApi}
          references={references}
          onReferencesChange={setReferences}
          referenceNote={referenceNote}
          maxReferences={provider === 'xai' ? MAX_XAI_SOURCES : 6}
          disabled={isRunning}
        />
        <RunBar
          runState={runState}
          isRunning={isRunning}
          canRun={canRun}
          runDisabledHint={runDisabledHint}
          onRun={() => void start(activeKeys, { ...settings, prompt: effectivePrompt }, references)}
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
