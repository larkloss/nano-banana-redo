// A zip archive of files stored as they are (no compression: pictures and
// videos are compressed already).
//
// The archive is a Blob made of small headers and the files' own Blobs, so
// the files' bytes are never copied into memory here: the browser reads them
// from wherever it keeps them when the archive is saved. The one thing a zip
// needs from the contents, a CRC-32 per file, is computed by reading each
// file in pieces, one piece in memory at a time.

export interface ZipEntry {
  // Path inside the archive. Entries are written as given, in this order;
  // names are not checked for duplicates.
  name: string
  blob: Blob
}

// The classic format's limits (no zip64 here): 4 GB per file and for the
// whole archive, 65535 files
const MAX_SIZE = 0xffffffff
const MAX_ENTRIES = 0xffff
// Names are UTF-8 (general purpose bit 11)
const FLAG_UTF8 = 0x0800
// "2.0": what a reader has to support for this archive
const VERSION = 20

export async function zipStore(entries: ZipEntry[], modified: Date = new Date()): Promise<Blob> {
  if (entries.length > MAX_ENTRIES) throw new Error('too many files for one zip archive')
  const { time, date } = dosTime(modified)
  const parts: BlobPart[] = []
  const directory: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  let directorySize = 0

  for (const { name, blob } of entries) {
    const nameBytes = new TextEncoder().encode(name)
    const size = blob.size
    if (nameBytes.length > 0xffff) throw new Error('file name too long for a zip archive')
    if (size > MAX_SIZE || offset + 30 + nameBytes.length + size > MAX_SIZE)
      throw new Error('too much for one zip archive (4 GB)')
    const crc = await crc32(blob)

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, VERSION, true)
    lv.setUint16(6, FLAG_UTF8, true)
    lv.setUint16(8, 0, true) // stored
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true) // as stored
    lv.setUint32(22, size, true) // original
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // no extra field
    local.set(nameBytes, 30)

    // Its entry in the central directory, which repeats the header and says
    // where the file starts
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, VERSION, true) // made by
    cv.setUint16(6, VERSION, true) // needed to read
    cv.setUint16(8, FLAG_UTF8, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    // 30…41: no extra field, no comment, disk 0, no attributes
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    parts.push(local, blob)
    directory.push(central)
    offset += local.length + size
    directorySize += central.length
  }
  if (offset + directorySize > MAX_SIZE) throw new Error('too much for one zip archive (4 GB)')

  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  // 4…7: disk numbers (0)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, directorySize, true)
  ev.setUint32(16, offset, true)
  // 20: no comment

  return new Blob([...parts, ...directory, end], { type: 'application/zip' })
}

// Date and time the way zip stores them: local time, two-second steps, years
// from 1980
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()))
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

// CRC-32 (the zip / PNG one), eight bytes per step
let tables: Uint32Array[] | null = null
function crcTables(): Uint32Array[] {
  if (tables) return tables
  const first = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    first[i] = c
  }
  const made = [first]
  for (let t = 1; t < 8; t++) {
    const prev = made[t - 1]
    const next = new Uint32Array(256)
    for (let i = 0; i < 256; i++) next[i] = first[prev[i] & 0xff] ^ (prev[i] >>> 8)
    made.push(next)
  }
  tables = made
  return made
}

// Continues a running CRC (start with 0xffffffff, invert at the end)
function crcUpdate(crc: number, bytes: Uint8Array): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = crcTables()
  let c = crc
  let i = 0
  const whole = bytes.length - 7
  for (; i < whole; i += 8) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)
    c =
      t7[c & 0xff] ^
      t6[(c >>> 8) & 0xff] ^
      t5[(c >>> 16) & 0xff] ^
      t4[c >>> 24] ^
      t3[bytes[i + 4]] ^
      t2[bytes[i + 5]] ^
      t1[bytes[i + 6]] ^
      t0[bytes[i + 7]]
  }
  for (; i < bytes.length; i++) c = t0[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return c
}

// Size of the pieces a file is read in
const PIECE = 1024 * 1024

export async function crc32(blob: Blob): Promise<number> {
  let crc = 0xffffffff
  const stream = blob.stream()
  // Into one buffer that is handed back and forth, where the browser can:
  // otherwise every piece read is a new allocation, and those pile up until
  // the garbage collector comes by
  let own: ReadableStreamBYOBReader | null = null
  try {
    own = stream.getReader({ mode: 'byob' })
  } catch {
    // not a byte stream in this browser
  }
  if (own) {
    let buffer = new ArrayBuffer(PIECE)
    for (;;) {
      const { done, value } = await own.read(new Uint8Array(buffer))
      if (!value) break
      crc = crcUpdate(crc, value)
      buffer = value.buffer
      if (done) break
    }
  } else {
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      crc = crcUpdate(crc, value)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
