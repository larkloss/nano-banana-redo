import type { PromptModule } from '../types'

// Enabled, non-empty module texts in order. Module names are NOT included —
// section markers like "[CORE SUBJECT]:" live inside the text itself, so
// assembly reproduces the original template verbatim.
export function assembleModules(modules: PromptModule[]): string {
  return modules
    .filter((m) => m.enabled)
    .map((m) => m.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

export interface SplitResult {
  name: string
  text: string
}

// A paragraph (blank-line separated) starts a new module when its first line
// opens with a "[SECTION]" bracket or a short "Label:" prefix; otherwise it
// merges into the previous module. Marker lines stay inside the text so that
// assembleModules(split(text)) round-trips the original exactly.
const BRACKET_MARKER = /^\[([^\]]{1,40})\]/
const LABEL_MARKER = /^([A-Za-z][\w &-]{0,30}):/

export function splitPromptIntoModules(text: string): SplitResult[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)

  const result: SplitResult[] = []
  for (const paragraph of paragraphs) {
    const name = markerName(paragraph)
    if (name === null && result.length > 0) {
      result[result.length - 1].text += `\n\n${paragraph}`
    } else {
      result.push({ name: name ?? 'Style & Quality', text: paragraph })
    }
  }
  return result
}

function markerName(paragraph: string): string | null {
  const firstLine = paragraph.split('\n', 1)[0]
  const bracket = firstLine.match(BRACKET_MARKER)
  if (bracket) return titleCase(bracket[1].trim())
  const label = firstLine.match(LABEL_MARKER)
  if (label) return titleCase(label[1].trim())
  return null
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}
