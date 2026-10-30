import { useCallback, useEffect, useState } from 'react'
import { useSettings } from './hooks/useSettings'
import { usePromptFileSync } from './hooks/usePromptFileSync'
import type { PromptFilePayload } from './lib/promptFile'
import { usePromptWorkspace } from './hooks/usePromptWorkspace'
import { useGenerationEngine } from './hooks/useGenerationEngine'
import { usePersistedReferences } from './hooks/usePersistedReferences'
import { RunSettingsPanel } from './components/settings/RunSettingsPanel'
import { PromptPanel } from './components/prompt/PromptPanel'
import { RunBar } from './components/run/RunBar'
import { Gallery } from './components/gallery/Gallery'
import { EditStudio } from './components/studio/EditStudio'
import { useEditStudio } from './hooks/useEditStudio'
import { applyTheme, loadTheme, type Theme } from './lib/theme'
import { isMockMode } from './lib/mockGemini'
import { getModel } from './lib/models'
import { MAX_XAI_SOURCES } from './lib/xai'
import { MAX_OPENAI_SOURCES } from './lib/openai'

function App() {
  const { settings, update, replaceSettings, provider, apiKeys, setApiKey } = useSettings()
  const workspaceApi = usePromptWorkspace()
  const { replaceWorkspace } = workspaceApi
  const adoptFromFile = useCallback(
    (payload: PromptFilePayload) => {
      replaceWorkspace(payload.workspace)
      replaceSettings(payload.settings)
    },
    // replaceSettings is stable for the component's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [replaceWorkspace],
  )
  const sync = usePromptFileSync({ workspace: workspaceApi.workspace, settings, onAdopt: adoptFromFile })
  const { runState, images, start, stop, addImage, clearImages, isRunning } = useGenerationEngine()
  const [references, setReferences] = usePersistedReferences('generator')
  const studio = useEditStudio({ settings, references, onResult: addImage })
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light'
    applyTheme(next)
    setTheme(next)
  }

  // Video models are driven by one whole description, so the modular builder
  // is bypassed entirely for them
  const isVideoModel = getModel(settings.modelId).output === 'video'
  const effectivePrompt =
    !isVideoModel && workspaceApi.workspace.mode === 'modular' ? workspaceApi.assembled : settings.prompt

  // With references, Grok goes through the image-edit endpoint instead of
  // text-to-image, which changes what the other controls do
  const referenceNote = isVideoModel
    ? references.length === 0
      ? null
      : 'Omni decides how to use these from your wording. Tag them to be explicit: "<FIRST_FRAME> …" for a starting ' +
        'frame, "<FIRST_FRAME> <LAST_FRAME> …" to interpolate between two, or "<IMAGE_REF_0>" / "<IMAGE_REF_1>" to ' +
        'reference a subject or style (numbering follows the order shown).'
    : provider === 'openai'
      ? references.length === 0
        ? null
        : `GPT Image edits from these ${references.length} image(s) at full fidelity (the model fixes this itself). ` +
          'Say in the prompt what to keep from them — face, outfit, pose.'
      : provider !== 'xai' || references.length === 0
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
  const runDisabledHint =
    activeKeys.length === 0
      ? provider === 'xai'
        ? 'Set your xAI API key in the settings panel first.'
        : provider === 'openai'
          ? 'Set your OpenAI API key in the settings panel first.'
          : 'Set your Google AI Studio API key in the settings panel first.'
      : !effectivePrompt.trim()
        ? !isVideoModel && workspaceApi.workspace.mode === 'modular'
          ? 'The assembled prompt is empty — fill in or import prompt modules first.'
          : 'Enter a prompt first.'
        : null
  const canRun = runDisabledHint === null

  // Warn before closing the tab mid-run (a generation or an edit)
  const anyRunning = isRunning || studio.isRunning
  useEffect(() => {
    if (!anyRunning) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [anyRunning])

  const model = getModel(settings.modelId)
  const noun = isVideoModel ? 'video' : 'image'
  const runLabel = `Generate ${settings.targetCount} ${settings.targetCount === 1 ? noun : `${noun}s`}`

  return (
    <div className="flex h-full">
      <main className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
        <header className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/20 text-xl" aria-hidden>
            🍌
          </span>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-zinc-100">Nano Banana Studio</h1>
            <p className="truncate text-xs text-zinc-500">
              Abigail Chase fan-art · retries refusals for you · now drawing with{' '}
              <span className="text-zinc-300">{model.label}</span>
            </p>
          </div>
          {mock && (
            <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[10px] font-medium text-amber-400">
              MOCK MODE
            </span>
          )}
          <button
            type="button"
            onClick={toggleTheme}
            className="ml-auto rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            title="Switch between the light and dark look"
          >
            {theme === 'light' ? '🌙 Dark' : '☀️ Light'}
          </button>
        </header>
        <PromptPanel
          prompt={settings.prompt}
          onPromptChange={(prompt) => update({ prompt })}
          workspaceApi={workspaceApi}
          references={references}
          onReferencesChange={setReferences}
          referenceNote={referenceNote}
          maxReferences={
            provider === 'xai'
              ? MAX_XAI_SOURCES
              : provider === 'openai'
                ? MAX_OPENAI_SOURCES
                : getModel(settings.modelId).maxReferences
          }
          singleBox={isVideoModel}
          disabled={isRunning}
        />
        <RunBar
          runState={runState}
          isRunning={isRunning}
          canRun={canRun}
          runDisabledHint={runDisabledHint}
          noun={noun}
          runLabel={runLabel}
          onRun={() => void start(activeKeys, { ...settings, prompt: effectivePrompt }, references)}
          onStop={stop}
        />
        <Gallery images={images} onClear={clearImages} onEdit={studio.open} isRunning={isRunning} />
      </main>
      {studio.openSession && (
        <EditStudio
          // A fresh composer per chain
          key={studio.openSession.id}
          session={studio.openSession}
          settings={settings}
          referenceCount={references.length}
          runState={studio.runState}
          isRunning={studio.isRunning}
          runningTurn={studio.runningTurn}
          onSelectVersion={(versionId) => studio.selectVersion(studio.openSession!.id, versionId)}
          onSubmit={(request) => studio.submit(studio.openSession!.id, request)}
          onRetry={(turnId) => studio.retry(studio.openSession!.id, turnId)}
          onStop={studio.stop}
          onClose={studio.close}
        />
      )}
      {!studio.openSession && studio.isRunning && studio.runningTurn && (
        <button
          type="button"
          onClick={studio.reopenRunning}
          className="soft-shadow fixed bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs text-zinc-200 hover:border-blue-500"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
          Edit in progress{studio.runState ? ` · try ${studio.runState.attempts + 1}` : ''} — open studio
        </button>
      )}
      <RunSettingsPanel
        settings={settings}
        onUpdate={update}
        apiKeys={apiKeys}
        onApiKeyChange={setApiKey}
        sync={sync}
        disabled={isRunning}
      />
    </div>
  )
}

export default App
