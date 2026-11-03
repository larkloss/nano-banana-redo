// Short, human wording for the engine's per-attempt failure reasons. The raw
// reason stays available as a tooltip for when the detail matters.
export function friendlyReason(reason: string | null): string | null {
  if (!reason) return null
  const text = reason.replace(/^Key \d+: /, '')
  if (/moderation|blocked|safety|policy|prohibited/i.test(text)) return 'turned down by the safety filter'
  if (/no change near the arrows/i.test(text)) return 'changed nothing near the arrows'
  if (/changed the picture.s shape/i.test(text)) return 'changed the picture’s shape'
  if (/drew a different picture/i.test(text)) return 'drew a different picture'
  if (/answer could not be read/i.test(text)) return 'came back unreadable'
  if (/^No image in response/i.test(text)) return 'came back without a picture'
  if (/rate limited/i.test(text)) return 'rate limited, pausing briefly'
  if (/server error|network error/i.test(text)) return 'connection hiccup'
  return text
}
