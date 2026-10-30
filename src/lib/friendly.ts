// Short, human wording for the engine's per-attempt failure reasons. The raw
// reason stays available as a tooltip for when the detail matters.
export function friendlyReason(reason: string | null): string | null {
  if (!reason) return null
  const text = reason.replace(/^Key \d+: /, '')
  if (/moderation|blocked|safety|policy|prohibited/i.test(text)) return 'turned down by the safety filter'
  if (/^No image in response/i.test(text)) return 'came back without a picture'
  if (/rate limited/i.test(text)) return 'rate limited, pausing briefly'
  if (/server error|network error/i.test(text)) return 'connection hiccup'
  return text
}
