import { M_TO_FT } from '@/lib/measure/geometry'

export const MAX_SCAN_SIDE = 1600
export const MAX_SCAN_PIXELS = MAX_SCAN_SIDE * MAX_SCAN_SIDE

export type ScanPoint = { x: number; y: number }
export type ScanBounds = ScanPoint & { width: number; height: number }
export type ScanImage = { width: number; height: number; data: Uint8Array | Uint8ClampedArray }
export type SurfaceMask = { mask: Uint8Array; pixelCount: number }
export type SurfaceRegion = SurfaceMask & { touchesBoundary: boolean }

function dimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_SCAN_SIDE
}

/** Connected colour selection, not semantic recognition. Tolerance is the RGB
 * root-mean-square difference from the original seed, on a 0–255 scale. */
export function growSurfaceRegion(image: ScanImage, seed: ScanPoint, roi: ScanBounds, tolerance: number): SurfaceRegion | null {
  if (!image || !dimension(image.width) || !dimension(image.height)
    || !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
    || image.data.length !== image.width * image.height * 4
    || !roi || !Number.isInteger(roi.x) || !Number.isInteger(roi.y)
    || roi.x < 0 || roi.y < 0 || !dimension(roi.width) || !dimension(roi.height)
    || roi.x + roi.width > image.width || roi.y + roi.height > image.height
    || !seed || !Number.isInteger(seed.x) || !Number.isInteger(seed.y)
    || seed.x < roi.x || seed.y < roi.y || seed.x >= roi.x + roi.width || seed.y >= roi.y + roi.height
    || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 255) return null

  const seedIndex = seed.y * image.width + seed.x
  const offset = seedIndex * 4
  if (image.data[offset + 3] === 0) return null
  const red = image.data[offset], green = image.data[offset + 1], blue = image.data[offset + 2]
  const threshold = 3 * tolerance * tolerance
  // Every pixel is visited at most once. Queue capacity is bounded by the ROI;
  // mask value 2 is a temporary rejected marker and is removed before return.
  const mask = new Uint8Array(image.width * image.height)
  const queue = new Uint32Array(roi.width * roi.height)
  let head = 0, tail = 1, pixelCount = 1, touchesBoundary = false
  mask[seedIndex] = 1
  queue[0] = seedIndex
  const right = roi.x + roi.width - 1, bottom = roi.y + roi.height - 1
  const visit = (index: number) => {
    if (mask[index] !== 0) return
    const i = index * 4
    const dr = image.data[i] - red, dg = image.data[i + 1] - green, db = image.data[i + 2] - blue
    if (image.data[i + 3] === 0 || dr * dr + dg * dg + db * db > threshold) {
      mask[index] = 2
      return
    }
    mask[index] = 1
    queue[tail++] = index
    pixelCount++
  }
  while (head < tail) {
    const index = queue[head++]
    const x = index % image.width, y = Math.floor(index / image.width)
    if (x === roi.x || x === right || y === roi.y || y === bottom) touchesBoundary = true
    if (x > roi.x) visit(index - 1)
    if (x < right) visit(index + 1)
    if (y > roi.y) visit(index - image.width)
    if (y < bottom) visit(index + image.width)
  }
  for (let i = 0; i < mask.length; i++) if (mask[i] === 2) mask[i] = 0
  return { mask, pixelCount, touchesBoundary }
}

/** Union or remove selected pixels without double counting or changing inputs. */
export function combineSurfaceMasks(base: Uint8Array, overlay: Uint8Array, operation: 'add' | 'subtract'): SurfaceMask | null {
  if (!(base instanceof Uint8Array) || !(overlay instanceof Uint8Array)
    || base.length === 0 || base.length > MAX_SCAN_PIXELS || base.length !== overlay.length
    || (operation !== 'add' && operation !== 'subtract')) return null
  const mask = new Uint8Array(base.length)
  let pixelCount = 0
  for (let i = 0; i < base.length; i++) {
    if (base[i] > 1 || overlay[i] > 1) return null
    const selected = operation === 'add' ? base[i] === 1 || overlay[i] === 1 : base[i] === 1 && overlay[i] === 0
    if (selected) { mask[i] = 1; pixelCount++ }
  }
  return { mask, pixelCount }
}

/** Pixel area calibrated by a user-supplied real-world distance. This assumes a
 * uniform overhead image scale; it does not correct perspective or prove scale. */
export function scaledSurfaceArea(pixelCount: number, start: ScanPoint, end: ScanPoint, knownDistance: number, unit: 'ft' | 'm'): number | null {
  const pointValid = (point: ScanPoint) => !!point && [point.x, point.y].every(n => Number.isFinite(n) && n >= 0 && n <= MAX_SCAN_SIDE)
  if (!Number.isInteger(pixelCount) || pixelCount <= 0 || pixelCount > MAX_SCAN_PIXELS
    || !pointValid(start) || !pointValid(end) || !Number.isFinite(knownDistance) || knownDistance <= 0
    || (unit !== 'ft' && unit !== 'm')) return null
  const pixelDistance = Math.hypot(end.x - start.x, end.y - start.y)
  if (!Number.isFinite(pixelDistance) || pixelDistance <= 0) return null
  const feetPerPixel = knownDistance * (unit === 'm' ? M_TO_FT : 1) / pixelDistance
  const sqft = pixelCount * feetPerPixel * feetPerPixel
  return Number.isFinite(sqft) && sqft > 0 && sqft <= 100_000_000 ? sqft : null
}
