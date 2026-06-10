import type { ParsedImagePart, Settings } from '../../types'
import type { GenerateCaller } from '../../lib/gemini'
import { base64ToBlob } from '../../lib/imageUtils'
import type { BaseImage, EditSettings, Shape } from '../types'
import { rasterizeAlphaMask, maskToBWPngBase64, maskBitsAt, blobToBase64 } from './mask'
import { buildAnalysisContext, analyzeResult, type AlignResult, type AnalysisContext } from './align'

// Mean abs grayscale diff (0-255) inside the mask below which a result is
// treated as "model returned the input unchanged" and retried.
const NOOP_THRESHOLD = 3.0
// Relative aspect-ratio mismatch beyond which a result can't be composited.
const AR_TOLERANCE = 0.02
// Long side cap for the image actually sent to the model.
const MODEL_INPUT_MAX = 3072

export function buildInstruction(userPrompt: string): string {
  return [
    'The first image is the original. The second image is a selection mask:',
    'white marks the region to edit, black marks the region to keep.',
    `Re-render ONLY the white-masked region according to this instruction: ${userPrompt}`,
    'Strict requirements:',
    '- Keep every black-masked pixel exactly identical to the original image.',
    '- Do not crop, zoom, rotate, or shift the framing; return the full image with the same composition and aspect ratio.',
    '- Blend the edited region seamlessly with its surroundings (lighting, grain, perspective).',
    'Return only the edited image.',
  ].join('\n')
}

export interface EditJob {
  engineSettings: Settings
  references: ParsedImagePart[] // [base (possibly downscaled), mask]
  analysisCtx: AnalysisContext
  analysisCache: Map<string, AlignResult>
}

export async function prepareEditJob(
  base: BaseImage,
  shapes: Shape[],
  settings: EditSettings,
): Promise<EditJob> {
  const fullMask = rasterizeAlphaMask(shapes, base.width, base.height)

  // The model gets a bounded-size input; alignment/composite use the true original.
  const longSide = Math.max(base.width, base.height)
  const modelScale = Math.min(1, MODEL_INPUT_MAX / longSide)
  let baseB64 = base.base64
  let baseMime = base.mimeType
  if (modelScale < 1) {
    const mw = Math.round(base.width * modelScale)
    const mh = Math.round(base.height * modelScale)
    const canvas = new OffscreenCanvas(mw, mh)
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(base.bitmap, 0, 0, mw, mh)
    baseB64 = await blobToBase64(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 }))
    baseMime = 'image/jpeg'
  }
  const modelMask =
    modelScale < 1
      ? rasterizeAlphaMask(shapes, base.width * modelScale, base.height * modelScale, modelScale)
      : fullMask
  const maskB64 = await maskToBWPngBase64(modelMask)

  const engineSettings: Settings = {
    modelId: settings.modelId,
    systemInstruction: '',
    aspectRatio: 'auto',
    imageSize: settings.imageSize,
    format: settings.format,
    targetCount: settings.candidates,
    attemptsCap: settings.attemptsCap,
    prompt: buildInstruction(settings.prompt.trim()),
  }

  return {
    engineSettings,
    references: [
      { base64: baseB64, mimeType: baseMime },
      { base64: maskB64, mimeType: 'image/png' },
    ],
    analysisCtx: buildAnalysisContext(base.bitmap, (w, h) => maskBitsAt(fullMask, w, h)),
    analysisCache: new Map(),
  }
}

// Wraps the real caller: successful responses are analyzed before the retry
// engine sees them. Aspect-ratio mismatches and no-op results (model returned
// the input unchanged) are converted to empty responses, which classifyResponse
// treats as failed attempts → automatic retry. Alignment results are cached so
// compositing doesn't redo the grid search.
export function makeEditCaller(inner: GenerateCaller, job: EditJob): GenerateCaller {
  return async (params, signal) => {
    const parsed = await inner(params, signal)
    if (parsed.images.length === 0) return parsed

    const img = parsed.images[0]
    const bitmap = await createImageBitmap(base64ToBlob(img.base64, img.mimeType))
    const arOriginal = job.analysisCtx.aw / job.analysisCtx.ah
    const arResult = bitmap.width / bitmap.height
    const arMismatch = Math.abs(arResult - arOriginal) / arOriginal
    if (arMismatch > AR_TOLERANCE) {
      bitmap.close()
      return {
        images: [],
        finishReason: 'STOP',
        text: `result aspect ratio ${arResult.toFixed(3)} does not match original ${arOriginal.toFixed(3)}`,
      }
    }

    const analysis = analyzeResult(job.analysisCtx, bitmap)
    bitmap.close()
    if (analysis.insideDiff < NOOP_THRESHOLD) {
      return {
        images: [],
        finishReason: 'STOP',
        text: `no-op: model returned the image unchanged (diff ${analysis.insideDiff.toFixed(1)})`,
      }
    }

    job.analysisCache.set(img.base64, analysis)
    return { ...parsed, images: [img] }
  }
}
