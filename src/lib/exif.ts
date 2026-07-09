// ── Minimal EXIF reader (capture time + GPS) ─────────────────────────────────────
// Pure client, zero deps. Pulls DateTimeOriginal and the GPS position out of a JPEG
// so uploads can be ordered (before vs after), grouped (same visit vs next job) and
// placed (which property). We only read the one APP1 segment — not a full EXIF
// parser — and bail out (nulls) on anything unexpected. PNG/HEIC/edited images just
// return nulls and callers fall back to file order / lastModified.

// EXIF lives near the top of the file; 256 KB is generous.
const SCAN_BYTES = 256 * 1024

export interface ExifMeta {
  timeMs: number | null   // DateTimeOriginal (local time), ms
  lat: number | null
  lng: number | null
}

function parseExifDate(s: string): number | null {
  // EXIF format: "YYYY:MM:DD HH:MM:SS" (no timezone — treat as local time).
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)).getTime()
  return Number.isFinite(t) ? t : null
}

// Parse the APP1/TIFF structure once, returning time + GPS together.
export async function readExifMeta(file: File): Promise<ExifMeta> {
  const none: ExifMeta = { timeMs: null, lat: null, lng: null }
  if (!file.type.startsWith('image/')) return none
  try {
    const buf = await file.slice(0, SCAN_BYTES).arrayBuffer()
    const view = new DataView(buf)
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return none // not a JPEG

    let offset = 2
    while (offset + 4 < view.byteLength) {
      if (view.getUint16(offset) !== 0xffe1) {
        if ((view.getUint16(offset) & 0xff00) !== 0xff00) break
        offset += 2 + view.getUint16(offset + 2)
        continue
      }
      const segStart = offset + 4
      if (view.getUint32(segStart) !== 0x45786966 /* 'Exif' */) return none
      const tiff = segStart + 6
      const little = view.getUint16(tiff) === 0x4949
      const u16 = (o: number) => view.getUint16(o, little)
      const u32 = (o: number) => view.getUint32(o, little)
      if (u16(tiff + 2) !== 0x002a) return none

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
      const readAscii = (entry: number, max = 20): string | null => {
        const len = u32(entry + 4)
        const valOff = len <= 4 ? entry + 8 : tiff + u32(entry + 8)
        if (valOff + Math.min(len, max) > view.byteLength) return null
        let s = ''
        for (let i = 0; i < Math.min(len, max); i++) {
          const c = view.getUint8(valOff + i)
          if (c === 0) break
          s += String.fromCharCode(c)
        }
        return s
      }
      // GPS coordinates are 3 RATIONALs (deg, min, sec), each num/den u32 pair.
      const readRationals = (entry: number, n: number): number[] | null => {
        const valOff = tiff + u32(entry + 8)
        if (valOff + n * 8 > view.byteLength) return null
        const out: number[] = []
        for (let i = 0; i < n; i++) {
          const num = u32(valOff + i * 8), den = u32(valOff + i * 8 + 4)
          out.push(den ? num / den : 0)
        }
        return out
      }

      const ifd0 = tiff + u32(tiff + 4)

      // Capture time: Exif sub-IFD DateTimeOriginal → DateTimeDigitized → IFD0 DateTime.
      let timeMs: number | null = null
      const exifPtr = findTag(ifd0, 0x8769)
      if (exifPtr) {
        const exifIfd = tiff + u32(exifPtr + 8)
        const dto = findTag(exifIfd, 0x9003) || findTag(exifIfd, 0x9004)
        if (dto) { const s = readAscii(dto); if (s) timeMs = parseExifDate(s) }
      }
      if (timeMs == null) {
        const dt = findTag(ifd0, 0x0132)
        if (dt) { const s = readAscii(dt); if (s) timeMs = parseExifDate(s) }
      }

      // GPS: IFD0 GPS pointer (0x8825) → LatRef/Lat/LngRef/Lng.
      let lat: number | null = null, lng: number | null = null
      const gpsPtr = findTag(ifd0, 0x8825)
      if (gpsPtr) {
        const gpsIfd = tiff + u32(gpsPtr + 8)
        const latRefE = findTag(gpsIfd, 0x0001), latE = findTag(gpsIfd, 0x0002)
        const lngRefE = findTag(gpsIfd, 0x0003), lngE = findTag(gpsIfd, 0x0004)
        if (latE && lngE) {
          const latDms = readRationals(latE, 3), lngDms = readRationals(lngE, 3)
          if (latDms && lngDms) {
            const toDeg = (d: number[]) => d[0] + d[1] / 60 + d[2] / 3600
            let la = toDeg(latDms), ln = toDeg(lngDms)
            const latRef = latRefE ? readAscii(latRefE, 2) : 'N'
            const lngRef = lngRefE ? readAscii(lngRefE, 2) : 'E'
            if ((latRef || 'N').toUpperCase().startsWith('S')) la = -la
            if ((lngRef || 'E').toUpperCase().startsWith('W')) ln = -ln
            if (Number.isFinite(la) && Number.isFinite(ln) && (la !== 0 || ln !== 0)) { lat = la; lng = ln }
          }
        }
      }
      return { timeMs, lat, lng }
    }
    return none
  } catch {
    return none
  }
}

// Returns the capture time in ms, or null if not found / not a JPEG with EXIF.
export async function readCaptureTime(file: File): Promise<number | null> {
  return (await readExifMeta(file)).timeMs
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

// Stamp + GPS in one read — what the grouping engine wants.
export interface CaptureMeta extends CaptureStamp { lat: number | null; lng: number | null }
export async function captureMetaFor(file: File): Promise<CaptureMeta> {
  const meta = await readExifMeta(file)
  if (meta.timeMs != null) return { ms: meta.timeMs, exact: true, lat: meta.lat, lng: meta.lng }
  return { ms: file.lastModified || 0, exact: false, lat: meta.lat, lng: meta.lng }
}
