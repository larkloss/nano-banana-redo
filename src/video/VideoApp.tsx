import { useEffect, useState } from 'react'
import type { ReferenceImage } from '../types'
import { useVideoSettings } from '../hooks/useVideoSettings'
import { useVideoEngine } from '../hooks/useVideoEngine'
import { usePromptWorkspace } from '../hooks/usePromptWorkspace'
import { VIDEO_WORKSPACE_KEY, VIDEO_MODULE_NAMES } from '../lib/storage'
import { estimateVideoCost } from '../lib/veoModels'
import { isMockMode } from '../lib/mockGemini'
import { VideoPromptPanel } from './components/VideoPromptPanel'
import { VideoInputPanel } from './components/VideoInputPanel'
import { VideoRunBar } from './components/VideoRunBar'
import { VideoGallery } from './components/VideoGallery'
import { VideoSettingsPanel } from './components/VideoSettingsPanel'

export function VideoApp() {
  const { settings, update, apiKeys, setApiKey } = useVideoSettings()
  const workspaceApi = usePromptWorkspace(VIDEO_WORKSPACE_KEY, VIDEO_MODULE_NAMES)
  const { runState, videos, start, stop, removeVideo, clearVideos, isRunning } = useVideoEngine()
  const [references, setReferences] = useState<ReferenceImage[]>([])
  const [firstFrame, setFirstFrame] = useState<ReferenceImage[]>([])
  const [lastFrame, setLastFrame] = useState<ReferenceImage[]>([])

  const effectivePrompt =
    workspaceApi.workspace.mode === 'modular' ? workspaceApi.assembled : settings.prompt

  const mock = isMockMode()
  const activeKeys = mock
    ? apiKeys.filter(Boolean).length > 0
      ? apiKeys.filter(Boolean)
      : ['mock']
    : apiKeys.filter(Boolean)

  const runDisabledHint =
    activeKeys.length === 0
      ? 'Set your Google AI Studio API key in the settings panel first (Veo needs a paid-tier key).'
      : !effectivePrompt.trim()
        ? workspaceApi.workspace.mode === 'modular'
          ? 'The assembled prompt is empty — fill in or import prompt modules first.'
          : 'Enter a prompt first.'
        : settings.inputMode === 'frames' && firstFrame.length === 0
          ? 'First/last frame mode needs a first-frame image — add one or switch to References.'
          : null
  const canRun = runDisabledHint === null

  const estimate = estimateVideoCost(settings)
  const costLine = `Estimated ≈ $${estimate.toFixed(2)}/video at current settings (rough preview pricing).`

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
          <h1 className="text-lg font-semibold text-zinc-100">Nano Banana Video</h1>
          <span className="text-xs text-zinc-500">Abigail Chase clips · Veo 3.1 · auto-retry until done</span>
          {mock && (
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
              MOCK MODE
            </span>
          )}
        </header>
        <VideoPromptPanel
          prompt={settings.prompt}
          onPromptChange={(prompt) => update({ prompt })}
          workspaceApi={workspaceApi}
          disabled={isRunning}
        />
        <VideoInputPanel
          mode={settings.inputMode}
          onModeChange={(inputMode) => update({ inputMode })}
          references={references}
          onReferencesChange={setReferences}
          firstFrame={firstFrame}
          onFirstFrameChange={setFirstFrame}
          lastFrame={lastFrame}
          onLastFrameChange={setLastFrame}
          disabled={isRunning}
        />
        <VideoRunBar
          runState={runState}
          isRunning={isRunning}
          canRun={canRun}
          runDisabledHint={runDisabledHint}
          costLine={costLine}
          onRun={() =>
            void start({
              keys: activeKeys,
              settings: { ...settings, prompt: effectivePrompt },
              prompt: effectivePrompt,
              references: settings.inputMode === 'references' ? references : [],
              firstFrame: settings.inputMode === 'frames' ? (firstFrame[0] ?? null) : null,
              lastFrame: settings.inputMode === 'frames' ? (lastFrame[0] ?? null) : null,
            })
          }
          onStop={stop}
        />
        <VideoGallery videos={videos} onRemove={removeVideo} onClear={clearVideos} isRunning={isRunning} />
      </main>
      <VideoSettingsPanel
        settings={settings}
        onUpdate={update}
        apiKeys={apiKeys}
        onApiKeyChange={setApiKey}
        disabled={isRunning}
      />
    </div>
  )
}
