import type { ParsedResponse } from '../types'
import type { GenerateCaller } from './gemini'

// Dev-only fake caller (enable with ?mock=1) that cycles through every outcome
// the retry engine must handle, without burning real API quota.
let step = 0

type MockStep = () => Promise<ParsedResponse>

const SCRIPT: MockStep[] = [
  async () => success(),
  async () => ({ images: [], blockReason: 'PROHIBITED_CONTENT' }),
  async () => {
    throw Object.assign(new Error('mock rate limit {"retryDelay": "3s"}'), { status: 429 })
  },
  async () => ({ images: [], finishReason: 'IMAGE_SAFETY' }),
  async () => ({ images: [], finishReason: 'STOP', text: 'I cannot create this image.' }),
  async () => success(),
]

export const mockCallGenerate: GenerateCaller = async (_params, signal) => {
  await new Promise((r) => setTimeout(r, 800))
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const fn = SCRIPT[step % SCRIPT.length]
  step += 1
  return fn()
}

function success(): ParsedResponse {
  return { images: [{ base64: checkerPng(), mimeType: 'image/png' }], finishReason: 'STOP' }
}

let canvasHue = 0

function checkerPng(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const ctx = canvas.getContext('2d')!
  canvasHue = (canvasHue + 47) % 360
  ctx.fillStyle = `hsl(${canvasHue}, 60%, 30%)`
  ctx.fillRect(0, 0, 512, 512)
  ctx.fillStyle = `hsl(${canvasHue}, 80%, 70%)`
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) if ((x + y) % 2 === 0) ctx.fillRect(x * 64, y * 64, 64, 64)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 40px sans-serif'
  ctx.fillText('MOCK', 180, 270)
  return canvas.toDataURL('image/png').split(',')[1]
}

export function isMockMode(): boolean {
  return new URLSearchParams(window.location.search).get('mock') === '1'
}
