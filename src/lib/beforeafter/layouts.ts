import { coverCrop } from './imageLoad'

// ── Before/After composition engine ─────────────────────────────────────────
// ONE renderer (renderComposite) draws the whole composite to any 2D context —
// the on-screen preview and the full-resolution export call the exact same code,
// so what you see is what downloads. Everything is sized as a fraction of the
// target W/H, so a 760px preview and a 1920px export are pixel-for-pixel the same
// layout. No server, no `sharp` — the owner's browser does the compositing.

export const BRAND_ACCENT = '#00C896' // EdgeQuote green (matches the app accent)
const BG = '#0b1018'
const INK = '#F2F5FC'
const INK_MUTED = '#9FB0C8'
const BEFORE_BG = 'rgba(245,158,11,0.95)' // amber — app's "before" colour
const AFTER_BG = '#00C896' // accent — app's "after" colour
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

export type LayoutKey = 'auto' | 'side-by-side' | 'stacked' | 'diagonal' | 'slider'

export const LAYOUTS: { key: LayoutKey; label: string; hint: string }[] = [
  { key: 'auto', label: 'Auto', hint: 'Best split for the shape' },
  { key: 'side-by-side', label: 'Side by side', hint: 'Before left · After right' },
  { key: 'stacked', label: 'Stacked', hint: 'Before top · After bottom' },
  { key: 'diagonal', label: 'Diagonal', hint: 'Angled split' },
  { key: 'slider', label: 'Slider', hint: 'Reveal-style divider' },
]

export interface ExportPreset {
  key: string
  label: string
  group: 'Platform' | 'Format'
  w: number
  h: number
  note?: string
}

// Platforms map to the size each one actually wants; Formats are raw shapes. The
// user picks either — both just set the canvas dimensions.
export const EXPORT_PRESETS: ExportPreset[] = [
  { key: 'instagram', label: 'Instagram', group: 'Platform', w: 1080, h: 1350, note: 'Portrait feed' },
  { key: 'instagram-story', label: 'Instagram Story', group: 'Platform', w: 1080, h: 1920, note: 'Full-screen' },
  { key: 'facebook', label: 'Facebook', group: 'Platform', w: 1200, h: 1200, note: 'Feed post' },
  { key: 'gbp', label: 'Google Business', group: 'Platform', w: 1200, h: 900, note: 'Profile photo' },
  { key: 'website', label: 'Website', group: 'Platform', w: 1600, h: 900, note: 'Hero / gallery' },
  { key: 'square', label: 'Square', group: 'Format', w: 1080, h: 1080 },
  { key: 'portrait', label: 'Portrait', group: 'Format', w: 1080, h: 1350 },
  { key: 'landscape', label: 'Landscape', group: 'Format', w: 1920, h: 1080 },
  { key: 'story', label: 'Story', group: 'Format', w: 1080, h: 1920 },
]

// The platform set used by "Download all" — one ready file per channel.
export const PLATFORM_KEYS = ['instagram', 'instagram-story', 'facebook', 'gbp', 'website']

export function presetByKey(key: string): ExportPreset {
  return EXPORT_PRESETS.find(p => p.key === key) || EXPORT_PRESETS[0]
}

export interface Focus { x: number; y: number }

export interface BrandInfo {
  name: string
  phone: string | null
  website: string | null
  logo: HTMLImageElement | null
  accent: string
}

export interface RenderInput {
  before: HTMLImageElement
  after: HTMLImageElement
  width: number
  height: number
  layout: LayoutKey
  showLabels: boolean
  showBranding: boolean
  brand: BrandInfo
  beforeFocus: Focus
  afterFocus: Focus
  // Multiplicative brightness corrections (1 = none) — feed averageLuminance in.
  beforeBrightness: number
  afterBrightness: number
  labelBefore: string
  labelAfter: string
}

// Draw the full composite into ctx at input.width × input.height.
export function renderComposite(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { width: W, height: H } = input
  ctx.save()
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, W, H)

  const footerH = input.showBranding ? clamp(Math.round(H * 0.1), 56, 200) : 0
  const stageW = W
  const stageH = H - footerH

  const layout = resolveLayout(input.layout, stageW, stageH)
  const gap = Math.max(2, Math.round(Math.min(W, H) * 0.006))

  if (layout === 'side-by-side') {
    const cellW = (stageW - gap) / 2
    drawCell(ctx, input.before, 0, 0, cellW, stageH, input.beforeFocus, input.beforeBrightness)
    drawCell(ctx, input.after, cellW + gap, 0, cellW, stageH, input.afterFocus, input.afterBrightness)
    drawDivider(ctx, cellW, 0, gap, stageH, input.brand.accent)
    if (input.showLabels) {
      drawLabel(ctx, 'before', input.labelBefore, pad(W), pad(W), cellW, stageH, W, H)
      drawLabel(ctx, 'after', input.labelAfter, cellW + gap + pad(W), pad(W), cellW, stageH, W, H)
    }
  } else if (layout === 'stacked') {
    const cellH = (stageH - gap) / 2
    drawCell(ctx, input.before, 0, 0, stageW, cellH, input.beforeFocus, input.beforeBrightness)
    drawCell(ctx, input.after, 0, cellH + gap, stageW, cellH, input.afterFocus, input.afterBrightness)
    drawDivider(ctx, 0, cellH, stageW, gap, input.brand.accent)
    if (input.showLabels) {
      drawLabel(ctx, 'before', input.labelBefore, pad(W), pad(W), stageW, cellH, W, H)
      drawLabel(ctx, 'after', input.labelAfter, pad(W), cellH + gap + pad(W), stageW, cellH, W, H)
    }
  } else if (layout === 'diagonal') {
    // before fills the stage; after is clipped into the bottom-right triangle.
    drawCell(ctx, input.before, 0, 0, stageW, stageH, input.beforeFocus, input.beforeBrightness)
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(stageW, 0)
    ctx.lineTo(stageW, stageH)
    ctx.lineTo(0, stageH)
    ctx.closePath()
    ctx.clip()
    drawCell(ctx, input.after, 0, 0, stageW, stageH, input.afterFocus, input.afterBrightness)
    ctx.restore()
    // divider stroke along the diagonal
    ctx.save()
    ctx.strokeStyle = input.brand.accent
    ctx.lineWidth = Math.max(3, Math.round(Math.min(W, H) * 0.01))
    ctx.beginPath()
    ctx.moveTo(stageW, 0)
    ctx.lineTo(0, stageH)
    ctx.stroke()
    ctx.restore()
    if (input.showLabels) {
      drawLabel(ctx, 'before', input.labelBefore, pad(W), pad(W), stageW, stageH, W, H)
      drawLabelAt(ctx, 'after', input.labelAfter, W, H, 'bottom-right', stageW, stageH)
    }
  } else {
    // slider: before fills stage; after reveals from the right past a vertical
    // divider with a round handle — the classic "drag to compare" look, static.
    const split = Math.round(stageW * 0.5)
    drawCell(ctx, input.before, 0, 0, stageW, stageH, input.beforeFocus, input.beforeBrightness)
    ctx.save()
    ctx.beginPath()
    ctx.rect(split, 0, stageW - split, stageH)
    ctx.clip()
    drawCell(ctx, input.after, 0, 0, stageW, stageH, input.afterFocus, input.afterBrightness)
    ctx.restore()
    drawSliderHandle(ctx, split, stageH, W, H, input.brand.accent)
    if (input.showLabels) {
      drawLabelAt(ctx, 'before', input.labelBefore, W, H, 'bottom-left', stageW, stageH)
      drawLabelAt(ctx, 'after', input.labelAfter, W, H, 'bottom-right', stageW, stageH)
    }
  }

  if (input.showBranding) drawBranding(ctx, 0, stageH, W, footerH, input.brand)

  ctx.restore()
}

function resolveLayout(layout: LayoutKey, w: number, h: number): Exclude<LayoutKey, 'auto'> {
  if (layout !== 'auto') return layout
  // Wide → side by side reads best; tall → stacked. Square leans side-by-side.
  return w >= h ? 'side-by-side' : 'stacked'
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number, y: number, w: number, h: number,
  focus: Focus, brightness: number,
): void {
  if (w <= 0 || h <= 0) return
  const crop = coverCrop(img.naturalWidth || img.width, img.naturalHeight || img.height, w, h, focus.x, focus.y)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  if (brightness !== 1 && supportsFilter(ctx)) {
    ctx.filter = `brightness(${brightness.toFixed(3)})`
  }
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, x, y, w, h)
  ctx.restore()
}

function drawDivider(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, accent: string): void {
  ctx.save()
  ctx.fillStyle = accent
  ctx.fillRect(x, y, w, h)
  ctx.restore()
}

function pad(W: number): number {
  return Math.round(W * 0.025)
}

// Label pill anchored to the top-left of a cell box.
function drawLabel(
  ctx: CanvasRenderingContext2D,
  which: 'before' | 'after',
  text: string,
  x: number, y: number,
  _cellW: number, _cellH: number,
  W: number, H: number,
): void {
  drawPill(ctx, which, text, x, y, W, H)
}

// Label pill anchored to a corner of the stage (diagonal / slider).
function drawLabelAt(
  ctx: CanvasRenderingContext2D,
  which: 'before' | 'after',
  text: string,
  W: number, H: number,
  corner: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right',
  stageW: number, stageH: number,
): void {
  const m = pad(W)
  const { w, h } = pillSize(ctx, text, W, H)
  let x = m
  let y = m
  if (corner.includes('right')) x = stageW - w - m
  if (corner.includes('bottom')) y = stageH - h - m
  drawPill(ctx, which, text, x, y, W, H)
}

function pillSize(ctx: CanvasRenderingContext2D, text: string, W: number, H: number): { w: number; h: number; fs: number } {
  const fs = clamp(Math.round(Math.min(W, H) * 0.032), 14, 52)
  ctx.font = `700 ${fs}px ${FONT}`
  const padX = fs * 0.7
  const padY = fs * 0.42
  const tw = ctx.measureText(text.toUpperCase()).width
  return { w: tw + padX * 2, h: fs + padY * 2, fs }
}

function drawPill(ctx: CanvasRenderingContext2D, which: 'before' | 'after', text: string, x: number, y: number, W: number, H: number): void {
  const { w, h, fs } = pillSize(ctx, text, W, H)
  const r = h / 2
  ctx.save()
  ctx.fillStyle = which === 'before' ? BEFORE_BG : AFTER_BG
  roundRect(ctx, x, y, w, h, r)
  ctx.fill()
  ctx.fillStyle = '#0b1018'
  ctx.font = `700 ${fs}px ${FONT}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText(text.toUpperCase(), x + (w - ctx.measureText(text.toUpperCase()).width) / 2, y + h / 2 + fs * 0.04)
  ctx.restore()
}

function drawSliderHandle(ctx: CanvasRenderingContext2D, splitX: number, stageH: number, W: number, H: number, accent: string): void {
  ctx.save()
  const lineW = Math.max(3, Math.round(Math.min(W, H) * 0.008))
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(splitX - lineW / 2, 0, lineW, stageH)
  // round handle
  const r = clamp(Math.round(Math.min(W, H) * 0.045), 18, 70)
  const cy = stageH / 2
  ctx.beginPath()
  ctx.arc(splitX, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = accent
  ctx.lineWidth = Math.max(2, r * 0.12)
  ctx.stroke()
  // arrows
  ctx.fillStyle = accent
  const a = r * 0.4
  ctx.beginPath()
  ctx.moveTo(splitX - a * 0.5, cy)
  ctx.lineTo(splitX - a * 1.2, cy - a * 0.6)
  ctx.lineTo(splitX - a * 1.2, cy + a * 0.6)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(splitX + a * 0.5, cy)
  ctx.lineTo(splitX + a * 1.2, cy - a * 0.6)
  ctx.lineTo(splitX + a * 1.2, cy + a * 0.6)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function drawBranding(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, brand: BrandInfo): void {
  ctx.save()
  // bar
  ctx.fillStyle = '#0b1018'
  ctx.fillRect(x, y, w, h)
  // accent top edge
  ctx.fillStyle = brand.accent
  ctx.fillRect(x, y, w, Math.max(2, Math.round(h * 0.05)))

  const m = Math.round(h * 0.24)
  let cursorX = x + m

  // logo (contain within left)
  if (brand.logo && (brand.logo.naturalWidth || brand.logo.width)) {
    const lh = h - m * 1.4
    const ratio = (brand.logo.naturalWidth || brand.logo.width) / (brand.logo.naturalHeight || brand.logo.height)
    const lw = Math.min(lh * ratio, w * 0.4)
    ctx.drawImage(brand.logo, cursorX, y + (h - lh) / 2, lw, lh)
    cursorX += lw + m * 0.8
  }

  // company name + contact
  const nameFs = clamp(Math.round(h * 0.34), 14, 60)
  ctx.fillStyle = INK
  ctx.font = `700 ${nameFs}px ${FONT}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const contact = [brand.phone, brand.website].filter(Boolean).join('   ·   ')
  if (contact) {
    ctx.fillText(brand.name, cursorX, y + h * 0.4)
    const subFs = clamp(Math.round(h * 0.22), 11, 40)
    ctx.font = `500 ${subFs}px ${FONT}`
    ctx.fillStyle = INK_MUTED
    ctx.fillText(contact, cursorX, y + h * 0.72)
  } else {
    ctx.fillText(brand.name, cursorX, y + h / 2)
  }
  ctx.restore()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

let _filterSupport: boolean | null = null
function supportsFilter(ctx: CanvasRenderingContext2D): boolean {
  if (_filterSupport != null) return _filterSupport
  _filterSupport = typeof (ctx as unknown as { filter?: string }).filter === 'string'
  return _filterSupport
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// Brightness multiplier that nudges a photo's average luminance toward a shared
// target, gently (capped) so a balanced pair never looks blown out or muddy.
export function balanceFactor(lum: number, target = 0.52): number {
  if (lum <= 0.001) return 1
  return clamp(target / lum, 0.78, 1.28)
}
