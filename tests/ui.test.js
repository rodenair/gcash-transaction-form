/* Drives index.html in Chromium against a mocked Apps Script endpoint. */
const { chromium, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXEC = 'https://script.google.com/macros/s/MOCKMOCKMOCK/exec';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(r => server.listen(8099, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext(devices['Pixel 7']);
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  context.on('response', r => { if (r.status() === 404) errors.push('404: ' + r.url()); });
  context.on('requestfailed', r => errors.push('failed: ' + r.url()));

  const posted = [];
  let failNext = false;
  await context.route(EXEC, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    posted.push(body);
    if (failNext) return route.abort('failed');
    const payload = body.action === 'config'
      ? {
          ok: true, timezone: 'Asia/Manila', today: '2026-09-05', spreadsheetName: 'GCash Tracker',
          sheets: ['Aug 2026', 'Sep 2026'], activeSheet: 'Sep 2026', rowsUsed: 4,
          balances: { cash: 21830, emoney: -44720 },
          types: ['Cash In', 'Cash Out', 'Fund In', 'Load', 'Expense'],
          customers: ['Josh', 'Iresh', 'Mariel', 'Gomer', 'Danica', 'Arjie', 'Maris'],
          rateCard: [{ min: 1, max: 100, fee: 5 }, { min: 101, max: 500, fee: 10 }, { min: 501, max: 1000, fee: 15 }]
        }
      : { ok: true, sheet: 'Sep 2026', row: 10, fee: 10, balances: { cash: 22340, emoney: 44220 } };
    await route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(payload) });
  });

  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : `\n      got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`));
  };

  // --- setup screen ---
  await page.goto('http://localhost:8099/index.html');
  check('setup screen shown first', await page.isVisible('#setup'), true);
  await page.fill('#setupUrl', 'not-a-url');
  await page.click('#setupSave');
  check('bad URL rejected', (await page.textContent('#toast')).includes('/exec URL'), true);

  await page.fill('#setupUrl', EXEC);
  await page.fill('#setupSecret', 's3cret');
  await page.click('#setupSave');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForFunction(() => document.getElementById('balCash').textContent !== '—');

  check('config request sent with token', [posted[0].action, posted[0].token], ['config', 's3cret']);
  check('cash balance rendered', await page.textContent('#balCash'), '₱21,830');
  check('negative balance styled', await page.getAttribute('#balEmoney', 'class'), 'value neg');
  check('sheet line', await page.textContent('#sheetLine'), 'Sep 2026 · 4 rows');
  check('type buttons rendered', await page.locator('#typeSeg button').count(), 5);
  check('customer chips capped at 6', await page.locator('#customerChips .chip').count(), 6);
  check('date defaults to today', await page.inputValue('#date'), new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10));

  // --- validation ---
  await page.click('#submit');
  check('empty amount blocked', (await page.textContent('#toast')).includes('Enter an amount'), true);

  // --- fee preview ---
  await page.fill('#amount', '500');
  check('fee preview from rate card', (await page.textContent('#preview')).includes('fee ₱10'), true);
  await page.click('#typeSeg button:nth-child(3)'); // Fund In
  check('fund in has no fee', (await page.textContent('#preview')).includes('no fee'), true);
  await page.fill('#amount', '20000');
  await page.click('#typeSeg button:nth-child(1)'); // Cash In
  check('above the top bracket uses 2% − ₱10', (await page.textContent('#preview')).includes('fee ₱390'), true);

  // --- successful submit ---
  await page.fill('#amount', '500');
  await page.click('#customerChips .chip >> nth=1');
  check('chip fills the customer', await page.inputValue('#customer'), 'Iresh');
  await page.fill('#notes', 'from the phone');
  await page.click('#submit');
  await page.waitForFunction(() => document.getElementById('toast').className.includes('ok'));
  const sent = posted.find(p => p.action === 'append');
  check('record payload', [sent.type, sent.amount, sent.customer, sent.notes, sent.sheet],
    ['Cash In', 500, 'Iresh', 'from the phone', '']);
  check('clientId present for retry-safety', typeof sent.clientId === 'string' && sent.clientId.length > 5, true);
  check('success toast names sheet and row', (await page.textContent('#toast')).includes('Saved to Sep 2026 row 10'), true);
  check('form cleared after save', [await page.inputValue('#amount'), await page.inputValue('#customer'), await page.inputValue('#notes')], ['', '', '']);

  // --- offline queue ---
  failNext = true;
  await page.fill('#amount', '250');
  await page.click('#submit');
  await page.waitForSelector('#queueCard:not([hidden])');
  check('failed submit is queued', await page.textContent('#queueCount'), '1');
  check('queue survives reload', await page.evaluate(() => JSON.parse(localStorage.getItem('gcashForm.queue')).length), 1);

  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  check('reload skips setup once connected', await page.isVisible('#setup'), false);

  failNext = false;
  await page.click('#queueRetry');
  await page.waitForSelector('#queueCard', { state: 'hidden', timeout: 8000 });
  check('queued record sent on retry', posted.filter(p => p.amount === 250).length >= 1, true);

  // --- settings ---
  await page.click('#openSettings');
  await page.selectOption('#cfgSheet', 'Aug 2026');
  await page.click('#cfgSave');
  await page.waitForSelector('#app:not([hidden])');
  await page.fill('#amount', '100');
  await page.click('#submit');
  await page.waitForFunction(() => document.getElementById('toast').className.includes('ok'));
  check('explicit sheet is sent', posted[posted.length - 1].sheet, 'Aug 2026');

  await page.screenshot({ path: path.join(__dirname, 'form.png'), fullPage: true });

  // The two ERR_FAILED entries are the submits this test deliberately aborted.
  const unexpected = errors.filter(e => !/MOCKMOCKMOCK|net::ERR_FAILED/.test(e));
  check('no unexpected page errors', unexpected, []);
  check('only the deliberate aborts failed', errors.length, 4);
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} failing check(s)` : '\nAll UI checks passed');
  process.exit(failures ? 1 : 0);
})();
