import { growSurfaceRegion, combineSurfaceMasks, scaledSurfaceArea, MAX_SCAN_PIXELS, type ScanImage, type ScanBounds } from '../../src/lib/surfaceScan'
import { M_TO_FT } from '../../src/lib/measure/geometry'
import { readRasterDimensions, MAX_RASTER_BYTES } from '../../src/lib/imageDimensions'

type Check = (name: string, passed: boolean, detail?: string) => void

export function verifySurfaceScan(check: Check): void {
  verifyRasterDimensions(check)
  const equal = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  const near = (name: string, actual: number | null, expected: number) => check(name, actual !== null && Math.abs(actual - expected) <= Math.max(1, expected) * 1e-12, `expected ${expected}, got ${actual}`)
  const image = (rows: number[][]): ScanImage => ({ width: rows[0].length, height: rows.length,
    data: new Uint8ClampedArray(rows.flatMap(row => row.flatMap(v => v < 0 ? [0, 120, 0, 0] : [v, v, v, 255]))) })
  const bounds = (i: ScanImage): ScanBounds => ({ x: 0, y: 0, width: i.width, height: i.height })
  const selected = (mask: Uint8Array | undefined) => mask ? [...mask].flatMap((v, i) => v === 1 ? [i] : []) : null
  const patch = image([[200, 200, 200, 200, 200], [200, 30, 30, 200, 30], [200, 30, 200, 200, 30], [200, 200, 200, 200, 200]])
  const bytes = [...patch.data]
  const connected = growSurfaceRegion(patch, { x: 1, y: 1 }, bounds(patch), 0)
  equal('seed growth selects only the connected matching patch', selected(connected?.mask), [6, 7, 11])
  equal('disjoint matching pixels do not increase region count', connected?.pixelCount, 3)
  equal('enclosed matching patch does not touch ROI boundary', connected?.touchesBoundary, false)
  equal('region growth leaves RGBA source unchanged', [...patch.data], bytes)
  equal('returned mask contains only binary values', connected && [...connected.mask].every(v => v === 0 || v === 1), true)
  equal('diagonal pixels are not connected', growSurfaceRegion(image([[10, 200], [200, 10]]), { x: 0, y: 0 }, { x: 0, y: 0, width: 2, height: 2 }, 0)?.pixelCount, 1)
  const transparent = image([[30, -1, 30]])
  equal('transparent bridge blocks connected growth even at maximum tolerance', growSurfaceRegion(transparent, { x: 0, y: 0 }, bounds(transparent), 255)?.pixelCount, 1)
  equal('transparent seed is refused', growSurfaceRegion(transparent, { x: 1, y: 0 }, bounds(transparent), 255), null)
  const gradient = image([[0, 10, 20, 30]])
  equal('seed-relative tolerance does not creep through a colour gradient', selected(growSurfaceRegion(gradient, { x: 0, y: 0 }, bounds(gradient), 10)?.mask), [0, 1])
  equal('a slightly lower tolerance excludes the neighbouring shade', growSurfaceRegion(gradient, { x: 0, y: 0 }, bounds(gradient), 9.99)?.pixelCount, 1)
  const channels: ScanImage = { width: 3, height: 1, data: new Uint8Array([0, 0, 0, 255, 3, 0, 0, 255, 3, 4, 0, 255]) }
  equal('RGB distance uses all colour channels with RMS threshold', growSurfaceRegion(channels, { x: 0, y: 0 }, bounds(channels), 2)?.pixelCount, 2)
  const solid = image([[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]])
  const cropped = growSurfaceRegion(solid, { x: 1, y: 1 }, { x: 1, y: 1, width: 2, height: 1 }, 0)
  equal('ROI clips matching content outside the selected bounds', selected(cropped?.mask), [5, 6])
  equal('selection reaching a cropped ROI reports boundary contact', cropped?.touchesBoundary, true)
  equal('selection reaching image edge reports boundary contact', growSurfaceRegion(solid, { x: 0, y: 0 }, bounds(solid), 0)?.touchesBoundary, true)

  const refused: Array<[string, ScanImage, { x: number; y: number }, ScanBounds, number]> = [
    ['zero image width', { ...solid, width: 0 }, { x: 0, y: 0 }, bounds(solid), 0],
    ['fractional image width', { ...solid, width: 3.5 }, { x: 0, y: 0 }, bounds(solid), 0],
    ['oversized image side', { ...solid, width: 1601 }, { x: 0, y: 0 }, bounds(solid), 0],
    ['wrong RGBA array length', { ...solid, data: solid.data.subarray(1) }, { x: 0, y: 0 }, bounds(solid), 0],
    ['non-byte image array', { ...solid, data: new Float32Array(48) as unknown as Uint8Array }, { x: 0, y: 0 }, bounds(solid), 0],
    ['negative ROI origin', solid, { x: 0, y: 0 }, { x: -1, y: 0, width: 2, height: 2 }, 0],
    ['empty ROI', solid, { x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 2 }, 0],
    ['overflowing ROI', solid, { x: 3, y: 0 }, { x: 3, y: 0, width: 2, height: 2 }, 0],
    ['fractional ROI', solid, { x: 1, y: 0 }, { x: 0.5, y: 0, width: 2, height: 2 }, 0],
    ['seed outside ROI', solid, { x: 0, y: 0 }, { x: 1, y: 1, width: 2, height: 2 }, 0],
    ['seed on exclusive edge', solid, { x: 4, y: 0 }, bounds(solid), 0],
    ['fractional seed', solid, { x: 0.5, y: 0 }, bounds(solid), 0],
    ['NaN seed', solid, { x: NaN, y: 0 }, bounds(solid), 0],
    ...[-1, 256, NaN, Infinity].map(t => [`invalid tolerance ${t}`, solid, { x: 0, y: 0 }, bounds(solid), t] as [string, ScanImage, { x: number; y: number }, ScanBounds, number]),
  ]
  for (const [name, i, seed, roi, tolerance] of refused) equal(name, growSurfaceRegion(i, seed, roi, tolerance), null)

  const a = new Uint8Array([1, 1, 0, 0]), b = new Uint8Array([0, 1, 1, 0])
  const union = combineSurfaceMasks(a, b, 'add')
  equal('union counts overlapping selections only once', union && [[...union.mask], union.pixelCount], [[1, 1, 1, 0], 3])
  const subtracted = union && combineSurfaceMasks(union.mask, b, 'subtract')
  equal('subtraction removes only previously included pixels', subtracted && [[...subtracted.mask], subtracted.pixelCount], [[1, 0, 0, 0], 1])
  equal('removing an unrelated selection cannot add pixels', combineSurfaceMasks(a, new Uint8Array([0, 0, 0, 1]), 'subtract')?.pixelCount, 2)
  equal('fully removed selection has zero pixels', combineSurfaceMasks(a, a, 'subtract')?.pixelCount, 0)
  equal('mask operations preserve both source buffers', [[...a], [...b]], [[1, 1, 0, 0], [0, 1, 1, 0]])
  equal('mask size mismatch is refused', combineSurfaceMasks(a, new Uint8Array(3), 'add'), null)
  equal('non-binary mask is refused without partial output', combineSurfaceMasks(a, new Uint8Array([0, 0, 0, 2]), 'add'), null)
  equal('empty mask is refused', combineSurfaceMasks(new Uint8Array(), new Uint8Array(), 'add'), null)
  equal('unknown operation is refused', combineSurfaceMasks(a, b, 'replace' as 'add'), null)

  near('100 pixels at 10 pixels per 20 feet is 400 square feet', scaledSurfaceArea(100, { x: 0, y: 0 }, { x: 10, y: 0 }, 20, 'ft'), 400)
  near('diagonal calibration uses Euclidean distance', scaledSurfaceArea(100, { x: 1, y: 1 }, { x: 4, y: 5 }, 10, 'ft'), 400)
  near('metric distance is converted before squaring', scaledSurfaceArea(100, { x: 0, y: 0 }, { x: 10, y: 0 }, 2, 'm'), 4 * M_TO_FT * M_TO_FT)
  near('fractional calibration points are supported', scaledSurfaceArea(4, { x: 0.25, y: 0.5 }, { x: 2.25, y: 0.5 }, 1, 'ft'), 1)
  for (const count of [0, -1, 1.5, MAX_SCAN_PIXELS + 1, NaN, Infinity]) equal(`invalid selected pixel count ${count}`, scaledSurfaceArea(count, { x: 0, y: 0 }, { x: 1, y: 0 }, 1, 'ft'), null)
  for (const distance of [0, -1, NaN, Infinity, Number.MAX_VALUE, Number.MIN_VALUE]) equal(`invalid or overflowing scale distance ${distance}`, scaledSurfaceArea(100, { x: 0, y: 0 }, { x: 1, y: 0 }, distance, 'ft'), null)
  equal('identical calibration points are refused', scaledSurfaceArea(100, { x: 3, y: 2 }, { x: 3, y: 2 }, 10, 'ft'), null)
  equal('negative calibration point is refused', scaledSurfaceArea(100, { x: -1, y: 2 }, { x: 3, y: 2 }, 10, 'ft'), null)
  equal('nonfinite calibration point is refused', scaledSurfaceArea(100, { x: 0, y: 0 }, { x: Infinity, y: 2 }, 10, 'ft'), null)
  equal('out-of-range calibration point is refused', scaledSurfaceArea(100, { x: 0, y: 0 }, { x: 1601, y: 2 }, 10, 'ft'), null)
  equal('unknown calibration unit is refused', scaledSurfaceArea(100, { x: 0, y: 0 }, { x: 1, y: 0 }, 10, 'yards' as 'ft'), null)

  // Actual upper-bound execution also catches queue sizing and revisit defects.
  const maximum: ScanImage = { width: 1600, height: 1600, data: new Uint8ClampedArray(MAX_SCAN_PIXELS * 4).fill(255) }
  const full = growSurfaceRegion(maximum, { x: 800, y: 800 }, bounds(maximum), 0)
  equal('maximum supported image completes with each pixel counted once', full?.pixelCount, MAX_SCAN_PIXELS)
  equal('maximum image mask contains every selected pixel', full && full.mask.every(v => v === 1), true)
}

function verifyRasterDimensions(check: Check): void {
  const equal = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  const join = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap(part => [...part]))
  const ascii = (text: string) => new Uint8Array([...text].map(c => c.charCodeAt(0)))
  const png = (width = 800, height = 600) => {
    const bytes = new Uint8Array(33), view = new DataView(bytes.buffer)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); bytes.set(ascii('IHDR'), 12)
    view.setUint32(16, width); view.setUint32(20, height); bytes[24] = 8; bytes[25] = 2
    return bytes
  }
  const segment = (marker: number, payload: Uint8Array) => {
    const result = new Uint8Array(payload.length + 4)
    result.set([255, marker]); new DataView(result.buffer).setUint16(2, payload.length + 2); result.set(payload, 4)
    return result
  }
  const sof = (width = 800, height = 600, marker = 0xc0) => {
    const payload = new Uint8Array([8, 0, 0, 0, 0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0])
    const view = new DataView(payload.buffer); view.setUint16(1, height); view.setUint16(3, width)
    return segment(marker, payload)
  }
  const jpeg = (...parts: Uint8Array[]) => join(new Uint8Array([255, 0xd8]), ...parts, new Uint8Array([255, 0xd9]))
  const chunk = (kind: string, payload: Uint8Array) => {
    const bytes = new Uint8Array(8 + payload.length + payload.length % 2)
    bytes.set(ascii(kind)); new DataView(bytes.buffer).setUint32(4, payload.length, true); bytes.set(payload, 8)
    return bytes
  }
  const webp = (...chunks: Uint8Array[]) => {
    const bytes = join(ascii('RIFF'), new Uint8Array(4), ascii('WEBP'), ...chunks)
    new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true); return bytes
  }
  const vp8l = (width = 800, height = 600) => {
    const payload = new Uint8Array(5); payload[0] = 0x2f
    new DataView(payload.buffer).setUint32(1, (width - 1) + (height - 1) * 16384, true)
    return chunk('VP8L', payload)
  }
  const vp8 = (width = 800, height = 600) => {
    const payload = new Uint8Array([0x10, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0])
    const view = new DataView(payload.buffer); view.setUint16(6, width, true); view.setUint16(8, height, true)
    return chunk('VP8 ', payload)
  }
  const vp8x = (width = 800, height = 600, flags = 0) => {
    const payload = new Uint8Array(10); payload[0] = flags
    for (let i = 0; i < 3; i++) { payload[4 + i] = Math.floor((width - 1) / 256 ** i) % 256; payload[7 + i] = Math.floor((height - 1) / 256 ** i) % 256 }
    return chunk('VP8X', payload)
  }
  const expected = { width: 800, height: 600 }
  equal('PNG full signature and IHDR dimensions preflight', readRasterDimensions(png()), expected)
  equal('PNG subarray reads honour byte offset', readRasterDimensions(join(new Uint8Array(7), png()).subarray(7)), expected)
  for (let i = 0; i < 8; i++) { const bad = png(); bad[i] ^= 1; equal(`PNG signature byte ${i} is required`, readRasterDimensions(bad), null) }
  equal('PNG incomplete IHDR including missing CRC is refused', readRasterDimensions(png().subarray(0, 32)), null)
  const badLength = png(); new DataView(badLength.buffer).setUint32(8, 12)
  equal('PNG incorrect declared IHDR length is refused', readRasterDimensions(badLength), null)
  const wrongType = png(); wrongType.set(ascii('IDAT'), 12)
  equal('PNG non-IHDR first chunk is refused', readRasterDimensions(wrongType), null)
  equal('PNG 40 million pixel boundary is accepted', readRasterDimensions(png(10000, 4000)), { width: 10000, height: 4000 })
  for (const [w, h] of [[0, 600], [800, 0], [20001, 1], [10000, 4001], [0xffffffff, 1], [0x80000000, 1]]) equal(`PNG unsafe dimensions ${w}x${h}`, readRasterDimensions(png(w, h)), null)

  equal('baseline JPEG SOF dimensions', readRasterDimensions(jpeg(sof())), expected)
  equal('progressive JPEG SOF dimensions', readRasterDimensions(jpeg(sof(800, 600, 0xc2))), expected)
  equal('JPEG EXIF thumbnail dimensions never replace the outer image', readRasterDimensions(jpeg(segment(0xe1, join(ascii('Exif\0\0'), jpeg(sof(64, 48)))), sof())), expected)
  equal('JPEG marker fill bytes are accepted outside segments', readRasterDimensions(jpeg(join(new Uint8Array([255]), sof()))), expected)
  const sos = segment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0]))
  equal('JPEG ignores marker-shaped entropy after first scan starts', readRasterDimensions(jpeg(sof(), sos, sof(20001, 1))), expected)
  equal('JPEG cannot search past entropy for a missing SOF', readRasterDimensions(jpeg(sos, sof())), null)
  equal('JPEG containing only EXIF thumbnail has no outer dimensions', readRasterDimensions(jpeg(segment(0xe1, jpeg(sof())))), null)
  equal('JPEG EOI without SOF is refused', readRasterDimensions(jpeg(segment(0xfe, ascii('empty')))), null)
  equal('JPEG unsupported lossless SOF is refused', readRasterDimensions(jpeg(sof(800, 600, 0xc3))), null)
  equal('JPEG duplicate outer SOF is refused', readRasterDimensions(jpeg(sof(), sof())), null)
  equal('JPEG oversized outer image is refused', readRasterDimensions(jpeg(sof(20001, 1))), null)
  equal('JPEG zero height requiring later DNL is refused', readRasterDimensions(jpeg(sof(800, 0))), null)
  const tooLong = sof(); new DataView(tooLong.buffer).setUint16(2, 65535)
  equal('JPEG declared segment exceeding file is refused', readRasterDimensions(jpeg(tooLong)), null)
  const tooShort = sof(); new DataView(tooShort.buffer).setUint16(2, 1)
  equal('JPEG invalid segment length cannot loop or cross bounds', readRasterDimensions(jpeg(tooShort)), null)
  const badComponents = sof(); badComponents[9] = 4
  equal('JPEG component count must match SOF segment length', readRasterDimensions(jpeg(badComponents)), null)
  equal('JPEG truncated trailing marker is refused', readRasterDimensions(join(jpeg(sof()).subarray(0, -2), new Uint8Array([255]))), null)

  equal('WebP VP8L dimensions and odd chunk padding', readRasterDimensions(webp(vp8l())), expected)
  equal('WebP VP8 keyframe dimensions', readRasterDimensions(webp(vp8())), expected)
  equal('WebP VP8X canvas agrees with lossless frame', readRasterDimensions(webp(vp8x(), vp8l())), expected)
  equal('WebP VP8X canvas agrees with lossy frame and metadata', readRasterDimensions(webp(vp8x(), vp8(), chunk('EXIF', ascii('metadata')))), expected)
  equal('WebP partial RIFF header is refused', readRasterDimensions(ascii('RIFF1234WEB')), null)
  equal('WebP extended header without image data is refused', readRasterDimensions(webp(vp8x())), null)
  equal('WebP VP8X animation flag is refused', readRasterDimensions(webp(vp8x(800, 600, 2), vp8l())), null)
  for (const kind of ['ANIM', 'ANMF']) equal(`WebP ${kind} anywhere is refused despite cleared flags`, readRasterDimensions(webp(vp8x(), vp8l(), chunk(kind, new Uint8Array(6)))), null)
  equal('WebP reserved VP8X flag is refused', readRasterDimensions(webp(vp8x(800, 600, 0x80), vp8l())), null)
  equal('WebP small canvas cannot hide a larger frame', readRasterDimensions(webp(vp8x(400, 300), vp8l())), null)
  equal('WebP duplicate compressed frames are refused', readRasterDimensions(webp(vp8(), vp8l())), null)
  equal('WebP extended header after image is refused', readRasterDimensions(webp(vp8(), vp8x())), null)
  const badRiff = webp(vp8()); new DataView(badRiff.buffer).setUint32(4, 0xffffffff, true)
  equal('WebP unsigned overflowing RIFF length is refused', readRasterDimensions(badRiff), null)
  const badChunk = vp8(); new DataView(badChunk.buffer).setUint32(4, 0xffffffff, true)
  equal('WebP overflowing chunk length is refused', readRasterDimensions(webp(badChunk)), null)
  const noPadding = vp8l(); noPadding[noPadding.length - 1] = 1
  equal('WebP odd chunk padding must be present and zero', readRasterDimensions(webp(noPadding)), null)
  const badLossless = vp8l(); badLossless[8] = 0
  equal('WebP VP8L signature is required', readRasterDimensions(webp(badLossless)), null)
  const badVersion = vp8l(); badVersion[12] |= 0x20
  equal('WebP unsupported VP8L version is refused', readRasterDimensions(webp(badVersion)), null)
  const badLossy = vp8(); badLossy[11] = 0
  equal('WebP VP8 start code is required', readRasterDimensions(webp(badLossy)), null)
  const interFrame = vp8(); interFrame[8] |= 1
  equal('WebP VP8 interframe is refused', readRasterDimensions(webp(interFrame)), null)
  equal('WebP truncated VP8 frame header is refused', readRasterDimensions(webp(chunk('VP8 ', new Uint8Array(9)))), null)
  equal('WebP frame exceeding pixel cap is refused', readRasterDimensions(webp(vp8l(10000, 4001))), null)
  const mismatch = webp(vp8()); mismatch.set(ascii('WAVE'), 8)
  equal('Other RIFF formats cannot masquerade as WebP', readRasterDimensions(mismatch), null)
  equal('Unsupported GIF format is refused', readRasterDimensions(ascii('GIF89a0123456789')), null)
  equal('Oversized file input is refused before reading dimensions', readRasterDimensions(new Uint8Array(MAX_RASTER_BYTES + 1)), null)
}
