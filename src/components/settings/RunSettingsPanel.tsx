import { useState } from 'react'
import type { Settings } from '../../types'
import { MODELS, PROVIDER_LABELS, getModel } from '../../lib/models'
import { listXaiModels } from '../../lib/xai'
import { ApiKeySection } from './ApiKeySection'
import { MaxAttemptsControl } from './MaxAttemptsControl'
import { ExpandableTextarea } from '../common/ExpandableTextarea'

interface Props {
  settings: Settings
  onUpdate: (patch: Partial<Settings>) => void
  apiKeys: [string, string, string]
  onApiKeyChange: (index: 0 | 1 | 2, key: string) => void
  disabled: boolean
}

const SIZES = ['1K', '2K', '4K'] as const
const XAI_RESOLUTIONS = ['1k', '2k'] as const
const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
] as const

const XAI_KEY_NOTE =
  "Keys are stored in this browser's localStorage and sent directly to api.x.ai. Get one from the xAI " +
  'console — a Gemini key will not work here, and vice versa. Each provider keeps its own keys.'

export function RunSettingsPanel({ settings, onUpdate, apiKeys, onApiKeyChange, disabled }: Props) {
  const model = getModel(settings.modelId)
  const isXai = model.provider === 'xai'

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l border-zinc-800 bg-zinc-925 bg-zinc-900/40 p-4">
      <h2 className="text-sm font-semibold text-zinc-300">Run settings</h2>

      <Field label="Model">
        <select
          value={settings.modelId}
          onChange={(e) => onUpdate({ modelId: e.target.value })}
          disabled={disabled}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:opacity-50"
        >
          {(['gemini', 'xai'] as const).map((provider) => (
            <optgroup key={provider} label={PROVIDER_LABELS[provider]}>
              {MODELS.filter((m) => m.provider === provider).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.id}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="mt-1 text-[10px] text-zinc-600">{model.description}</p>
      </Field>

      {isXai && (
        <Field label="Model ID override">
          <input
            type="text"
            value={settings.xaiModelId}
            onChange={(e) => onUpdate({ xaiModelId: e.target.value })}
            disabled={disabled}
            placeholder={model.id}
            spellCheck={false}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <p className="mt-1 text-[10px] text-zinc-600">
            Sent instead of the preset above when filled. Empty = use the preset.
          </p>
          <XaiModelDiscovery
            apiKey={apiKeys.find(Boolean) ?? ''}
            disabled={disabled}
            onPick={(id) => onUpdate({ xaiModelId: id })}
          />
        </Field>
      )}

      {model.supportsSystemInstruction && (
        <Field label="System instructions">
          <ExpandableTextarea
            value={settings.systemInstruction}
            onChange={(systemInstruction) => onUpdate({ systemInstruction })}
            label="System instructions"
            disabled={disabled}
            placeholder="Optional tone and style instructions for the model…"
            rows={4}
            className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <p className="mt-1 text-[10px] text-zinc-600">
            Sent with every attempt, separate from the prompt. Leave empty to send none.
          </p>
        </Field>
      )}

      <Field label="Aspect ratio">
        <div className="flex flex-wrap gap-1.5">
          <Chip
            active={settings.aspectRatio === 'auto'}
            onClick={() => onUpdate({ aspectRatio: 'auto' })}
            disabled={disabled}
          >
            Auto
          </Chip>
          {model.aspectRatios.map((r) => (
            <Chip
              key={r}
              active={settings.aspectRatio === r}
              onClick={() => onUpdate({ aspectRatio: r })}
              disabled={disabled}
            >
              {r}
            </Chip>
          ))}
        </div>
      </Field>

      {model.supportsImageSize && (
        <Field label="Image size">
          <div className="grid grid-cols-3 gap-1.5">
            {SIZES.map((s) => (
              <Chip
                key={s}
                active={settings.imageSize === s}
                onClick={() => onUpdate({ imageSize: s })}
                disabled={disabled}
                wide
              >
                {s}
              </Chip>
            ))}
          </div>
        </Field>
      )}

      {model.supportsResolution && (
        <Field label="Resolution">
          <div className="grid grid-cols-2 gap-1.5">
            {XAI_RESOLUTIONS.map((r) => (
              <Chip
                key={r}
                active={settings.xaiResolution === r}
                onClick={() => onUpdate({ xaiResolution: r })}
                disabled={disabled}
                wide
              >
                {r.toUpperCase()}
              </Chip>
            ))}
          </div>
        </Field>
      )}

      <Field label="Output format">
        <div className="grid grid-cols-2 gap-1.5">
          {FORMATS.map((f) => (
            <Chip
              key={f.value}
              active={settings.format === f.value}
              onClick={() => onUpdate({ format: f.value })}
              disabled={disabled}
              wide
            >
              {f.label}
            </Chip>
          ))}
        </div>
      </Field>

      <Field label={`Number of images · ${settings.targetCount}`}>
        <input
          type="range"
          min={1}
          max={12}
          value={settings.targetCount}
          onChange={(e) => onUpdate({ targetCount: Number(e.target.value) })}
          disabled={disabled}
          className="w-full accent-blue-500"
        />
        <p className="mt-1 text-[10px] text-zinc-600">
          Auto-retries failed generations until this many images are collected.
        </p>
      </Field>

      <Field label="Max attempts">
        <MaxAttemptsControl
          value={settings.attemptsCap}
          onChange={(attemptsCap) => onUpdate({ attemptsCap })}
          disabled={disabled}
        />
        <p className="mt-1 text-[10px] text-zinc-600">
          Safety cap: the run stops here even if fewer images were collected, so a permanently
          blocked prompt can't burn quota forever.
        </p>
      </Field>

      <div className="mt-auto border-t border-zinc-800 pt-4">
        <ApiKeySection
          // Remount on provider switch so the inputs show the new key set
          key={model.provider}
          apiKeys={apiKeys}
          onChange={onApiKeyChange}
          providerName={isXai ? 'xAI API' : undefined}
          placeholder={isXai ? 'xai-…' : undefined}
          note={isXai ? XAI_KEY_NOTE : undefined}
        />
      </div>
    </aside>
  )
}

// Lists the model IDs the key itself can use — the only reliable way to learn
// the ID of a model released after this app was built.
function XaiModelDiscovery({
  apiKey,
  disabled,
  onPick,
}: {
  apiKey: string
  disabled: boolean
  onPick: (id: string) => void
}) {
  const [state, setState] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'done'; ids: string[] } | { status: 'error'; message: string }
  >({ status: 'idle' })

  const fetchModels = async () => {
    setState({ status: 'loading' })
    try {
      const ids = await listXaiModels(apiKey)
      setState({ status: 'done', ids })
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const imageIds = state.status === 'done' ? state.ids.filter((id) => /imag/i.test(id)) : []
  const shown = state.status === 'done' ? (imageIds.length > 0 ? imageIds : state.ids) : []

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void fetchModels()}
        disabled={disabled || !apiKey || state.status === 'loading'}
        title={apiKey ? 'Ask xAI which models this key can use' : 'Enter your xAI API key below first'}
        className="rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
      >
        {state.status === 'loading' ? 'Loading…' : 'List models my key can use'}
      </button>
      {state.status === 'error' && (
        <p className="mt-1.5 text-[10px] text-red-400">Could not list models — {state.message}</p>
      )}
      {state.status === 'done' && shown.length === 0 && (
        <p className="mt-1.5 text-[10px] text-amber-400/90">The API returned no model list for this key.</p>
      )}
      {shown.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {shown.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onPick(id)}
              disabled={disabled}
              className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-blue-300 hover:border-blue-500 disabled:opacity-40"
            >
              {id}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-zinc-400">{label}</div>
      {children}
    </div>
  )
}

export function Chip({
  active,
  onClick,
  disabled,
  wide,
  children,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-2.5 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
        wide ? 'w-full' : ''
      } ${
        active
          ? 'border-blue-500 bg-blue-500/15 text-blue-300'
          : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
      }`}
    >
      {children}
    </button>
  )
}
