import { GoogleGenAI } from '@google/genai'
import type { ParsedImagePart, ParsedResponse, Settings } from '../types'
import { getModel } from './models'

export interface GenerateParams {
  apiKey: string
  settings: Settings
  references: ParsedImagePart[]
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

export const callGenerate: GenerateCaller = async ({ apiKey, settings, references }, signal) => {
  const ai = getClient(apiKey)
  const model = getModel(settings.modelId)
  const systemInstruction = settings.systemInstruction.trim()

  const parts: Part[] = [
    ...references.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.base64 } })),
    { text: settings.prompt },
  ]

  const imageConfig: Record<string, string> = {}
  if (settings.aspectRatio !== 'auto') imageConfig.aspectRatio = settings.aspectRatio
  if (model.supportsImageSize) imageConfig.imageSize = settings.imageSize

  const doCall = (sys: string | null, callParts: Part[]) =>
    ai.models.generateContent({
      model: settings.modelId,
      contents: [{ role: 'user', parts: callParts }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(sys ? { systemInstruction: sys } : {}),
        ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
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
