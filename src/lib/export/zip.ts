// ── A ZIP file, written by hand ──────────────────────────────────────────────
// The data export hands the owner ONE download containing a dozen CSVs, and a
// .zip is the only container every operating system, spreadsheet and accountant
// already opens. This writes one with no new dependency: Node ships DEFLATE in
// `node:zlib`, and DEFLATE is exactly what ZIP method 8 stores.
//
// Why not a library: the archive is a dozen small text files with ASCII names —
// the part of the spec that needs care (ZIP64, encryption, unicode paths,
// streaming descriptors) is the part we deliberately refuse to enter. Refusing
// is the safety property: `zipArchive` THROWS rather than emit an archive whose
// sizes it cannot represent, because a silently-truncated backup is the worst
// possible outcome for a feature whose whole job is "you own your data".
//
// Server-only (Buffer + node:zlib). Routes using it must run on the Node runtime.

import { deflateRawSync } from 'node:zlib'

export interface ZipFile {
  /** Archive-relative name. ASCII, no directories needed for this export. */
  name: string
  body: Buffer
}

// ── CRC-32 (IEEE 802.3), the checksum every ZIP entry carries ────────────────
// Built once, lazily: a 256-entry table costs nothing but there is no reason to
// pay for it in a process that never exports.
let CRC_TABLE: Uint32Array | null = null
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  CRC_TABLE = t
  return t
}

export function crc32(buf: Buffer): number {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ZIP stores timestamps in the 1980 MS-DOS packed format, at 2-second accuracy.
// Dates outside its range would wrap to a nonsense year, so they are clamped:
// a wrong-looking modified time is cosmetic, a corrupt header is not.
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
// Bit 11 — "the filename is UTF-8". Ours are ASCII, so this only ever states
// the truth, and it is what stops a future non-ASCII name being read as CP437.
const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
// Beyond these, ZIP needs ZIP64 headers this writer does not emit.
const MAX_U32 = 0xffffffff
const MAX_ENTRIES = 0xffff

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipLimitError'
  }
}

/**
 * Build a complete .zip in memory.
 *
 * Every entry is compressed and checksummed BEFORE any byte of the archive is
 * produced, so the returned Buffer is either a whole valid archive or nothing at
 * all — the caller never has to hand a half-written file to a browser.
 *
 * @throws {ZipLimitError} when the archive would need ZIP64 to be represented.
 */
export function zipArchive(files: ZipFile[], now: Date): Buffer {
  if (files.length > MAX_ENTRIES) {
    throw new ZipLimitError(`A zip written here holds at most ${MAX_ENTRIES} files; got ${files.length}.`)
  }
  const { time, date } = dosDateTime(now)

  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const raw = f.body
    // Compress, but keep whichever is smaller. A 20-byte CSV header deflates to
    // MORE than 20 bytes, and storing it instead is both smaller and readable in
    // a hex dump — there is no reason to pay for compression that costs bytes.
    const deflated = deflateRawSync(raw)
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE

    if (raw.length > MAX_U32 || body.length > MAX_U32) {
      throw new ZipLimitError(`"${f.name}" is too large for a non-ZIP64 archive.`)
    }

    const crc = crc32(raw)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4)            // version needed to extract (2.0)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)  // compressed size
    local.writeUInt32LE(raw.length, 22)   // uncompressed size
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)            // no extra field
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4)          // version made by
    central.writeUInt16LE(20, 6)          // version needed
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)          // extra length
    central.writeUInt16LE(0, 32)          // comment length
    central.writeUInt16LE(0, 34)          // disk number start
    central.writeUInt16LE(0, 36)          // internal attributes
    central.writeUInt32LE(0, 38)          // external attributes
    central.writeUInt32LE(offset, 42)     // offset of this entry's local header
    name.copy(central, 46)

    locals.push(local, body)
    centrals.push(central)
    offset += local.length + body.length
    if (offset > MAX_U32) throw new ZipLimitError('The archive is too large for a non-ZIP64 zip.')
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  if (centralSize > MAX_U32) throw new ZipLimitError('The archive index is too large for a non-ZIP64 zip.')

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)                 // this disk
  eocd.writeUInt16LE(0, 6)                 // disk with the central directory
  eocd.writeUInt16LE(files.length, 8)      // entries on this disk
  eocd.writeUInt16LE(files.length, 10)     // entries total
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)           // central directory offset
  eocd.writeUInt16LE(0, 20)                // no archive comment

  return Buffer.concat([...locals, ...centrals, eocd])
}
