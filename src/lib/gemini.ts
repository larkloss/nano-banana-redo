import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import type { ParsedImagePart, ParsedResponse, Settings } from '../types'
import { getModel } from './models'
import { captionedReferences, referenceName } from './mentions'

export interface GenerateParams {
  apiKey: string
  settings: Settings
  references: ParsedImagePart[]
  // Prompt to use if a provider can only take the first source image (xAI's
  // single-image fallback). Needed when the prompt talks about the other
  // images, e.g. the arrow guide of a marked edit.
  singleSourcePrompt?: string
}

export type GenerateCaller = (params: GenerateParams, signal: AbortSignal) => Promise<ParsedResponse>

let cachedClient: GoogleGenAI | null = null
let cachedKey = ''

function getClient(apiKey: string): GoogleGenAI {
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new GoogleGenAI({ apiKey })
    cachedKey = apiKey
  }
  return cachedClient
}

type Part = { text: string } | { inlineData: { mimeType: string; data: string } }

const capitalise = (text: string) => text[0].toUpperCase() + text.slice(1)

export const callGenerate: GenerateCaller = async ({ apiKey, settings, references }, signal) => {
  const ai = getClient(apiKey)
  const model = getModel(settings.modelId)
  // "@2" in the prompt (or the system instruction) points at the second
  // reference: caption each picture so the model knows which is which
  const mentions = settings.imagesExplained
    ? { captions: false, prompt: settings.prompt, systemInstruction: settings.systemInstruction }
    : captionedReferences(settings.prompt, settings.systemInstruction, references.length)
  const systemInstruction = mentions.systemInstruction.trim()
  const parts: Part[] = [
    ...references.flatMap((r, i): Part[] => [
      ...(mentions.captions ? [{ text: `${capitalise(referenceName(i + 1))}:` }] : []),
      { inlineData: { mimeType: r.mimeType, data: r.base64 } },
    ]),
    { text: mentions.prompt },
  ]

  const imageConfig: Record<string, string> = {}
  if (settings.aspectRatio !== 'auto') imageConfig.aspectRatio = settings.aspectRatio
  if (model.supportsImageSize) imageConfig.imageSize = settings.imageSize

  // Only Nano Banana 2 (gemini-3.1-flash-image) accepts a thinking level for
  // image generation; hard-wired to HIGH for best prompt adherence. Sending it
  // to models that don't support it (Pro, 2.5) would error, so it's gated.
  const thinkingConfig = model.supportsThinking ? { thinkingLevel: ThinkingLevel.HIGH } : null

  // Grounding (Nano Banana 2.1): Web Search feeds the model text results about
  // the prompt; Image Search additionally returns image bytes it can draw from.
  // Both ride on the googleSearch tool — image search is a searchTypes flag on
  // it. Only sent for models that support it, since others reject tools.
  const tools =
    model.supportsGrounding && (settings.groundWebSearch || settings.groundImageSearch)
      ? [
          {
            googleSearch: settings.groundImageSearch ? { searchTypes: { imageSearch: {} } } : {},
          },
        ]
      : null

  const doCall = (sys: string | null, callParts: Part[]) =>
    ai.models.generateContent({
      model: settings.modelId,
      contents: [{ role: 'user', parts: callParts }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(sys ? { systemInstruction: sys } : {}),
        ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
        ...(tools ? { tools } : {}),
        abortSignal: signal,
      },
    })

  let response
  try {
    response = await doCall(systemInstruction || null, parts)
  } catch (err) {
    // Some image models reject the systemInstruction field; fall back to
    // prepending the instruction to the user content so it still applies.
    if (systemInstruction && isSystemInstructionUnsupported(err)) {
      response = await doCall(null, [{ text: `Instructions:\n${systemInstruction}` }, ...parts])
    } else {
      throw err
    }
  }

  const candidate = response.candidates?.[0]
  const images = (candidate?.content?.parts ?? [])
    .filter((p) => p.inlineData?.mimeType?.startsWith('image/') && p.inlineData.data)
    .map((p) => ({ base64: p.inlineData!.data!, mimeType: p.inlineData!.mimeType! }))
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join(' ')

  return {
    images,
    blockReason: response.promptFeedback?.blockReason as string | undefined,
    finishReason: candidate?.finishReason as string | undefined,
    text: text || undefined,
  }
}

function isSystemInstructionUnsupported(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const status = 'status' in err ? (err as { status?: unknown }).status : undefined
  return status === 400 && /(system|developer)[ _]instruction/i.test(err.message)
}
