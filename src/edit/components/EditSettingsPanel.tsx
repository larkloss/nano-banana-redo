import type { ImageSize } from '../../types'
import type { EditSettings } from '../types'
import { MODELS } from '../../lib/models'
import { EDIT_MODELS } from '../lib/storage'
import { Field, Chip } from '../../components/settings/RunSettingsPanel'
import { ApiKeySection } from '../../components/settings/ApiKeySection'
import { MaxAttemptsControl } from '../../components/settings/MaxAttemptsControl'

interface Props {
  settings: EditSettings
  onUpdate: (patch: Partial<EditSettings>) => void
  apiKeys: [string, string, string]
  onApiKeyChange: (index: 0 | 1 | 2, key: string) => void
  disabled: boolean
}

const SIZES: ImageSize[] = ['1K', '2K', '4K']
const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
] as const

export function EditSettingsPanel({ settings, onUpdate, apiKeys, onApiKeyChange, disabled }: Props) {
  const editModels = MODELS.filter((m) => (EDIT_MODELS as readonly string[]).includes(m.id))

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l border-zinc-800 bg-zinc-900/40 p-4">
      <h2 className="text-sm font-semibold text-zinc-300">Edit settings</h2>

      <Field label="Model">
        <select
          value={settings.modelId}
          onChange={(e) => onUpdate({ modelId: e.target.value })}
          disabled={disabled}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:opacity-50"
        >
          {editModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {m.id}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Image size">
        <div className="grid grid-cols-3 gap-1.5">
          {SIZES.map((s) => (
            <Chip key={s} active={settings.imageSize === s} onClick={() => onUpdate({ imageSize: s })} disabled={disabled} wide>
              {s}
            </Chip>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-zinc-600">
          Model render size. The final composite is always at the original image's resolution.
        </p>
      </Field>

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

      <Field label={`Candidates · ${settings.candidates}`}>
        <input
          type="range"
          min={1}
          max={4}
          value={settings.candidates}
          onChange={(e) => onUpdate({ candidates: Number(e.target.value) })}
          disabled={disabled}
          className="w-full accent-blue-500"
        />
        <p className="mt-1 text-[10px] text-zinc-600">
          How many alternative edits to collect — pick your favourite afterwards.
        </p>
      </Field>

      <Field label="Seamless blend">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={settings.seamless}
            onChange={(e) => onUpdate({ seamless: e.target.checked })}
            disabled={disabled}
            className="accent-blue-500"
          />
          Tone match + seam smoothing + grain match
        </label>
        <p className="mt-1 text-[10px] text-zinc-600">
          Corrects the model's global tone shift and diffuses the residual boundary difference into
          the region (Poisson-style), so the patch doesn't look pasted on.
        </p>
      </Field>

      <Field label="Max attempts">
        <MaxAttemptsControl
          value={settings.attemptsCap}
          onChange={(attemptsCap) => onUpdate({ attemptsCap })}
          disabled={disabled}
        />
        <p className="mt-1 text-[10px] text-zinc-600">
          Moderation blocks, unchanged results, and mismatched framing all auto-retry up to this cap.
        </p>
      </Field>

      <div className="mt-auto border-t border-zinc-800 pt-4">
        <ApiKeySection apiKeys={apiKeys} onChange={onApiKeyChange} />
      </div>
    </aside>
  )
}
