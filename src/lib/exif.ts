// ── Minimal EXIF capture-time reader ─────────────────────────────────────────────
// Pure client, zero deps. Pulls DateTimeOriginal out of a JPEG so we can tell which
// photo was taken first (the "before") and which last (the "after"). We only need
// the timestamp — not a full EXIF parser — so we read just the APP1 segment and bail
// out (returning null) on anything unexpected. PNG/HEIC/edited images simply return
// null and the caller falls back to file order / lastModified.

// Read the smallest slice that reliably contains EXIF (it lives near the top of the
// file). 256 KB is generous; most cameras put APP1 in the first few KB.
const SCAN_BYTES = 256 * 1024

function parseExifDate(s: string): number | null {
  // EXIF format: "YYYY:MM:DD HH:MM:SS" (no timezone — treat as local time).
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)).getTime()
  return Number.isFinite(t) ? t : null
}

// Returns the capture time in ms, or null if not found / not a JPEG with EXIF.
export async function readCaptureTime(file: File): Promise<number | null> {
  if (!file.type.startsWith('image/')) return null
  try {
    const buf = await file.slice(0, SCAN_BYTES).arrayBuffer()
    const view = new DataView(buf)
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null // not a JPEG

    let offset = 2
    while (offset + 4 < view.byteLength) {
      if (view.getUint16(offset) !== 0xffe1) {
        // Not APP1 — skip this segment using its length and keep scanning markers.
        if ((view.getUint16(offset) & 0xff00) !== 0xff00) break
        offset += 2 + view.getUint16(offset + 2)
        continue
      }
      // APP1 — confirm the "Exif\0\0" header.
      const segStart = offset + 4
      if (view.getUint32(segStart) !== 0x45786966 /* 'Exif' */) return null
      const tiff = segStart + 6
      const little = view.getUint16(tiff) === 0x4949 // 'II' little-endian, 'MM' big
      const u16 = (o: number) => view.getUint16(o, little)
      const u32 = (o: number) => view.getUint32(o, little)
      if (u16(tiff + 2) !== 0x002a) return null // TIFF magic

      const ifd0 = tiff + u32(tiff + 4)
      const findTag = (ifd: number, tag: number): number | null => {
        if (ifd + 2 > view.byteLength) return null
        const count = u16(ifd)
        for (let i = 0; i < count; i++) {
          const entry = ifd + 2 + i * 12
          if (entry + 12 > view.byteLength) break
          if (u16(entry) === tag) return entry
        }
        return null
      }
      // IFD0 → Exif sub-IFD pointer (0x8769) → DateTimeOriginal (0x9003).
      const exifPtr = findTag(ifd0, 0x8769)
      const readAscii = (entry: number): string | null => {
        const len = u32(entry + 4)
        const valOff = len <= 4 ? entry + 8 : tiff + u32(entry + 8)
        if (valOff + Math.min(len, 20) > view.byteLength) return null
        let s = ''
        for (let i = 0; i < Math.min(len, 20); i++) {
          const c = view.getUint8(valOff + i)
          if (c === 0) break
          s += String.fromCharCode(c)
        }
        return s
      }
      if (exifPtr) {
        const exifIfd = tiff + u32(exifPtr + 8)
        const dto = findTag(exifIfd, 0x9003) || findTag(exifIfd, 0x9004) // DateTimeOriginal, then DateTimeDigitized
        if (dto) { const s = readAscii(dto); if (s) { const t = parseExifDate(s); if (t) return t } }
      }
      // Fall back to IFD0 DateTime (0x0132) if the sub-IFD had nothing usable.
      const dt = findTag(ifd0, 0x0132)
      if (dt) { const s = readAscii(dt); if (s) return parseExifDate(s) }
      return null
    }
    return null
  } catch {
    return null
  }
}

// Best available capture time: EXIF first, then the file's lastModified (which a
// phone usually sets to capture time on a fresh photo), so ordering still works for
// non-EXIF images. `exact` says whether it came from EXIF (drives the confidence).
export interface CaptureStamp { ms: number; exact: boolean }
export async function captureStampFor(file: File): Promise<CaptureStamp> {
  const exif = await readCaptureTime(file)
  if (exif != null) return { ms: exif, exact: true }
  return { ms: file.lastModified || 0, exact: false }
}
