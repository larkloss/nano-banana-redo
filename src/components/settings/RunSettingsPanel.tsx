import type { Settings } from '../../types'
import { MODELS, getModel } from '../../lib/models'
import { ApiKeySection } from './ApiKeySection'

interface Props {
  settings: Settings
  onUpdate: (patch: Partial<Settings>) => void
  apiKeys: [string, string]
  onApiKeyChange: (index: 0 | 1, key: string) => void
  disabled: boolean
}

const SIZES = ['1K', '2K', '4K'] as const
const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
] as const

export function RunSettingsPanel({ settings, onUpdate, apiKeys, onApiKeyChange, disabled }: Props) {
  const model = getModel(settings.modelId)

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
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {m.id}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] text-zinc-600">{model.description}</p>
      </Field>

      <Field label="System instructions">
        <textarea
          value={settings.systemInstruction}
          onChange={(e) => onUpdate({ systemInstruction: e.target.value })}
          disabled={disabled}
          placeholder="Optional tone and style instructions for the model…"
          rows={4}
          spellCheck={false}
          className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500 disabled:opacity-50"
        />
        <p className="mt-1 text-[10px] text-zinc-600">
          Sent with every attempt, separate from the prompt. Leave empty to send none.
        </p>
      </Field>

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
        <input
          type="number"
          min={1}
          max={50}
          value={settings.attemptsCap}
          onChange={(e) =>
            onUpdate({ attemptsCap: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })
          }
          disabled={disabled}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:opacity-50"
        />
        <p className="mt-1 text-[10px] text-zinc-600">
          Safety cap: the run stops here even if fewer images were collected, so a permanently
          blocked prompt can't burn quota forever.
        </p>
      </Field>

      <div className="mt-auto border-t border-zinc-800 pt-4">
        <ApiKeySection apiKeys={apiKeys} onChange={onApiKeyChange} />
      </div>
    </aside>
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
