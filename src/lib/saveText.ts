import { downloadBlob } from './imageUtils'

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}

interface WritableFileHandle {
  createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>
}

// Save text as a .md file. Chromium exposes showSaveFilePicker so the user can
// pick the destination path; elsewhere (or if the picker fails) this falls back
// to a regular browser download into the default download folder.
export async function saveTextAsMarkdown(text: string, suggestedName: string): Promise<void> {
  const blob = new Blob([text], { type: 'text/markdown' })
  const picker = (
    window as Window & { showSaveFilePicker?: (options: SaveFilePickerOptions) => Promise<WritableFileHandle> }
  ).showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker.call(window, {
        suggestedName,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return // user cancelled
      // picker blocked or failed — fall back to a plain download
    }
  }
  downloadBlob(blob, suggestedName)
}

export function promptFilename(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  return `nano-banana-prompt_${stamp}.md`
}
