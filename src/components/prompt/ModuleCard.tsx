import type { PromptModule } from '../../types'
import type { PromptWorkspaceApi } from '../../hooks/usePromptWorkspace'

interface Props {
  module: PromptModule
  isFirst: boolean
  isLast: boolean
  api: PromptWorkspaceApi
  disabled: boolean
}

export function ModuleCard({ module, isFirst, isLast, api, disabled }: Props) {
  const active = module.variants.find((v) => v.id === module.activeVariantId)
  const dirty = active !== undefined && active.text !== module.text

  return (
    <div
      className={`rounded-lg border ${module.enabled ? 'border-zinc-700' : 'border-zinc-800 opacity-60'} bg-zinc-900/70`}
    >
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5">
        <input
          type="checkbox"
          checked={module.enabled}
          onChange={(e) => api.patchModule(module.id, { enabled: e.target.checked })}
          disabled={disabled}
          title="Include this module in the prompt"
          className="accent-blue-500"
        />
        <input
          type="text"
          value={module.name}
          onChange={(e) => api.patchModule(module.id, { name: e.target.value })}
          disabled={disabled}
          spellCheck={false}
          className="w-36 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-zinc-300 outline-none hover:border-zinc-700 focus:border-blue-500"
        />

        <select
          value={dirty ? '__dirty' : (module.activeVariantId ?? '__none')}
          onChange={(e) => {
            if (e.target.value !== '__none' && e.target.value !== '__dirty') {
              api.loadVariant(module.id, e.target.value)
            }
          }}
          disabled={disabled}
          title="Load a saved variant into this module"
          className="max-w-40 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[10px] text-zinc-300 outline-none focus:border-blue-500 disabled:opacity-50"
        >
          <option value="__none" disabled>
            {module.variants.length === 0 ? 'No variants' : 'Variants…'}
          </option>
          {dirty && (
            <option value="__dirty" disabled>
              {active!.name} ●
            </option>
          )}
          {module.variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <HeaderButton
          onClick={() => api.saveVariant(module.id)}
          disabled={disabled || !module.text.trim()}
          title={active ? `Overwrite variant "${active.name}" with the current text` : 'Save the current text as a variant'}
        >
          Save{dirty ? ' ●' : ''}
        </HeaderButton>
        <HeaderButton
          onClick={() => api.saveVariantAs(module.id)}
          disabled={disabled || !module.text.trim()}
          title="Save the current text as a new variant"
        >
          Save as
        </HeaderButton>
        {active && (
          <HeaderButton
            onClick={() => api.deleteVariant(module.id, active.id)}
            disabled={disabled}
            title={`Delete variant "${active.name}"`}
          >
            ✕ variant
          </HeaderButton>
        )}

        <span className="ml-auto" />
        <HeaderButton onClick={() => api.moveModule(module.id, -1)} disabled={disabled || isFirst} title="Move up">
          ↑
        </HeaderButton>
        <HeaderButton onClick={() => api.moveModule(module.id, 1)} disabled={disabled || isLast} title="Move down">
          ↓
        </HeaderButton>
        <HeaderButton
          onClick={() => api.patchModule(module.id, { collapsed: !module.collapsed })}
          disabled={false}
          title={module.collapsed ? 'Expand' : 'Collapse'}
        >
          {module.collapsed ? '▸' : '▾'}
        </HeaderButton>
        <HeaderButton
          onClick={() => {
            if (module.text.trim() === '' || window.confirm(`Delete module "${module.name}"?`)) {
              api.removeModule(module.id)
            }
          }}
          disabled={disabled}
          title="Delete module"
          danger
        >
          ✕
        </HeaderButton>
      </div>

      {!module.collapsed && (
        <textarea
          value={module.text}
          onChange={(e) => api.setModuleText(module.id, e.target.value)}
          disabled={disabled}
          rows={3}
          spellCheck={false}
          placeholder={`${module.name} — include any section marker (e.g. "[${module.name.toUpperCase()}]:") in the text itself`}
          className="w-full resize-y border-t border-zinc-800 bg-transparent p-2.5 text-xs leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none disabled:opacity-60"
        />
      )}
      {module.collapsed && module.text.trim() && (
        <p className="truncate border-t border-zinc-800 px-2.5 py-1 text-[10px] text-zinc-600">
          {module.text.trim().split('\n', 1)[0]}
        </p>
      )}
    </div>
  )
}

function HeaderButton({
  onClick,
  disabled,
  title,
  danger,
  children,
}: {
  onClick: () => void
  disabled: boolean
  title: string
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md border border-zinc-700 px-1.5 py-1 text-[10px] disabled:opacity-40 ${
        danger ? 'text-zinc-500 hover:bg-red-600/20 hover:text-red-400' : 'text-zinc-400 hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  )
}
