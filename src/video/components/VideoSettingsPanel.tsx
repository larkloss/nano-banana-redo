import { useState } from 'react'
import type { VideoSettings } from '../../types'
import { VEO_MODELS, getVeoModel, estimateVideoCost } from '../../lib/veoModels'
import { ApiKeySection } from '../../components/settings/ApiKeySection'
import { Field, Chip } from '../../components/settings/RunSettingsPanel'
import { ExpandableTextarea } from '../../components/common/ExpandableTextarea'

interface Props {
  settings: VideoSettings
  onUpdate: (patch: Partial<VideoSettings>) => void
  apiKeys: [string, string, string]
  onApiKeyChange: (index: 0 | 1 | 2, key: string) => void
  disabled: boolean
}

export function VideoSettingsPanel({ settings, onUpdate, apiKeys, onApiKeyChange, disabled }: Props) {
  const model = getVeoModel(settings.modelId)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const estimate = estimateVideoCost(settings)

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l border-zinc-800 bg-zinc-900/40 p-4">
      <h2 className="text-sm font-semibold text-zinc-300">Video settings</h2>

      <Field label="Model">
        <select
          value={settings.modelId}
          onChange={(e) => onUpdate({ modelId: e.target.value })}
          disabled={disabled}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:opacity-50"
        >
          {VEO_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] text-zinc-600">
          {model.description} · {model.id}
        </p>
      </Field>

      <Field label="Aspect ratio">
        <div className="grid grid-cols-2 gap-1.5">
          {(['16:9', '9:16'] as const).map((r) => (
            <Chip key={r} active={settings.aspectRatio === r} onClick={() => onUpdate({ aspectRatio: r })} disabled={disabled} wide>
              {r === '16:9' ? '16:9 landscape' : '9:16 portrait'}
            </Chip>
          ))}
        </div>
      </Field>

      <Field label="Resolution">
        <div className="grid grid-cols-2 gap-1.5">
          {(['720p', '1080p'] as const).map((r) => (
            <Chip key={r} active={settings.resolution === r} onClick={() => onUpdate({ resolution: r })} disabled={disabled} wide>
              {r}
            </Chip>
          ))}
        </div>
      </Field>

      <Field label="Duration">
        <div className="grid grid-cols-3 gap-1.5">
          {([4, 6, 8] as const).map((s) => (
            <Chip key={s} active={settings.durationSeconds === s} onClick={() => onUpdate({ durationSeconds: s })} disabled={disabled} wide>
              {s}s
            </Chip>
          ))}
        </div>
      </Field>

      <Field label="Audio">
        <div className="grid grid-cols-2 gap-1.5">
          <Chip active={settings.generateAudio} onClick={() => onUpdate({ generateAudio: true })} disabled={disabled} wide>
            On
          </Chip>
          <Chip active={!settings.generateAudio} onClick={() => onUpdate({ generateAudio: false })} disabled={disabled} wide>
            Off
          </Chip>
        </div>
        <p className="mt-1 text-[10px] text-zinc-600">
          Native dialogue &amp; sound effects. Turning audio off is cheaper on most tiers.
        </p>
      </Field>

      <Field label="Negative prompt">
        <ExpandableTextarea
          value={settings.negativePrompt}
          onChange={(negativePrompt) => onUpdate({ negativePrompt })}
          label="Negative prompt"
          disabled={disabled}
          placeholder="What should NOT appear — e.g. cartoon style, text overlays, extra people…"
          rows={3}
          className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500 disabled:opacity-50"
        />
      </Field>

      <Field label={`Number of videos · ${settings.targetCount}`}>
        <input
          type="range"
          min={1}
          max={8}
          value={settings.targetCount}
          onChange={(e) => onUpdate({ targetCount: Number(e.target.value) })}
          disabled={disabled}
          className="w-full accent-blue-500"
        />
        <p className="mt-1 text-[10px] text-zinc-600">
          ≈ ${estimate.toFixed(2)} per video (rough estimate) — ${(estimate * settings.targetCount).toFixed(2)} for
          this run. Every video attempt bills, so the default target is 1.
        </p>
      </Field>

      <Field label="Max attempts">
        <input
          type="number"
          min={1}
          max={50}
          value={settings.attemptsCap}
          onChange={(e) => onUpdate({ attemptsCap: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })}
          disabled={disabled}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:opacity-50"
        />
        <p className="mt-1 text-[10px] text-zinc-600">
          Hard stop even if the target isn't reached — filtered/blocked attempts still bill, so keep this low.
        </p>
      </Field>

      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="text-xs font-medium text-zinc-400 hover:text-zinc-200"
        >
          {advancedOpen ? '▾' : '▸'} Advanced
        </button>
        {advancedOpen && (
          <div className="mt-3 space-y-4 border-l border-zinc-800 pl-3">
            <Field label="Seed">
              <input
                type="number"
                value={settings.seed ?? ''}
                onChange={(e) => onUpdate({ seed: e.target.value === '' ? null : Math.trunc(Number(e.target.value)) })}
                disabled={disabled}
                placeholder="random"
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500 disabled:opacity-50"
              />
              <p className="mt-1 text-[10px] text-zinc-600">Same seed + same inputs → consistent result. Empty = random.</p>
            </Field>
            <Field label="Person generation">
              <div className="grid grid-cols-2 gap-1.5">
                <Chip active={settings.personGeneration === 'allow_adult'} onClick={() => onUpdate({ personGeneration: 'allow_adult' })} disabled={disabled} wide>
                  Allow adult
                </Chip>
                <Chip active={settings.personGeneration === 'dont_allow'} onClick={() => onUpdate({ personGeneration: 'dont_allow' })} disabled={disabled} wide>
                  Don't allow
                </Chip>
              </div>
            </Field>
            <Field label="Prompt rewriting">
              <div className="grid grid-cols-2 gap-1.5">
                <Chip active={settings.enhancePrompt} onClick={() => onUpdate({ enhancePrompt: true })} disabled={disabled} wide>
                  On (default)
                </Chip>
                <Chip active={!settings.enhancePrompt} onClick={() => onUpdate({ enhancePrompt: false })} disabled={disabled} wide>
                  Off
                </Chip>
              </div>
              <p className="mt-1 text-[10px] text-zinc-600">
                Veo rewrites prompts with Gemini before generating. Opting out may be rejected by some model versions.
              </p>
            </Field>
          </div>
        )}
      </div>

      <div className="mt-auto border-t border-zinc-800 pt-4">
        <ApiKeySection apiKeys={apiKeys} onChange={onApiKeyChange} />
        <p className="mt-2 text-[10px] leading-snug text-amber-400/70">
          Veo is paid-preview only — free-tier keys will get 429/permission errors.
        </p>
      </div>
    </aside>
  )
}
