/* Exercises the serverless proxy with a stubbed Apps Script upstream. */
const handler = require('../api/log.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : `\n      got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`));
}

function res() {
  const out = { code: 0, body: null, headers: {} };
  out.setHeader = (k, v) => { out.headers[k] = v; };
  out.status = code => { out.code = code; return out; };
  out.json = body => { out.body = body; return out; };
  return out;
}

const upstream = [];
function stubUpstream(text) {
  global.fetch = async (url, options) => {
    upstream.push({ url, body: JSON.parse(options.body) });
    return { text: async () => text };
  };
}

const env = { SCRIPT_URL: 'https://script.google.com/macros/s/X/exec', SHARED_SECRET: 'apps-script-secret', FORM_PIN: '4821' };
function setEnv(overrides = {}) {
  Object.assign(process.env, env, overrides);
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete process.env[key];
}

(async () => {
  stubUpstream(JSON.stringify({ ok: true, sheet: 'Sep 2026', row: 10 }));

  setEnv();
  let r = res();
  await handler({ method: 'GET', body: {} }, r);
  check('GET refused', [r.code, r.body.error], [405, 'Use POST.']);

  r = res();
  await handler({ method: 'POST', body: { action: 'config', pin: '4821' } }, r);
  check('valid PIN passes through', [r.code, r.body.ok], [200, true]);
  check('secret added server-side', upstream[upstream.length - 1].body.token, 'apps-script-secret');
  check('PIN never forwarded upstream', upstream[upstream.length - 1].body.pin, undefined);
  check('response not cached', r.headers['Cache-Control'], 'no-store');

  r = res();
  await handler({ method: 'POST', body: { action: 'config', pin: '4822' } }, r);
  check('wrong PIN rejected', [r.code, r.body.needPin], [401, true]);

  r = res();
  await handler({ method: 'POST', body: { action: 'config' } }, r);
  check('missing PIN rejected', [r.code, r.body.needPin], [401, true]);

  r = res();
  await handler({ method: 'POST', body: { action: 'setSheet', pin: '4821' } }, r);
  check('unknown action rejected', [r.code, r.body.error], [400, 'Unknown action: setSheet']);

  for (const action of ['list', 'update', 'delete']) {
    r = res();
    await handler({ method: 'POST', body: { action, pin: '4821', row: 10 } }, r);
    check(`${action} is forwarded`, [r.code, upstream[upstream.length - 1].body.action], [200, action]);
  }

  r = res();
  await handler({ method: 'POST', body: { action: 'delete', pin: 'nope', row: 10 } }, r);
  check('a wrong PIN cannot delete', [r.code, r.body.needPin], [401, true]);

  r = res();
  await handler({ method: 'POST', body: JSON.stringify({ action: 'append', pin: '4821', amount: 50 }) }, r);
  check('string body parsed', [r.code, r.body.ok], [200, true]);

  r = res();
  await handler({ method: 'POST', body: 'not json' }, r);
  check('bad body rejected', [r.code, r.body.error], [400, 'Body is not valid JSON.']);

  setEnv({ FORM_PIN: undefined });
  r = res();
  await handler({ method: 'POST', body: { action: 'config', pin: '4821' } }, r);
  check('refuses to run without a PIN configured', [r.code, r.body.error], [500, 'FORM_PIN is not set on this deployment.']);

  setEnv({ SCRIPT_URL: undefined });
  r = res();
  await handler({ method: 'POST', body: { action: 'config', pin: '4821' } }, r);
  check('refuses to run without a script URL', [r.code, r.body.error], [500, 'SCRIPT_URL is not set on this deployment.']);

  setEnv();
  stubUpstream('<!doctype html><html>sign in</html>');
  r = res();
  await handler({ method: 'POST', body: { action: 'config', pin: '4821' } }, r);
  check('HTML from Apps Script surfaces as a clear error', [r.code, /did not return JSON/.test(r.body.error)], [502, true]);

  global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  r = res();
  await handler({ method: 'POST', body: { action: 'config', pin: '4821' } }, r);
  check('unreachable upstream surfaces as 502', [r.code, /Could not reach Apps Script/.test(r.body.error)], [502, true]);

  console.log(failures ? `\n${failures} failing check(s)` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
