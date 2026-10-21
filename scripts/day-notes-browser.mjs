// Presentation regression and keyboard checks against day-notes-preview output.
// node scripts/day-notes-browser.mjs <preview-dir> [playwright-module-path]
// Uses an isolated headless browser, keeps its sandbox enabled and rejects all
// requests except this script's loopback server. It never reads credentials.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = resolve(process.argv[2] || '../evidence/day-notes-preview')
const modulePath = process.argv[3]
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright')
const evidence = resolve(dir, '..')
mkdirSync(evidence, { recursive: true })
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const target = resolve(dir, pathname === '/' ? 'index.html' : `.${pathname}`)
  if (!target.startsWith(dir + '/')) { res.writeHead(403).end(); return }
  try { res.setHeader('Content-Type', mime[extname(target)] || 'application/octet-stream'); res.end(readFileSync(target)) }
  catch { res.writeHead(404).end() }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })
const results = []
const errors = []

function record(name, value) { results.push({ name, ...value }); console.log(name, JSON.stringify(value)) }
async function metrics(page) {
  return page.evaluate(() => {
    function rgb(value) { return value.match(/[\d.]+/g).slice(0, 3).map(Number) }
    function luminance(color) { return color.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0) }
    function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
    return [...document.querySelectorAll('#day-board-preview [data-job-notes]')].map(el => {
      const text = el.querySelector('p:last-child'), style = getComputedStyle(text), rect = text.getBoundingClientRect()
      let opacity = 1
      for (let p = text; p; p = p.parentElement) opacity *= Number(getComputedStyle(p).opacity)
      return { text: text.textContent, size: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight),
        whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, clamp: style.webkitLineClamp,
        contrast: contrast(rgb(style.color), rgb(getComputedStyle(el).backgroundColor)), opacity,
        width: rect.width, left: rect.left, right: rect.right, scrollWidth: text.scrollWidth, clientWidth: text.clientWidth,
        scrollHeight: text.scrollHeight, clientHeight: text.clientHeight }
    })
  })
}

try {
  for (const theme of ['dark', 'light']) {
    for (const width of [320, 375, 390, 430, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 1024, deviceScaleFactor: 1 })
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
      const page = await context.newPage()
      page.on('pageerror', err => errors.push(err.message))
      await page.goto(origin + '/stress.html')
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
      await page.waitForTimeout(250) // allow existing theme color transitions to settle
      await page.locator('[data-job-notes]').first().waitFor()
      await page.evaluate(() => document.fonts.ready)
      const notes = await metrics(page)
      assert.equal(notes.length, 2, 'both scheduled and completed notes render')
      for (const note of notes) {
        assert(note.size >= 16 && note.lineHeight >= 26, 'readable type size and line spacing')
        assert(note.contrast >= 4.5 && note.opacity === 1, 'unfaded AA note contrast')
        assert.equal(note.whiteSpace, 'pre-wrap')
        assert.equal(note.overflowWrap, 'anywhere')
        assert.equal(note.clamp, 'none')
        assert(note.scrollWidth <= note.clientWidth + 1 && note.scrollHeight <= note.clientHeight + 1, 'no clipped note text')
        assert(note.left >= 0 && note.right <= width + 1, 'note inside viewport width')
      }
      assert(notes[0].text.includes('FINAL ACCESS INSTRUCTION') && notes[0].text.includes('FINAL SCOPE INSTRUCTION'), 'last instructions retained')
      const layout = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }))
      assert(layout.documentWidth <= width + 1, 'day board has no horizontal page overflow')
      record(`${theme}-${width}`, { notes: notes.map(({text,...n}) => n), layout })

      if ([390,1280].includes(width)) {
        await page.screenshot({ path: join(evidence, `day-notes-${theme}-${width}-initial.png`), fullPage: false })
        await page.locator('#stop-notes-preview').scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(evidence, `day-notes-${theme}-${width}-card.png`), fullPage: false })
      }
      if (width < 1024) {
        const toggle = page.getByRole('button', { name: 'Show stop details', exact: true })
        await toggle.waitFor()
        // Enter by Tab from the document, not by invoking click handlers.
        await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0) })
        let found = false
        for (let i = 0; i < 100; i++) {
          await page.keyboard.press('Tab')
          if (await toggle.evaluate(el => el === document.activeElement)) { found = true; break }
        }
        assert(found, 'disclosure reachable with Tab')
        const toggleSize = await toggle.boundingBox()
        assert(toggleSize.height >= 44, '44px disclosure target')
        await page.keyboard.press('Enter')
        const region = page.getByRole('region', { name: 'Stop details', exact: true })
        await region.waitFor()
        assert(await region.evaluate(el => el === document.activeElement), 'focus moves to scrollable details')
        assert.equal(await page.getByRole('button', { name: 'Hide stop details' }).getAttribute('aria-controls'), await region.getAttribute('id'))
        const opened = await region.evaluate(el => {
          const r = el.getBoundingClientRect(), p = el.querySelector('[data-job-notes] p:last-child')
          return { top: r.top, bottom: r.bottom, width: r.width, height: r.height, scrollHeight: el.scrollHeight,
            text: p.textContent, size: parseFloat(getComputedStyle(p).fontSize), whiteSpace: getComputedStyle(p).whiteSpace }
        })
        assert(opened.top >= 0 && opened.bottom <= 900 && opened.height <= 450, 'expanded details constrained to viewport')
        assert(opened.text.includes('FINAL SCOPE INSTRUCTION'), 'full note in expanded mobile surface')
        if (width === 390) await page.screenshot({ path: join(evidence, `day-notes-${theme}-mobile-expanded.png`) })
        await page.keyboard.press('End')
        await page.waitForTimeout(300)
        const scrolled = await region.evaluate(el => ({ scrollTop: el.scrollTop, max: el.scrollHeight - el.clientHeight }))
        assert(scrolled.scrollTop > 0 && Math.abs(scrolled.max - scrolled.scrollTop) <= 1, 'keyboard reaches end of long notes')
        const lastVisible = await region.evaluate(el => {
          const p = el.querySelector('[data-job-notes] p:last-child'), text = p.firstChild
          const range = document.createRange(); range.setStart(text, text.textContent.indexOf('FINAL ACCESS INSTRUCTION')); range.setEnd(text, text.textContent.length)
          const r = range.getBoundingClientRect(), pane = el.getBoundingClientRect()
          return r.top >= pane.top && r.bottom <= pane.bottom
        })
        assert(lastVisible, 'last access and scope instructions visually reachable')
        if (width === 390) await page.screenshot({ path: join(evidence, `day-notes-${theme}-mobile-last-instructions.png`) })
        await page.keyboard.press('Escape')
        await region.waitFor({ state: 'detached' })
        assert(await toggle.evaluate(el => el === document.activeElement), 'Escape returns focus')
        await page.keyboard.press('Space')
        await region.waitFor()
        assert(await region.evaluate(el => el === document.activeElement), 'Space also expands details')
        await page.keyboard.press('Escape')
        record(`${theme}-${width}-keyboard`, { tab: true, enter: true, space: true, escapeReturnsFocus: true, keyboardScrollEnd: true, finalInstructionsVisible: true, targetHeight: toggleSize.height })
      }
      // Browser text enlargement: ensure instructions remain legible and wrap.
      await page.evaluate(() => document.documentElement.style.fontSize = '32px')
      const enlarged = await metrics(page)
      for (const note of enlarged) {
        assert(note.size >= 32, 'text obeys user enlargement')
        assert(note.left >= 0 && note.right <= width + 1 && note.scrollWidth <= note.clientWidth + 1, 'enlarged notes wrap')
      }
      const enlargedIdentity = await page.locator('#stop-notes-preview').getByText('Example customer with a deliberately long display name', { exact: true }).boundingBox()
      assert(enlargedIdentity.width >= 96, 'enlarged customer name must not be squeezed to single letters')
      if (width < 1024) {
        const enlargedToggle = await page.getByRole('button', { name: 'Show stop details', exact: true }).boundingBox()
        assert(enlargedToggle.width >= 44, 'text enlargement preserves disclosure target width')
      }
      record(`${theme}-${width}-200pct`, { notes: enlarged.map(({text,...n}) => n) })
      if (width === 320) {
        await page.locator('#stop-notes-preview').scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(evidence, `day-notes-${theme}-320-200pct.png`) })
      }
      if ([390, 1280].includes(width)) {
        await page.goto(origin)
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
        await page.waitForTimeout(250)
        await page.evaluate(() => document.fonts.ready)
        await page.locator('#stop-notes-preview').scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(evidence, `day-notes-${theme}-${width}-typical.png`) })
        const price = await page.locator('#stop-notes-preview button[title="Edit price"]').evaluate(el => {
          const s = getComputedStyle(el); return { color: s.color, opacity: s.opacity, disabled: el.disabled, text: el.textContent }
        })
        record(`${theme}-${width}-typical`, { price })
      }
      await context.close()
    }
  }
  for (const [width, height, scale] of [[320, 568, 1], [667, 375, 1], [320, 568, 2], [667, 375, 2]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, deviceScaleFactor: 1 })
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const page = await context.newPage()
    await page.goto(origin + '/stress.html')
    await page.evaluate(scale => document.documentElement.style.fontSize = `${16 * scale}px`, scale)
    const toggle = page.getByRole('button', { name: 'Show stop details', exact: true })
    await toggle.focus()
    await page.keyboard.press('Enter')
    const region = page.getByRole('region', { name: 'Stop details' })
    await region.waitFor()
    const bounds = await page.locator('[data-eq-bottom-chrome]').boundingBox()
    assert(bounds.y >= 0 && bounds.y + bounds.height <= height + 1, 'whole expanded bottom bar fits short viewport')
    for (const button of [page.getByRole('button', {name:'Hide stop details'}), page.locator('#field-stop-preview').getByRole('button', {name:'Start', exact:true})]) {
      const b = await button.boundingBox()
      assert(b.x >= 0 && b.x+b.width <= width+1 && b.y >= 0 && b.y+b.height <= height+1, 'primary and disclosure controls stay onscreen')
    }
    await page.keyboard.press('End')
    await page.waitForTimeout(300)
    const measureLast = () => region.evaluate((el, scale) => {
      const p = el.querySelector('[data-job-notes] p:last-child'), t = p.firstChild, range = document.createRange()
      range.setStart(t, scale === 1 ? t.textContent.indexOf('FINAL ACCESS INSTRUCTION') : t.textContent.length - 10); range.setEnd(t, t.textContent.length)
      const r = range.getBoundingClientRect(), b = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, paneTop: b.top, paneBottom: b.bottom, scrollTop: el.scrollTop, max: el.scrollHeight-el.clientHeight }
    }, scale)
    let last = await measureLast()
    for (let attempt = 0; scale === 2 && last.top < last.paneTop && attempt < 30; attempt++) {
      await page.keyboard.press('ArrowUp')
      await page.waitForTimeout(100)
      last = await measureLast()
    }
    assert(last.top >= last.paneTop && last.bottom <= last.paneBottom, 'short viewport final instructions reachable')
    await page.screenshot({ path: join(evidence, `day-notes-short-${width}x${height}-${scale}x.png`) })
    await page.keyboard.press('Escape')
    await region.waitFor({ state:'detached' })
    assert(await toggle.evaluate(el=>el===document.activeElement), 'short viewport Escape restores focus')
    record(`short-${width}x${height}-${scale}x`, { bounds, last, controlsFit:true, escapeReturnsFocus:true })
    await context.close()
  }
  assert.equal(errors.length, 0, 'no JavaScript errors')
  writeFileSync(join(evidence, 'day-notes-browser-results.json'), JSON.stringify({ passed: true, results, errors }, null, 2))
  console.log(`PASS: ${results.length} scenarios; evidence in ${evidence}`)
} catch (error) {
  writeFileSync(join(evidence, 'day-notes-browser-results.json'), JSON.stringify({ passed: false, failure: String(error), results, errors }, null, 2))
  throw error
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
