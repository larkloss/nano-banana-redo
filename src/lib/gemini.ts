import { GoogleGenAI } from '@google/genai'
import type { ParsedResponse, ReferenceImage, Settings } from '../types'
import { getModel } from './models'

export interface GenerateParams {
  apiKey: string
  settings: Settings
  references: ReferenceImage[]
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

export const callGenerate: GenerateCaller = async ({ apiKey, settings, references }, signal) => {
  const ai = getClient(apiKey)
  const model = getModel(settings.modelId)

  const parts = [
    ...references.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.base64 } })),
    { text: settings.prompt },
  ]

  const imageConfig: Record<string, string> = {}
  if (settings.aspectRatio !== 'auto') imageConfig.aspectRatio = settings.aspectRatio
  if (model.supportsImageSize) imageConfig.imageSize = settings.imageSize

  const response = await ai.models.generateContent({
    model: settings.modelId,
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
      abortSignal: signal,
    },
  })

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
