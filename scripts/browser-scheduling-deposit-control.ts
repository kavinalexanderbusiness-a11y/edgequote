// Isolated browser test of the real fields, React Hook Form, save helper and
// scheduling gate. All HTTP requests are fulfilled locally or blocked. No app
// server, account, credentials or database are used. Requires Playwright;
// PLAYWRIGHT_MODULE_PATH / TEST_BROWSER_PATH may point to an installed runtime.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

type TestRoute = {
  request(): { url(): string }
  fulfill(options: { contentType: string; body: string }): Promise<void>
  abort(): Promise<void>
}

async function main() {
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
  const bundle = await build({
    stdin: {
      sourcefile: 'deposit-control-fixture.tsx', loader: 'tsx', resolveDir: process.cwd(),
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { useForm } from 'react-hook-form';
        import { SchedulingDepositFields, useSchedulingDepositToggle } from './src/components/quotes/SchedulingDepositFields';
        import { Collapsible } from './src/components/ui/Collapsible';
        import { depositRuleFromForm, schedulingGate, gateBlocksScheduling } from './src/lib/payments/depositGate';
        function Fixture() {
          const saved = JSON.parse(localStorage.getItem('test-deposit') || 'null');
          const { register, setValue, watch, reset, handleSubmit } = useForm({defaultValues: {
            deposit_type: saved?.deposit_type ?? '', deposit_value: saved?.deposit_value ?? ''
          }});
          const type = watch('deposit_type'), value = watch('deposit_value');
          const toggle = useSchedulingDepositToggle(type, value, setValue);
          const [result, setResult] = React.useState('');
          return <form onSubmit={handleSubmit(values => {
            const write = depositRuleFromForm(values.deposit_type, values.deposit_value);
            if (!write.ok) { setResult(write.error); return; }
            localStorage.setItem('test-deposit', JSON.stringify(write.patch));
            const quote = {status:'accepted', total:595, accepted_price:595, ...write.patch};
            const gate = schedulingGate(quote, []);
            setResult(JSON.stringify({ ...write.patch, required:gate.required, blocks:gateBlocksScheduling(quote,gate) }));
          })}>
            <Collapsible title="More options" defaultOpen>
              <SchedulingDepositFields depositType={type} depositValue={value} register={register} setValue={setValue} onEnabledChange={toggle} />
            </Collapsible>
            <button type="submit">Save test data</button>
            <button type="button" onClick={() => reset({deposit_type:'fixed',deposit_value:212.50})}>Load fixed test data</button>
            <output aria-label="Saved test data">{result}</output>
          </form>
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `,
    },
    bundle: true, write: false, platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
  })
  const html = `<html lang="en"><head><title>Local deposit test</title></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: process.env.TEST_BROWSER_PATH || undefined })
  let checks = 0
  const check = (name: string) => { checks++; console.log(`  ✓ ${name}`) }
  try {
    const context = await browser.newContext()
    await context.route('**/*', (route: TestRoute) => route.request().url() === 'http://deposit.test/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort())
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error: Error) => pageErrors.push(String(error)))
    await page.goto('http://deposit.test/')
    const toggle = page.getByRole('switch', { name: 'Require a scheduling deposit', exact: true })
    const save = page.getByRole('button', { name: 'Save test data' })
    const output = page.getByLabel('Saved test data')
    const snapshot = async () => {
      await save.click()
      await page.waitForFunction(() => !!document.querySelector('output')?.textContent)
      return JSON.parse(await output.textContent())
    }
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    assert.equal(await page.getByLabel('Deposit as').count(), 0)
    assert.match(await toggle.getAttribute('aria-describedby'), /.+/)
    check('Off has a stable action name, false switch state and linked status')
    await toggle.focus()
    await page.keyboard.press('Space')
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    assert.equal(await page.getByLabel('Deposit as').inputValue(), 'percent')
    assert.equal(await page.getByLabel('Percent', { exact: true }).inputValue(), '50')
    assert.deepEqual(await snapshot(), {deposit_type:'percent', deposit_value:50, required:297.5, blocks:true})
    check('Keyboard enable defaults to 50%, saves $297.50 requirement and blocks unpaid booking')
    await page.reload()
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    assert.equal(await page.getByLabel('Percent', { exact: true }).inputValue(), '50')
    check('Saved percentage rule reloads enabled with the same amount')
    await page.getByLabel('Deposit as').selectOption('fixed')
    await page.getByLabel('Amount ($)', { exact: true }).fill('212.50')
    assert.equal(await page.getByLabel('Amount ($)', { exact: true }).evaluate((input: HTMLInputElement) => input.checkValidity()), true)
    assert.deepEqual(await snapshot(), {deposit_type:'fixed', deposit_value:212.5, required:212.5, blocks:true})
    check('Fixed cents amount is valid and saves with dollar semantics')
    await toggle.click()
    const more = page.getByRole('button', {name:'More options', exact:true})
    await more.click()
    await more.click()
    await toggle.click()
    assert.equal(await page.getByLabel('Deposit as').inputValue(), 'fixed')
    assert.equal(await page.getByLabel('Amount ($)', { exact: true }).inputValue(), '212.50')
    check('Fixed unit and amount survive off/on and closing/reopening More options')
    await page.reload()
    assert.equal(await page.getByLabel('Deposit as').inputValue(), 'fixed')
    assert.equal(Number(await page.getByLabel('Amount ($)', { exact: true }).inputValue()), 212.5)
    check('Saved fixed rule reloads without becoming a percentage')
    await toggle.click()
    assert.deepEqual(await snapshot(), {deposit_type:null, deposit_value:null, required:0, blocks:false})
    await page.reload()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    check('Explicitly disabled rule saves null/null and reloads off')
    await page.getByRole('button', {name:'Load fixed test data'}).click()
    await toggle.click()
    await toggle.click()
    assert.equal(await page.getByLabel('Deposit as').inputValue(), 'fixed')
    check('Restored form values update the remembered unit')
    await page.getByLabel('Deposit as').selectOption('percent')
    await page.getByLabel('Percent', {exact:true}).fill('33.33')
    assert.equal(await page.getByLabel('Percent', {exact:true}).evaluate((input: HTMLInputElement) => input.checkValidity()), true)
    await toggle.click()
    await toggle.click()
    assert.equal(await page.getByLabel('Percent', {exact:true}).inputValue(), '33.33')
    assert.deepEqual(await snapshot(), {deposit_type:'percent', deposit_value:33.33, required:198.31, blocks:true})
    check('Fractional percentage survives off/on and saves with correct cents rounding')
    await page.getByLabel('Percent', {exact:true}).fill('101')
    assert.equal(await page.getByLabel('Percent', {exact:true}).evaluate((input: HTMLInputElement) => input.checkValidity()), false)
    check('Percentage above 100 remains invalid')
    assert.deepEqual(pageErrors, [])
    check('No browser runtime errors')
    console.log(`\n${checks} browser checks passed; all requests stayed inside the test fixture.`)
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
