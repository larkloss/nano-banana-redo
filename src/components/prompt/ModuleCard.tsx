import { useEffect, useRef, useState } from 'react'
import type { PromptModule } from '../../types'
import type { PromptWorkspaceApi } from '../../hooks/usePromptWorkspace'
import { ExpandableTextarea } from '../common/ExpandableTextarea'

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

        <VariantMenu module={module} api={api} disabled={disabled} />
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
        <ExpandableTextarea
          value={module.text}
          onChange={(text) => api.setModuleText(module.id, text)}
          label={module.name}
          disabled={disabled}
          rows={3}
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

// Variant picker with a delete button on every row. A plain <select> could
// only ever act on the loaded variant, and loading one overwrites the module
// text — so removing an unwanted variant meant destroying your current edit.
function VariantMenu({ module, api, disabled }: { module: PromptModule; api: PromptWorkspaceApi; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = module.variants.find((v) => v.id === module.activeVariantId)
  const dirty = active !== undefined && active.text !== module.text
  const count = module.variants.length

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const label = count === 0 ? 'No variants' : active ? `${active.name}${dirty ? ' ●' : ''}` : `Variants (${count})`

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || count === 0}
        title={count === 0 ? 'Save the current text as a variant first' : 'Load or delete saved variants'}
        className="max-w-40 truncate rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[10px] text-zinc-300 hover:border-zinc-600 disabled:opacity-50"
      >
        {label} ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-60 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-xl shadow-black/50">
          {module.variants.map((v) => (
            <div key={v.id} className="group flex items-center rounded hover:bg-zinc-800">
              <button
                type="button"
                onClick={() => {
                  if (dirty && !window.confirm('Loading a variant replaces the unsaved text in this module. Continue?')) return
                  api.loadVariant(module.id, v.id)
                  setOpen(false)
                }}
                title={v.text.slice(0, 200)}
                className="min-w-0 flex-1 truncate px-2 py-1 text-left text-[10px] text-zinc-300"
              >
                {v.id === module.activeVariantId ? '✓ ' : ''}
                {v.name}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Delete variant "${v.name}"? The module text stays as it is.`)) {
                    api.deleteVariant(module.id, v.id)
                  }
                }}
                title={`Delete variant "${v.name}"`}
                className="shrink-0 px-2 py-1 text-[10px] text-zinc-600 hover:text-red-400"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
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
