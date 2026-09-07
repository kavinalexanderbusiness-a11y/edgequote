export type RasterDimensions = { width: number; height: number }
export const MAX_RASTER_PIXELS = 40_000_000
export const MAX_RASTER_SIDE = 20_000
export const MAX_RASTER_BYTES = 12 * 1024 * 1024

function dimensions(width: number, height: number): RasterDimensions | null {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && width <= MAX_RASTER_SIDE && height <= MAX_RASTER_SIDE && width * height <= MAX_RASTER_PIXELS
    ? { width, height } : null
}

/** Header preflight only: compressed pixels still need a decoder and a second
 * decoded-size check. No allocation is based on dimensions from the file. */
export function readRasterDimensions(bytes: Uint8Array): RasterDimensions | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > MAX_RASTER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (offset: number, value: string) => [...value].every((c, i) => bytes[offset + i] === c.charCodeAt(0))

  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || !text(12, 'IHDR')) return null
    return dimensions(view.getUint32(16), view.getUint32(20))
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2, result: RasterDimensions | null = null
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) return null
      while (offset < bytes.length && bytes[offset] === 0xff) offset++
      if (offset >= bytes.length) return null
      const marker = bytes[offset++]
      if (marker === 0xd9) return result
      // Stuffed bytes/restarts belong to entropy data, never this header walk.
      if (marker === 0 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)
        || offset + 2 > bytes.length) return null
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) return null
      if (marker === 0xda) return result // Do not inspect entropy or embedded marker-like pixels.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if ((marker !== 0xc0 && marker !== 0xc2) || result || length < 11 || bytes[offset + 2] !== 8) return null
        const components = bytes[offset + 7]
        if (components < 1 || components > 4 || length !== 8 + 3 * components) return null
        result = dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3))
        if (!result) return null
      }
      // APP/EXIF segments are skipped by their declared length; a thumbnail's
      // SOF is never mistaken for the dimensions of the outer image.
      offset += length
    }
    return result
  }

  if (bytes.length < 12 || !text(0, 'RIFF') || !text(8, 'WEBP') || view.getUint32(4, true) + 8 !== bytes.length) return null
  let offset = 12, canvas: RasterDimensions | null = null, frame: RasterDimensions | null = null
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return null
    const size = view.getUint32(offset + 4, true), data = offset + 8
    const next = data + size + (size % 2)
    if (next > bytes.length || (size % 2 !== 0 && bytes[data + size] !== 0)) return null
    if (text(offset, 'ANIM') || text(offset, 'ANMF')) return null
    if (text(offset, 'VP8X')) {
      if (offset !== 12 || canvas || size !== 10 || (bytes[data] & 0xc3) !== 0
        || bytes[data + 1] !== 0 || bytes[data + 2] !== 0 || bytes[data + 3] !== 0) return null
      const uint24 = (at: number) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536
      canvas = dimensions(uint24(data + 4) + 1, uint24(data + 7) + 1)
      if (!canvas) return null
    } else if (text(offset, 'VP8L')) {
      if (frame || size < 5 || bytes[data] !== 0x2f) return null
      const bits = view.getUint32(data + 1, true)
      if ((bits >>> 29) !== 0) return null
      frame = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
      if (!frame) return null
    } else if (text(offset, 'VP8 ')) {
      if (frame || size < 10 || (bytes[data] & 1) !== 0 || ![0, 1, 2, 3].includes((bytes[data] >>> 1) & 7)
        || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return null
      frame = dimensions(view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff)
      if (!frame) return null
    }
    offset = next
  }
  // Extended canvas and bitstream must agree; a small VP8X cannot conceal a
  // larger frame allocation. Animation chunks were refused across the full file.
  if (!frame || (canvas && (canvas.width !== frame.width || canvas.height !== frame.height))) return null
  return frame
}
