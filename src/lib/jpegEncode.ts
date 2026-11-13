// A baseline JPEG encoder that keeps colour at full resolution (4:4:4).
//
// The browser's own encoder (canvas.toBlob / convertToBlob) halves the colour
// resolution in both directions at every quality below 100% — fine for a
// photo straight from a camera, but it smears colour across sharp edges (skin
// against a dark background, a red hem), and a picture that already went
// through that once at the model shows it when it goes through it again.
// At 100% the browser does keep full colour, but the file is nearly the size
// of a PNG. This keeps full colour at an ordinary quality setting.
//
// Plain baseline JPEG: 8×8 DCT, the standard quantisation tables scaled by
// quality the way libjpeg does, the standard Huffman tables. Pure (no DOM),
// so it runs in a worker.

// Natural index → position in zig-zag order
const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57,
  58, 62, 63,
]

// Annex K of the JPEG standard
const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87,
  80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92,
  95, 98, 112, 100, 103, 99,
]
const CHROMA_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99,
]
const DC_LUMA_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
const DC_CHROMA_COUNTS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const AC_LUMA_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]
const AC_LUMA_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
  0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
  0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
  0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94,
  0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8,
  0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
]
const AC_CHROMA_COUNTS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77]
const AC_CHROMA_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81,
  0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34,
  0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44,
  0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92,
  0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
  0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
]
// Scale factors of the fast (AAN) DCT, folded into the quantisation step
const AAN = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.5411961, 0.275899379]

interface Huffman {
  code: Uint16Array
  size: Uint8Array
}

function huffman(counts: number[], values: number[]): Huffman {
  const code = new Uint16Array(256)
  const size = new Uint8Array(256)
  let next = 0
  let k = 0
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) {
      code[values[k]] = next
      size[values[k]] = length
      k++
      next++
    }
    next <<= 1
  }
  return { code, size }
}

// quality: 1–100, as in libjpeg
export function encodeJpeg(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, quality: number): Uint8Array {
  const q = Math.min(100, Math.max(1, Math.round(quality)))
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - 2 * q
  const table = (base: number[]) => base.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))))
  const lumaQ = table(LUMA_QUANT)
  const chromaQ = table(CHROMA_QUANT)
  // 1 / (step × DCT scale), natural order
  const divisor = (steps: number[]) => {
    const out = new Float32Array(64)
    for (let i = 0; i < 64; i++) out[i] = 1 / (steps[i] * AAN[i >> 3] * AAN[i & 7] * 8)
    return out
  }
  const lumaDiv = divisor(lumaQ)
  const chromaDiv = divisor(chromaQ)

  const dcLuma = huffman(DC_LUMA_COUNTS, DC_VALUES)
  const acLuma = huffman(AC_LUMA_COUNTS, AC_LUMA_VALUES)
  const dcChroma = huffman(DC_CHROMA_COUNTS, DC_VALUES)
  const acChroma = huffman(AC_CHROMA_COUNTS, AC_CHROMA_VALUES)

  // Output, grown as needed
  let out = new Uint8Array(Math.max(4096, (width * height) >> 1))
  let at = 0
  const room = (bytes: number) => {
    if (at + bytes <= out.length) return
    const bigger = new Uint8Array(Math.max(out.length * 2, at + bytes))
    bigger.set(out.subarray(0, at))
    out = bigger
  }
  const byte = (v: number) => {
    room(1)
    out[at++] = v
  }
  const word = (v: number) => {
    byte((v >> 8) & 0xff)
    byte(v & 0xff)
  }
  const bytes = (list: ArrayLike<number>) => {
    room(list.length)
    for (let i = 0; i < list.length; i++) out[at++] = list[i]
  }

  // --- headers ---
  word(0xffd8)
  word(0xffe0) // JFIF
  word(16)
  bytes([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  word(0xffdb) // quantisation tables, in zig-zag order
  word(132)
  for (const [id, steps] of [
    [0, lumaQ],
    [1, chromaQ],
  ] as const) {
    byte(id)
    const zz = new Uint8Array(64)
    for (let i = 0; i < 64; i++) zz[ZIGZAG[i]] = steps[i]
    bytes(zz)
  }
  word(0xffc0) // baseline frame: three components, none subsampled
  word(17)
  byte(8)
  word(height)
  word(width)
  byte(3)
  bytes([1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
  word(0xffc4) // Huffman tables
  word(2 + 4 * 17 + 2 * DC_VALUES.length + AC_LUMA_VALUES.length + AC_CHROMA_VALUES.length)
  for (const [id, counts, values] of [
    [0x00, DC_LUMA_COUNTS, DC_VALUES],
    [0x10, AC_LUMA_COUNTS, AC_LUMA_VALUES],
    [0x01, DC_CHROMA_COUNTS, DC_VALUES],
    [0x11, AC_CHROMA_COUNTS, AC_CHROMA_VALUES],
  ] as const) {
    byte(id)
    bytes(counts)
    bytes(values)
  }
  word(0xffda) // scan
  word(12)
  byte(3)
  bytes([1, 0x00, 2, 0x11, 3, 0x11, 0, 0x3f, 0])

  // --- entropy-coded data ---
  let acc = 0
  let pending = 0
  const put = (code: number, size: number) => {
    acc = (acc << size) | code
    pending += size
    while (pending >= 8) {
      const v = (acc >>> (pending - 8)) & 0xff
      room(2)
      out[at++] = v
      if (v === 0xff) out[at++] = 0
      pending -= 8
    }
    acc &= (1 << pending) - 1
  }

  const block = new Float32Array(64)
  const coeff = new Int32Array(64)

  // Forward DCT + quantisation of `block` into `coeff` (zig-zag order)
  const transform = (div: Float32Array) => {
    for (let pass = 0; pass < 2; pass++) {
      const step = pass === 0 ? 1 : 8
      const stride = pass === 0 ? 8 : 1
      for (let n = 0; n < 8; n++) {
        const o = n * stride
        const d0 = block[o]
        const d1 = block[o + step]
        const d2 = block[o + 2 * step]
        const d3 = block[o + 3 * step]
        const d4 = block[o + 4 * step]
        const d5 = block[o + 5 * step]
        const d6 = block[o + 6 * step]
        const d7 = block[o + 7 * step]
        const t0 = d0 + d7
        const t7 = d0 - d7
        const t1 = d1 + d6
        const t6 = d1 - d6
        const t2 = d2 + d5
        const t5 = d2 - d5
        const t3 = d3 + d4
        const t4 = d3 - d4
        // even part
        let t10 = t0 + t3
        const t13 = t0 - t3
        let t11 = t1 + t2
        let t12 = t1 - t2
        block[o] = t10 + t11
        block[o + 4 * step] = t10 - t11
        const z1 = (t12 + t13) * 0.707106781
        block[o + 2 * step] = t13 + z1
        block[o + 6 * step] = t13 - z1
        // odd part
        t10 = t4 + t5
        t11 = t5 + t6
        t12 = t6 + t7
        const z5 = (t10 - t12) * 0.382683433
        const z2 = 0.5411961 * t10 + z5
        const z4 = 1.306562965 * t12 + z5
        const z3 = t11 * 0.707106781
        const z11 = t7 + z3
        const z13 = t7 - z3
        block[o + 5 * step] = z13 + z2
        block[o + 3 * step] = z13 - z2
        block[o + step] = z11 + z4
        block[o + 7 * step] = z11 - z4
      }
    }
    for (let i = 0; i < 64; i++) {
      const v = block[i] * div[i]
      coeff[ZIGZAG[i]] = v > 0 ? (v + 0.5) | 0 : (v - 0.5) | 0
    }
  }

  const bitLength = (v: number) => 32 - Math.clz32(v)
  // Writes one transformed block; returns its DC value
  const write = (previousDc: number, dc: Huffman, ac: Huffman): number => {
    const diff = coeff[0] - previousDc
    if (diff === 0) {
      put(dc.code[0], dc.size[0])
    } else {
      const category = bitLength(Math.abs(diff))
      put(dc.code[category], dc.size[category])
      put((diff < 0 ? diff - 1 : diff) & ((1 << category) - 1), category)
    }
    let last = 63
    while (last > 0 && coeff[last] === 0) last--
    let run = 0
    for (let i = 1; i <= last; i++) {
      const v = coeff[i]
      if (v === 0) {
        run++
        continue
      }
      while (run > 15) {
        put(ac.code[0xf0], ac.size[0xf0])
        run -= 16
      }
      const category = bitLength(Math.abs(v))
      const symbol = (run << 4) | category
      put(ac.code[symbol], ac.size[symbol])
      put((v < 0 ? v - 1 : v) & ((1 << category) - 1), category)
      run = 0
    }
    if (last < 63) put(ac.code[0], ac.size[0])
    return coeff[0]
  }

  // The picture in Y'CbCr, level-shifted, one plane at a time per block
  const ys = new Float32Array(64)
  const cbs = new Float32Array(64)
  const crs = new Float32Array(64)
  let dcY = 0
  let dcCb = 0
  let dcCr = 0
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y++) {
        // past the edge, the last row / column repeats
        const row = Math.min(height - 1, by + y) * width
        for (let x = 0; x < 8; x++) {
          const p = (row + Math.min(width - 1, bx + x)) * 4
          const r = rgba[p]
          const g = rgba[p + 1]
          const b = rgba[p + 2]
          const i = y * 8 + x
          ys[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128
          cbs[i] = -0.168736 * r - 0.331264 * g + 0.5 * b
          crs[i] = 0.5 * r - 0.418688 * g - 0.081312 * b
        }
      }
      block.set(ys)
      transform(lumaDiv)
      dcY = write(dcY, dcLuma, acLuma)
      block.set(cbs)
      transform(chromaDiv)
      dcCb = write(dcCb, dcChroma, acChroma)
      block.set(crs)
      transform(chromaDiv)
      dcCr = write(dcCr, dcChroma, acChroma)
    }
  }
  // pad the last byte with ones
  if (pending > 0) put((1 << (8 - pending)) - 1, 8 - pending)
  word(0xffd9)
  return out.slice(0, at)
}

// A picture's pixels the way the browser shows it (upright), over white
// where it is transparent, scaled down to `maxSide` if it is larger
export async function readPixels(picture: Blob, maxSide?: number): Promise<ImageData> {
  const bitmap = await createImageBitmap(picture)
  try {
    const scale = maxSide ? Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height)) : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    // JPEG has no alpha channel
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)
    return ctx.getImageData(0, 0, width, height)
  } finally {
    bitmap.close()
  }
}
