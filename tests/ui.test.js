/* Drives index.html in Chromium: once against the serverless proxy (PIN mode),
   once against a plain static host with no server (direct Apps Script mode). */
const { chromium, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXEC = 'https://script.google.com/macros/s/MOCKMOCKMOCK/exec';
const PIN = '4821';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const CONFIG = {
  ok: true, timezone: 'Asia/Manila', today: '2026-09-05', spreadsheetName: 'GCash Tracker',
  sheets: ['Aug 2026', 'Sep 2026'], activeSheet: 'Sep 2026', rowsUsed: 4,
  balances: { cash: 21830, emoney: -44720 },
  types: ['Cash In', 'Cash Out', 'Fund In', 'Load', 'Expense'],
  customers: ['Josh', 'Iresh', 'Mariel', 'Gomer', 'Danica', 'Arjie', 'Maris'],
  rateCard: [{ min: 1, max: 100, fee: 5 }, { min: 101, max: 500, fee: 10 }, { min: 501, max: 1000, fee: 15 }]
};
const APPENDED = { ok: true, sheet: 'Sep 2026', row: 10, fee: 10, balances: { cash: 22340, emoney: 44220 } };
const ROWS = [
  { row: 9, date: '2026-09-04', type: 'Cash Out', customer: 'Steph', amount: 1000, fee: 15, notes: 'fee from wallet',
    cashChange: { value: -1000, calculated: false }, emoneyChange: { value: 1015, calculated: false },
    balances: { cash: 20830, emoney: 45735 } },
  { row: 8, date: '2026-09-04', type: 'Cash In', customer: 'Josh', amount: 390, fee: 10, notes: '',
    cashChange: { value: 400, calculated: true }, emoneyChange: { value: -390, calculated: true },
    balances: { cash: 21830, emoney: 44720 } }
];
const UPDATED = { ok: true, sheet: 'Sep 2026', row: 9, fee: 20, changes: { cash: -1200, emoney: 1220 },
  balances: { cash: 20630, emoney: 45940 } };
const DELETED = { ok: true, sheet: 'Sep 2026', row: 9, deleted: true, balances: { cash: 21830, emoney: 44720 } };

process.env.SCRIPT_URL = EXEC;
process.env.SHARED_SECRET = 'apps-script-secret';
process.env.FORM_PIN = PIN;

const upstream = [];
global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  upstream.push(body);
  const reply = { config: CONFIG, list: { ok: true, sheet: 'Sep 2026', rows: ROWS },
    update: UPDATED, delete: DELETED }[body.action] || APPENDED;
  return { text: async () => JSON.stringify(reply) };
};

const handler = require('../api/log.js');
let proxyEnabled = true;
let envBroken = false;

const server = http.createServer((req, res) => {
  if (req.url === '/api/log') {
    if (!proxyEnabled) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html>404</html>'); }
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    return req.on('end', async () => {
      const shim = {
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        status(code) { this.code = code; return this; },
        json(body) {
          res.writeHead(this.code, Object.assign({ 'Content-Type': 'application/json' }, this.headers));
          res.end(JSON.stringify(body));
          return this;
        }
      };
      const saved = process.env.SCRIPT_URL;
      if (envBroken) delete process.env.SCRIPT_URL;
      await handler({ method: req.method, body: raw }, shim);
      if (envBroken) process.env.SCRIPT_URL = saved;
    });
  }
  const file = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : `\n      got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`));
};

(async () => {
  await new Promise(r => server.listen(8099, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext(devices['Pixel 7']);
  const errors = [];
  context.on('weberror', e => errors.push('pageerror: ' + e.error().message));

  /* ---------------------------------------------------- proxy (PIN) mode */
  let page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://localhost:8099/index.html');

  await page.waitForSelector('#setupPin:not([hidden])');
  check('no PIN yet → PIN screen, not a URL box', await page.isVisible('#setupDirect'), false);
  check('PIN screen is bare: no placeholder, no help text, no escape hatch', [
    await page.getAttribute('#setupPinInput', 'placeholder'),
    (await page.textContent('#setupHelp')).trim(),
    await page.locator('#setupToggle').count()
  ], [null, '', 0]);

  await page.fill('#setupPinInput', '9999');
  await page.click('#setupSave');
  await page.waitForFunction(() => document.getElementById('toast').className.includes('err'));
  check('wrong PIN refused', (await page.textContent('#toast')).includes('PIN was not accepted'), true);
  check('wrong PIN not saved', await page.evaluate(() => localStorage.getItem('gcashForm.settings')), null);

  await page.fill('#setupPinInput', PIN);
  await page.click('#setupSave');
  await page.waitForSelector('#app:not([hidden])');
  check('balances rendered after connecting', await page.textContent('#balCash'), '₱21,830');
  check('script URL never reaches the browser', await page.evaluate(() => document.documentElement.outerHTML.includes('script.google.com/macros/s/MOCK')), false);
  check('only the PIN is stored on the phone', await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('gcashForm.settings'));
    return [s.mode, s.pin, s.url, s.secret];
  }), ['proxy', PIN, '', '']);

  // Cash In: the suggestion assumes the fee lands in the till.
  await page.fill('#amount', '500');
  check('changes are suggested from type and amount', [
    await page.getAttribute('#cashSign', 'data-sign'), await page.inputValue('#cashChange'),
    await page.getAttribute('#emoneySign', 'data-sign'), await page.inputValue('#emoneyChange')
  ], ['+', '510', '-', '500']);
  check('preview shows what will be written', (await page.textContent('#preview')).includes('cash +₱510'), true);

  await page.click('#typeSeg button:nth-child(2)'); // Cash Out
  check('switching type re-suggests', [await page.inputValue('#cashChange'), await page.inputValue('#emoneyChange')], ['490', '500']);
  await page.click('#typeSeg button:nth-child(1)'); // back to Cash In

  // The fee came out of the wallet on this one, so both sides get retyped.
  await page.fill('#cashChange', '500');
  await page.fill('#emoneyChange', '490');
  await page.click('#emoneySign');
  check('sign toggle flips the field', await page.getAttribute('#emoneySign', 'data-sign'), '+');
  await page.fill('#amount', '500');
  check('a typed change is not overwritten by the suggestion',
    [await page.inputValue('#cashChange'), await page.inputValue('#emoneyChange')], ['500', '490']);
  await page.click('#autoChanges');
  check('Recalculate restores the suggestion',
    [await page.inputValue('#cashChange'), await page.inputValue('#emoneyChange')], ['510', '500']);

  await page.fill('#cashChange', '500');
  await page.fill('#emoneyChange', '490');
  await page.click('#emoneySign');
  await page.click('#customerChips .chip >> nth=1');
  await page.click('#submit');
  await page.waitForFunction(() => document.getElementById('toast').className.includes('ok'));
  const sent = upstream.find(p => p.action === 'append');
  check('record forwarded with the server-side secret', [sent.type, sent.amount, sent.customer, sent.token],
    ['Cash In', 500, 'Iresh', 'apps-script-secret']);
  check('hand-typed changes are what get sent', [sent.cashChange, sent.emoneyChange], [500, 490]);
  check('PIN stripped before Apps Script', sent.pin, undefined);
  check('success toast names the row', (await page.textContent('#toast')).includes('Saved to Sep 2026 row 10'), true);

  await page.click('#openSettings');
  check('settings show the PIN, not the URL', [await page.isVisible('#cfgPinField'), await page.isVisible('#cfgDirectFields')], [true, false]);
  await page.click('#closeSettings');

  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  check('reload goes straight to the form', await page.isVisible('#setup'), false);
  await page.close();

  /* -------------------------------------------------- edit and delete */
  page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://localhost:8099/index.html');
  await page.waitForSelector('#app:not([hidden])');

  await page.click('#openRecent');
  await page.waitForSelector('#recentList .entry');
  check('recent list shows the rows', await page.locator('#recentList .entry').count(), 2);
  const first = (await page.textContent('#recentList .entry >> nth=0'));
  check('an entry names the record',
    ['Cash Out', 'Steph', '2026-09-04', 'row 9', 'fee from wallet', '₱1,000', 'fee ₱15'].every(bit => first.includes(bit)),
    true);

  await page.click('#recentList .entry >> nth=0');
  await page.waitForSelector('#editBanner:not([hidden])');
  check('the record loads into the form', [
    await page.inputValue('#amount'), await page.inputValue('#customer'),
    await page.inputValue('#date'), await page.inputValue('#notes'),
    await page.locator('#typeSeg button[aria-pressed="true"]').textContent()
  ], ['1000', 'Steph', '2026-09-04', 'fee from wallet', 'Cash Out']);
  check('typed-in changes load with their signs', [
    await page.getAttribute('#cashSign', 'data-sign'), await page.inputValue('#cashChange'),
    await page.getAttribute('#emoneySign', 'data-sign'), await page.inputValue('#emoneyChange')
  ], ['-', '1000', '+', '1015']);
  check('the button becomes Save changes', await page.textContent('#submit'), 'Save changes');
  check('the banner names the row', await page.textContent('#editRowLabel'), 'Sep 2026 row 9');

  await page.fill('#amount', '1200');
  await page.click('#submit');
  await page.waitForFunction(() => document.getElementById('toast').className.includes('ok'));
  const edit = upstream.filter(p => p.action === 'update').pop();
  check('an edit is sent as an update on that row', [edit.action, edit.row, edit.amount], ['update', 9, 1200]);
  check('the edit carries what the row held when it was opened', edit.expect, { date: '2026-09-04', amount: 1000 });
  check('the toast says updated', (await page.textContent('#toast')).includes('Updated Sep 2026 row 9'), true);
  check('the form returns to adding', [await page.textContent('#submit'), await page.isVisible('#editBanner')],
    ['Add record', false]);

  // A row the sheet still calculates must stay calculated unless it is typed in.
  await page.click('#openRecent');
  await page.waitForSelector('#recentList .entry');
  await page.click('#recentList .entry >> nth=1');
  await page.waitForSelector('#editBanner:not([hidden])');
  check('calculated cells load blank, showing their value behind the cursor', [
    await page.inputValue('#cashChange'), await page.getAttribute('#cashChange', 'placeholder')
  ], ['', '400']);
  await page.fill('#customer', 'Joshua');
  await page.click('#submit');
  await page.waitForFunction(() => document.getElementById('toast').className.includes('ok'));
  const keep = upstream.filter(p => p.action === 'update').pop();
  check('an untouched calculated cell is not frozen into a number',
    [keep.cashChange, keep.emoneyChange, keep.customer], [null, null, 'Joshua']);

  // Delete, with the confirm accepted.
  await page.click('#openRecent');
  await page.waitForSelector('#recentList .entry');
  await page.click('#recentList .entry >> nth=0');
  await page.waitForSelector('#editBanner:not([hidden])');
  page.once('dialog', d => d.accept());
  await page.click('#deleteRecord');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Deleted'));
  const removal = upstream.filter(p => p.action === 'delete').pop();
  check('delete targets the row with its guard', [removal.row, removal.expect.amount], [9, 1000]);
  check('editing ends after a delete', await page.isVisible('#editBanner'), false);

  // Cancelling the confirm must not send anything.
  const deletesSoFar = upstream.filter(p => p.action === 'delete').length;
  await page.click('#openRecent');
  await page.waitForSelector('#recentList .entry');
  await page.click('#recentList .entry >> nth=0');
  page.once('dialog', d => d.dismiss());
  await page.click('#deleteRecord');
  check('a dismissed confirm deletes nothing', upstream.filter(p => p.action === 'delete').length, deletesSoFar);
  await page.click('#cancelEdit');
  check('Cancel leaves edit mode', await page.isVisible('#editBanner'), false);
  await page.close();

  /* ------------------------------------- server up, env vars not set yet */
  envBroken = true;
  const misconfigured = await context.newPage();
  misconfigured.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await misconfigured.goto('http://localhost:8099/index.html');
  await misconfigured.evaluate(() => localStorage.clear());
  await misconfigured.reload();
  await misconfigured.waitForFunction(() => document.getElementById('toast').className.includes('err'));
  check('missing env var is reported, not swallowed',
    (await misconfigured.textContent('#toast')).includes('SCRIPT_URL is not set'), true);
  check('and it lands on the PIN screen rather than a dead end', await misconfigured.isVisible('#setupPin'), true);
  await misconfigured.close();
  envBroken = false;

  /* ------------------------------------------- static host (direct) mode */
  proxyEnabled = false;
  const plain = await context.newPage();
  plain.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const posted = [];
  await plain.route(EXEC, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    posted.push(body);
    await route.fulfill({
      status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body.action === 'config' ? CONFIG : APPENDED)
    });
  });

  await plain.goto('http://localhost:8099/index.html');
  await plain.evaluate(() => localStorage.clear());
  await plain.reload();

  await plain.waitForSelector('#setupDirect:not([hidden])');
  check('no server → asks for the Apps Script URL', await plain.isVisible('#setupPin'), false);
  await plain.fill('#setupUrl', 'not-a-url');
  await plain.click('#setupSave');
  check('bad URL rejected', (await plain.textContent('#toast')).includes('/exec URL'), true);

  await plain.fill('#setupUrl', EXEC);
  await plain.fill('#setupSecret', 'apps-script-secret');
  await plain.click('#setupSave');
  await plain.waitForSelector('#app:not([hidden])');
  check('direct mode reaches Apps Script', posted[0].token, 'apps-script-secret');

  await plain.fill('#amount', '250');
  await plain.click('#submit');
  await plain.waitForFunction(() => document.getElementById('toast').className.includes('ok'));
  check('direct mode saves a record', posted.filter(p => p.action === 'append').length, 1);

  await plain.click('#openSettings');
  check('settings show the URL in direct mode', [await plain.isVisible('#cfgDirectFields'), await plain.isVisible('#cfgPinField')], [true, false]);
  await plain.click('#closeSettings');
  await plain.screenshot({ path: path.join(__dirname, 'form.png'), fullPage: true });

  // 401s (no PIN yet, wrong PIN) and 404s (the deliberate no-proxy fallback) are
  // statuses this test asks for; anything else is a real fault.
  const expected = /status of (401|404|500)/;
  check('no unexpected page errors', errors.filter(e => !expected.test(e)), []);
  check('only the intended 401s, 404s and 500s were logged', errors.length, 6);
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} failing check(s)` : '\nAll UI checks passed');
  process.exit(failures ? 1 : 0);
})();
