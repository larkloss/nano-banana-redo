import { useEffect, useMemo, useRef, useState } from 'react'
import type { PromptMode, PromptModule, PromptWorkspace } from '../types'
import { loadPromptWorkspace, savePromptWorkspace, emptyModule } from '../lib/storage'
import { assembleModules, type SplitResult } from '../lib/promptAssembly'

// Generator and video app each pass their own storageKey/defaultNames so
// their module libraries live side by side without clobbering each other.
export function usePromptWorkspace(storageKey?: string, defaultNames?: string[]) {
  const [workspace, setWorkspace] = useState<PromptWorkspace>(() =>
    loadPromptWorkspace(storageKey, defaultNames),
  )
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => savePromptWorkspace(workspace, storageKey), 500)
    return () => clearTimeout(saveTimer.current)
  }, [workspace, storageKey])

  const assembled = useMemo(() => assembleModules(workspace.modules), [workspace.modules])

  const setMode = (mode: PromptMode) => setWorkspace((prev) => ({ ...prev, mode }))

  const patchModule = (id: string, patch: Partial<PromptModule>) =>
    setWorkspace((prev) => ({
      ...prev,
      modules: prev.modules.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }))

  const setModuleText = (id: string, text: string) => patchModule(id, { text })

  const addModule = () =>
    setWorkspace((prev) => ({ ...prev, modules: [...prev.modules, emptyModule('New module')] }))

  const removeModule = (id: string) =>
    setWorkspace((prev) => ({ ...prev, modules: prev.modules.filter((m) => m.id !== id) }))

  const moveModule = (id: string, direction: -1 | 1) =>
    setWorkspace((prev) => {
      const index = prev.modules.findIndex((m) => m.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= prev.modules.length) return prev
      const modules = [...prev.modules]
      ;[modules[index], modules[target]] = [modules[target], modules[index]]
      return { ...prev, modules }
    })

  // Replace all modules with an import-split result
  const replaceModules = (parts: SplitResult[]) =>
    setWorkspace((prev) => ({
      ...prev,
      modules: parts.map((p) => emptyModule(p.name, p.text)),
    }))

  const saveVariant = (moduleId: string) =>
    setWorkspace((prev) => ({
      ...prev,
      modules: prev.modules.map((m) => {
        if (m.id !== moduleId) return m
        const active = m.variants.find((v) => v.id === m.activeVariantId)
        if (active) {
          return {
            ...m,
            variants: m.variants.map((v) => (v.id === active.id ? { ...v, text: m.text } : v)),
          }
        }
        const name = window.prompt('Variant name:', `Variant ${m.variants.length + 1}`)
        if (!name) return m
        const variant = { id: crypto.randomUUID(), name, text: m.text }
        return { ...m, variants: [...m.variants, variant], activeVariantId: variant.id }
      }),
    }))

  const saveVariantAs = (moduleId: string) =>
    setWorkspace((prev) => ({
      ...prev,
      modules: prev.modules.map((m) => {
        if (m.id !== moduleId) return m
        const name = window.prompt('New variant name:', `Variant ${m.variants.length + 1}`)
        if (!name) return m
        const variant = { id: crypto.randomUUID(), name, text: m.text }
        return { ...m, variants: [...m.variants, variant], activeVariantId: variant.id }
      }),
    }))

  const loadVariant = (moduleId: string, variantId: string) =>
    setWorkspace((prev) => ({
      ...prev,
      modules: prev.modules.map((m) => {
        if (m.id !== moduleId) return m
        const variant = m.variants.find((v) => v.id === variantId)
        if (!variant) return m
        return { ...m, text: variant.text, activeVariantId: variant.id }
      }),
    }))

  const deleteVariant = (moduleId: string, variantId: string) =>
    setWorkspace((prev) => ({
      ...prev,
      modules: prev.modules.map((m) =>
        m.id === moduleId
          ? {
              ...m,
              variants: m.variants.filter((v) => v.id !== variantId),
              activeVariantId: m.activeVariantId === variantId ? null : m.activeVariantId,
            }
          : m,
      ),
    }))

  // Wholesale swap, used when a synced file turns out to be newer
  const replaceWorkspace = (next: PromptWorkspace) => setWorkspace(next)

  return {
    workspace,
    assembled,
    replaceWorkspace,
    setMode,
    patchModule,
    setModuleText,
    addModule,
    removeModule,
    moveModule,
    replaceModules,
    saveVariant,
    saveVariantAs,
    loadVariant,
    deleteVariant,
  }
}

export type PromptWorkspaceApi = ReturnType<typeof usePromptWorkspace>
