import { useEffect, useMemo, useRef, useState } from 'react'
import type { BaseImage, Candidate, Shape, Tool } from './types'
import { useEditSettings } from './hooks/useEditSettings'
import { useEditEngine } from './hooks/useEditEngine'
import { BaseImageDrop } from './components/BaseImageDrop'
import { fileToBaseImage } from './lib/baseImage'
import { MaskCanvas } from './components/MaskCanvas'
import { Toolbar } from './components/Toolbar'
import { EditSettingsPanel } from './components/EditSettingsPanel'
import { ResultsPanel } from './components/ResultsPanel'
import { RunBar } from '../components/run/RunBar'
import { isMockMode } from '../lib/mockGemini'

const HISTORY_LIMIT = 8

export function EditApp() {
  const { settings, update, apiKeys, setApiKey } = useEditSettings()
  const { runState, candidates, start, stop, recomposite, reset, isRunning } = useEditEngine()
  const [base, setBase] = useState<BaseImage | null>(null)
  const [history, setHistory] = useState<BaseImage[]>([])
  const [shapes, setShapes] = useState<Shape[]>([])
  const [tool, setTool] = useState<Tool>('rect')
  const featherTimer = useRef<number | undefined>(undefined)

  const mock = isMockMode()
  const activeKeys = useMemo(() => {
    const keys = apiKeys.filter(Boolean)
    return mock && keys.length === 0 ? ['mock'] : keys
  }, [apiKeys, mock])

  const runDisabledHint = !base
    ? 'Load an image first.'
    : activeKeys.length === 0
      ? 'Set your Google AI Studio API key in the settings panel first.'
      : shapes.length === 0
        ? 'Select the region to re-render (rectangle, ellipse, or lasso).'
        : !settings.prompt.trim()
          ? 'Describe what to render inside the selection.'
          : null
  const canRun = runDisabledHint === null

  useEffect(() => {
    if (!isRunning) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isRunning])

  // Ctrl/Cmd+Z undoes the last selection shape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !isRunning) {
        e.preventDefault()
        setShapes((prev) => prev.slice(0, -1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isRunning])

  // Feather/blend changes after a run re-composite existing candidates (debounced)
  useEffect(() => {
    if (!base || candidates.length === 0 || isRunning) return
    clearTimeout(featherTimer.current)
    featherTimer.current = window.setTimeout(() => {
      for (const c of candidates) void recomposite(c, base, shapes, settings)
    }, 300)
    return () => clearTimeout(featherTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.feather, settings.seamless])

  const loadImage = (image: BaseImage) => {
    setBase((prev) => {
      if (prev) URL.revokeObjectURL(prev.objectUrl)
      return image
    })
    setHistory([])
    setShapes([])
    reset()
  }

  const accept = async (candidate: Candidate) => {
    if (!base) return
    const next = await fileToBaseImage(candidate.compositeBlob, 'edited.png')
    setHistory((prev) => {
      const stack = [...prev, base]
      while (stack.length > HISTORY_LIMIT) {
        URL.revokeObjectURL(stack[0].objectUrl)
        stack.shift()
      }
      return stack
    })
    setBase(next)
    setShapes([])
    reset()
  }

  const goBack = () => {
    setHistory((prev) => {
      const stack = [...prev]
      const last = stack.pop()
      if (last) {
        setBase((current) => {
          if (current) URL.revokeObjectURL(current.objectUrl)
          return last
        })
        setShapes([])
        reset()
      }
      return stack
    })
  }

  return (
    <div className="flex h-full">
      <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
        <header className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-zinc-100">Nano Banana Edit</h1>
          <span className="text-xs text-zinc-500">
            局部重绘 — re-render only the selected region, everything else stays pixel-identical
          </span>
          {mock && (
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
              MOCK MODE
            </span>
          )}
          {history.length > 0 && (
            <button
              type="button"
              onClick={goBack}
              disabled={isRunning}
              className="ml-auto rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
            >
              ← Back ({history.length})
            </button>
          )}
        </header>

        {!base ? (
          <BaseImageDrop onLoad={loadImage} />
        ) : (
          <>
            <Toolbar
              tool={tool}
              onToolChange={setTool}
              feather={settings.feather}
              onFeatherChange={(feather) => update({ feather })}
              canUndo={shapes.length > 0}
              onUndo={() => setShapes((prev) => prev.slice(0, -1))}
              canClear={shapes.length > 0}
              onClear={() => setShapes([])}
              onReplaceImage={() => {
                setBase((prev) => {
                  if (prev) URL.revokeObjectURL(prev.objectUrl)
                  return null
                })
                history.forEach((h) => URL.revokeObjectURL(h.objectUrl))
                setHistory([])
                setShapes([])
                reset()
              }}
              disabled={isRunning}
            />
            <MaskCanvas
              // Remount on tool/image change so unfinished drafts (e.g. an open
              // polygon) are discarded
              key={`${tool}-${base.objectUrl}`}
              image={base}
              tool={tool}
              shapes={shapes}
              onCommitShape={(shape) => setShapes((prev) => [...prev, shape])}
              disabled={isRunning}
            />
            <textarea
              value={settings.prompt}
              onChange={(e) => update({ prompt: e.target.value })}
              disabled={isRunning}
              placeholder="What should be rendered inside the selected region? e.g. replace the jacket with medieval armor…"
              rows={3}
              spellCheck={false}
              className="w-full resize-y rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500 disabled:opacity-60"
            />
            <RunBar
              runState={runState}
              isRunning={isRunning}
              canRun={canRun}
              runDisabledHint={runDisabledHint}
              onRun={() => void start(activeKeys, base, shapes, settings)}
              onStop={stop}
            />
            <ResultsPanel
              candidates={candidates}
              base={base}
              format={settings.format}
              onAccept={(c) => void accept(c)}
              disabled={isRunning}
            />
          </>
        )}
      </main>
      <EditSettingsPanel
        settings={settings}
        onUpdate={update}
        apiKeys={apiKeys}
        onApiKeyChange={setApiKey}
        disabled={isRunning}
      />
    </div>
  )
}
