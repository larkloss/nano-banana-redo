// "@2" in a prompt points at reference photo 2 (numbered in the order shown).
//
// A model can't see our numbering, so a mention only means something if the
// request says which picture is which. How that is said depends on what the
// provider lets us send:
//   - Gemini takes text and pictures interleaved, so each picture gets a
//     caption ("Reference image 2:") right before it;
//   - OpenAI and xAI take the pictures as a plain ordered list, so the prompt
//     opens with a line spelling out that order;
//   - Gemini Omni (video) has its own tags, <IMAGE_REF_0>, <IMAGE_REF_1>, …
// In all three the "@2" itself becomes the name the request uses. A prompt
// with no mention is sent exactly as before.

// One or more mentions in a row ("@1", "@1@2" — also with the full-width ＠
// a Chinese keyboard types), not part of an address or a handle ("a@1.com")
const MENTIONS = /(^|[^\w@＠.])((?:[@＠][1-9]\d?)+)(?!\w)/g
const numbersIn = (run: string) => run.split(/[@＠]/).filter(Boolean).map(Number)

// Reference numbers a text mentions, lowest first
export function mentionedNumbers(text: string): number[] {
  const found = new Set<number>()
  for (const match of text.matchAll(MENTIONS)) for (const n of numbersIn(match[2])) found.add(n)
  return [...found].sort((a, b) => a - b)
}

// Mentions that point at no picture (there are only `count`)
export function danglingMentions(text: string, count: number): number[] {
  return mentionedNumbers(text).filter((n) => n > count)
}

// Rewrites every mention of an existing picture with `name(n)`; a mention of
// one that isn't there stays as written
export function nameMentions(text: string, count: number, name: (n: number) => string): string {
  return text.replace(MENTIONS, (_whole, before: string, run: string) => {
    const names = numbersIn(run).map((n) => (n <= count ? name(n) : `@${n}`))
    return before + names.join(' and ')
  })
}

export const referenceName = (n: number) => `reference image ${n}`

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
const ordinal = (n: number) => ORDINALS[n - 1] ?? `${n}th`

// For providers that take the pictures as an ordered list: the prompt with
// its mentions named, opened by a line that ties each name to its place in
// the list. Unchanged when it mentions no picture that is actually sent.
export function withNumberedReferences(prompt: string, count: number): string {
  if (mentionedNumbers(prompt).every((n) => n > count)) return prompt
  const order = Array.from({ length: count }, (_, i) => `${referenceName(i + 1)} is the ${ordinal(i + 1)}`).join(', ')
  return (
    `${count === 1 ? 'One image is' : `${count} images are`} attached, numbered in the order attached: ${order}.\n\n` +
    nameMentions(prompt, count, referenceName)
  )
}

// For Gemini: whether to caption the pictures, and the texts to go with them
export function captionedReferences(
  prompt: string,
  systemInstruction: string,
  count: number,
): { captions: boolean; prompt: string; systemInstruction: string } {
  const pointed = [...mentionedNumbers(prompt), ...mentionedNumbers(systemInstruction)].some((n) => n <= count)
  if (!pointed) return { captions: false, prompt, systemInstruction }
  return {
    captions: true,
    prompt: nameMentions(prompt, count, referenceName),
    systemInstruction: nameMentions(systemInstruction, count, referenceName),
  }
}

// For Gemini Omni: its own reference tags (which count from 0)
export function withOmniTags(prompt: string, count: number): string {
  return nameMentions(prompt, count, (n) => `<IMAGE_REF_${n - 1}>`)
}
