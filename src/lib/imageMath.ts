// Small, dependency-free image helpers for the local-edit compositor. Images
// are planar Float32Array channels (row-major, w×h); masks are Uint8Array
// (1 = set). Everything here is synchronous and canvas-free so it can be
// tested and reasoned about on its own.

// --- colour ----------------------------------------------------------------

const SRGB_TO_LINEAR = (() => {
  const lut = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const c = i / 255
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return lut
})()

function srgbToLinear(v: number): number {
  if (v <= 0) return 0
  if (v >= 255) return 1
  const i = Math.floor(v)
  const t = v - i
  return SRGB_TO_LINEAR[i] * (1 - t) + SRGB_TO_LINEAR[i + 1] * t
}

// OKLab, scaled ×100 so a difference of ~1–2 is about the smallest step the
// eye notices. Perceptual distance is what decides "the model changed this".
export function toOklab(rgb: Float32Array[], n: number): Float32Array[] {
  const L = new Float32Array(n)
  const A = new Float32Array(n)
  const B = new Float32Array(n)
  const [R, G, Bl] = rgb
  for (let p = 0; p < n; p++) {
    const r = srgbToLinear(R[p])
    const g = srgbToLinear(G[p])
    const b = srgbToLinear(Bl[p])
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    L[p] = 100 * (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s)
    A[p] = 100 * (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s)
    B[p] = 100 * (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s)
  }
  return [L, A, B]
}

// Y'CbCr in 0–255 units. Used to detect what a model changed: the noise a
// redraw leaves (and JPEG) is roughly even across brightness here, whereas
// perceptual spaces like OKLab blow up small differences in dark areas.
export function toYcc(rgb: Float32Array[], n: number): Float32Array[] {
  const Y = new Float32Array(n)
  const Cb = new Float32Array(n)
  const Cr = new Float32Array(n)
  const [R, G, B] = rgb
  for (let p = 0; p < n; p++) {
    const y = 0.299 * R[p] + 0.587 * G[p] + 0.114 * B[p]
    Y[p] = y
    Cb[p] = 0.564 * (B[p] - y)
    Cr[p] = 0.713 * (R[p] - y)
  }
  return [Y, Cb, Cr]
}

// Gradient magnitude (central differences)
export function gradientMagnitude(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const gx = (src[x < w - 1 ? p + 1 : p] - src[x > 0 ? p - 1 : p]) * 0.5
      const gy = (src[y < h - 1 ? p + w : p] - src[y > 0 ? p - w : p]) * 0.5
      out[p] = Math.sqrt(gx * gx + gy * gy)
    }
  }
  return out
}

// Noise a redraw leaves, as a function of local edge strength: a + b·grad.
// Fitted on medians per gradient bin, so a minority of truly changed pixels
// in the sample barely moves it.
export function fitNoiseModel(diff: number[], grad: number[], q = 0.5): { a: number; b: number } {
  const n = diff.length
  if (n < 50) return { a: 2, b: 0.15 }
  const order = Array.from(grad.keys()).sort((i, j) => grad[i] - grad[j])
  const bins = 8
  const xs: number[] = []
  const ys: number[] = []
  for (let k = 0; k < bins; k++) {
    const part = order.slice(Math.floor((k * n) / bins), Math.floor(((k + 1) * n) / bins))
    if (part.length < 5) continue
    xs.push(part.reduce((acc, i) => acc + grad[i], 0) / part.length)
    ys.push(
      quantile(
        part.map((i) => diff[i]),
        q,
      ),
    )
  }
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  let sxy = 0
  let sxx = 0
  for (let k = 0; k < xs.length; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my)
    sxx += (xs[k] - mx) ** 2
  }
  const b = sxx > 1e-9 ? Math.max(0, sxy / sxx) : 0
  const a = Math.max(0.5, my - b * mx)
  return { a, b }
}

// Opening: removes specks and lines thinner than ~2r+1 px
export function open(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return dilate(erode(mask, w, h, r), w, h, r)
}

// --- filtering -------------------------------------------------------------

export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src.slice()
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma))
    sum += kernel[i + radius]
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum

  const tmp = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k
        acc += src[row + xx] * kernel[k + radius]
      }
      tmp[row + x] = acc
    }
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k
        acc += tmp[yy * w + x] * kernel[k + radius]
      }
      out[y * w + x] = acc
    }
  }
  return out
}

// Per-pixel colour distance between two Lab images.
export function labDistance(a: Float32Array[], b: Float32Array[], n: number): Float32Array {
  const out = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    const dL = a[0][p] - b[0][p]
    const da = a[1][p] - b[1][p]
    const db = a[2][p] - b[2][p]
    out[p] = Math.sqrt(dL * dL + da * da + db * db)
  }
  return out
}

// Colour distance that forgives the 1px jitter a model leaves on every edge
// when it redraws a picture: each pixel of `a` is compared with the best
// matching pixel of `b` within ±radius. A real change (an object removed, a
// colour swapped) still differs from every nearby pixel; a redrawn edge does
// not.
export function tolerantLabDistance(
  a: Float32Array[],
  b: Float32Array[],
  w: number,
  h: number,
  radius: number,
): Float32Array {
  const out = new Float32Array(w * h).fill(Infinity)
  for (let sy = -radius; sy <= radius; sy++) {
    for (let sx = -radius; sx <= radius; sx++) {
      for (let y = 0; y < h; y++) {
        const yy = y + sy < 0 ? 0 : y + sy >= h ? h - 1 : y + sy
        for (let x = 0; x < w; x++) {
          const xx = x + sx < 0 ? 0 : x + sx >= w ? w - 1 : x + sx
          const p = y * w + x
          const q = yy * w + xx
          const dL = a[0][p] - b[0][q]
          const da = a[1][p] - b[1][q]
          const db = a[2][p] - b[2][q]
          const d = dL * dL + da * da + db * db
          if (d < out[p]) out[p] = d
        }
      }
    }
  }
  for (let p = 0; p < out.length; p++) out[p] = Math.sqrt(out[p])
  return out
}

// --- masks -----------------------------------------------------------------

// Distance (px, ~Euclidean via a 3-4 chamfer) from each pixel to the nearest
// set pixel of `mask`; 0 on set pixels, Infinity when the mask is empty.
export function distanceToSet(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9
  const d = new Float32Array(w * h)
  for (let p = 0; p < d.length; p++) d[p] = mask[p] ? 0 : INF
  // forward pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      let v = d[p]
      if (v === 0) continue
      if (x > 0) v = Math.min(v, d[p - 1] + 3)
      if (y > 0) {
        v = Math.min(v, d[p - w] + 3)
        if (x > 0) v = Math.min(v, d[p - w - 1] + 4)
        if (x < w - 1) v = Math.min(v, d[p - w + 1] + 4)
      }
      d[p] = v
    }
  }
  // backward pass
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x
      let v = d[p]
      if (v === 0) continue
      if (x < w - 1) v = Math.min(v, d[p + 1] + 3)
      if (y < h - 1) {
        v = Math.min(v, d[p + w] + 3)
        if (x < w - 1) v = Math.min(v, d[p + w + 1] + 4)
        if (x > 0) v = Math.min(v, d[p + w - 1] + 4)
      }
      d[p] = v
    }
  }
  for (let p = 0; p < d.length; p++) d[p] = d[p] >= INF ? Infinity : d[p] / 3
  return d
}

export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice()
  const d = distanceToSet(mask, w, h)
  const out = new Uint8Array(w * h)
  for (let p = 0; p < out.length; p++) out[p] = d[p] <= r ? 1 : 0
  return out
}

export function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice()
  const inv = new Uint8Array(w * h)
  for (let p = 0; p < inv.length; p++) inv[p] = mask[p] ? 0 : 1
  const d = distanceToSet(inv, w, h)
  const out = new Uint8Array(w * h)
  // Pixels on the image border count as touching "outside" only if the mask
  // is unset beyond — the frame itself isn't a boundary
  for (let p = 0; p < out.length; p++) out[p] = mask[p] && d[p] > r ? 1 : 0
  return out
}

// 8-connected component labels (0 = background, 1..count)
export function labelComponents(mask: Uint8Array, w: number, h: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(w * h)
  let count = 0
  const stack: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    count += 1
    labels[start] = count
    stack.push(start)
    while (stack.length > 0) {
      const p = stack.pop()!
      const x = p % w
      const y = (p - x) / w
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const q = yy * w + xx
          if (mask[q] && !labels[q]) {
            labels[q] = count
            stack.push(q)
          }
        }
      }
    }
  }
  return { labels, count }
}

// Fills enclosed holes of `mask` (in place) whose area is at most `maxArea`.
// Big holes stay open on purpose: a recoloured hood around a face encloses
// the face, and the face must keep its original pixels.
export function fillSmallHoles(mask: Uint8Array, w: number, h: number, maxArea: number): void {
  const inv = new Uint8Array(w * h)
  for (let p = 0; p < inv.length; p++) inv[p] = mask[p] ? 0 : 1
  const { labels, count } = labelComponents4(inv, w, h)
  const touchesBorder = new Uint8Array(count + 1)
  const area = new Int32Array(count + 1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x]
      if (!l) continue
      area[l]++
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder[l] = 1
    }
  }
  for (let p = 0; p < mask.length; p++) {
    const l = labels[p]
    if (l && !touchesBorder[l] && area[l] <= maxArea) mask[p] = 1
  }
}

// Background pockets the mask closes off completely (4-connected areas of
// unset pixels that don't reach the frame)
export function enclosedHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const inv = new Uint8Array(w * h)
  for (let p = 0; p < inv.length; p++) inv[p] = mask[p] ? 0 : 1
  const { labels, count } = labelComponents4(inv, w, h)
  const touchesBorder = new Uint8Array(count + 1)
  for (let x = 0; x < w; x++) {
    touchesBorder[labels[x]] = 1
    touchesBorder[labels[(h - 1) * w + x]] = 1
  }
  for (let y = 0; y < h; y++) {
    touchesBorder[labels[y * w]] = 1
    touchesBorder[labels[y * w + w - 1]] = 1
  }
  const out = new Uint8Array(w * h)
  for (let p = 0; p < out.length; p++) if (labels[p] && !touchesBorder[labels[p]]) out[p] = 1
  return out
}

// 4-connected labelling, used for holes so a hole can't leak out through a
// diagonal gap in an 8-connected region
function labelComponents4(mask: Uint8Array, w: number, h: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(w * h)
  let count = 0
  const stack: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    count += 1
    labels[start] = count
    stack.push(start)
    while (stack.length > 0) {
      const p = stack.pop()!
      const x = p % w
      const neighbours = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < w * (h - 1) ? p + w : -1]
      for (const q of neighbours) {
        if (q >= 0 && mask[q] && !labels[q]) {
          labels[q] = count
          stack.push(q)
        }
      }
    }
  }
  return { labels, count }
}

// Disc of radius r (px) around (cx, cy), OR-ed into `mask`
export function paintDisc(mask: Uint8Array, w: number, h: number, cx: number, cy: number, r: number): void {
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(w - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(h - 1, Math.ceil(cy + r))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * w + x] = 1
    }
  }
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]
}
