import type { AttemptOutcome, ParsedResponse } from '../types'

const MODERATION_FINISH_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'PROHIBITED_CONTENT',
  'RECITATION',
  'BLOCKLIST',
  'SPII',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
  'IMAGE_OTHER',
])

export function classifyResponse(parsed: ParsedResponse): AttemptOutcome {
  if (parsed.images.length > 0) {
    return { kind: 'success', images: parsed.images }
  }
  if (parsed.blockReason && parsed.blockReason !== 'BLOCKED_REASON_UNSPECIFIED') {
    return { kind: 'moderation', reason: `Prompt blocked: ${parsed.blockReason}` }
  }
  if (parsed.finishReason && MODERATION_FINISH_REASONS.has(parsed.finishReason)) {
    return { kind: 'moderation', reason: `Generation blocked: ${parsed.finishReason}` }
  }
  const detail = parsed.text ? ` ("${truncate(parsed.text, 80)}")` : ''
  return { kind: 'empty', reason: `No image in response${detail}` }
}

// Some providers report a blocked generation as an HTTP error rather than a
// finish reason (xAI answers 400 with {"code":"imagine:content-moderated"}).
// That is a per-attempt outcome, not a broken request, so it must be retried
// like any other moderation block instead of killing the lane.
const MODERATION_MESSAGE = /content[-_\s]?moderat|moderated|rejected by (?:content )?moderation|safety[-_\s]?(?:filter|system)/i

export function isModerationMessage(message: string): boolean {
  return MODERATION_MESSAGE.test(message)
}

export function classifyError(err: unknown): AttemptOutcome {
  if (isAbortError(err)) return { kind: 'aborted' }

  const message = err instanceof Error ? err.message : String(err)
  const status = extractStatus(err, message)

  if (isModerationMessage(message)) {
    return { kind: 'moderation', reason: truncate(extractApiMessage(message) ?? 'Blocked by content moderation', 160) }
  }
  if (status === 429) {
    return { kind: 'transient', reason: 'Rate limited (429)', retryDelayMs: extractRetryDelayMs(message) }
  }
  if (status !== null && status >= 500) {
    return { kind: 'transient', reason: `Server error (${status})` }
  }
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return { kind: 'fatal', message: fatalHint(status, message) }
  }
  // No HTTP status — almost certainly a network failure
  if (err instanceof TypeError || /fetch|network|ECONN/i.test(message)) {
    return { kind: 'transient', reason: 'Network error' }
  }
  return { kind: 'fatal', message: truncate(message, 300) }
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message)))
  )
}

function extractStatus(err: unknown, message: string): number | null {
  if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    return (err as { status: number }).status
  }
  const m = message.match(/\b(400|401|403|404|429|500|502|503|504)\b/)
  return m ? Number(m[1]) : null
}

function extractRetryDelayMs(message: string): number | undefined {
  const m = message.match(/"retryDelay"\s*:\s*"([\d.]+)s"/)
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined
}

function fatalHint(status: number, message: string): string {
  const short = truncate(extractApiMessage(message) ?? message, 300)
  if (status === 401 || status === 403) return `Access denied (${status}) — check your API key. ${short}`
  if (status === 404) return `Model not found (404) — your key may not have access to this model. ${short}`
  return `Request rejected (${status}). ${short}`
}

function extractApiMessage(message: string): string | null {
  // Gemini nests the text under "message"; xAI puts it in "error"
  const m = message.match(/"message"\s*:\s*"([^"]+)"/) ?? message.match(/"error"\s*:\s*"([^"]+)"/)
  return m ? m[1] : null
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
