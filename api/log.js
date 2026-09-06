/**
 * Serverless proxy between the form and the Apps Script Web App.
 *
 * The browser never sees the script URL or the Apps Script secret — it only
 * sends the PIN typed on the phone. This function runs on Vercel, where those
 * values live as environment variables:
 *
 *   SCRIPT_URL     the Apps Script /exec URL
 *   SHARED_SECRET  the sharedSecret set in Code.gs (leave unset if blank there)
 *   FORM_PIN       the PIN typed once on each phone
 *
 * A missing SCRIPT_URL or FORM_PIN is refused rather than defaulted, so a fresh
 * deployment cannot quietly become an open write endpoint on the spreadsheet.
 */

var crypto = require('crypto');

var ALLOWED_ACTIONS = ['config', 'append', 'list', 'update', 'delete'];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST.' });
  }

  var scriptUrl = process.env.SCRIPT_URL;
  var sharedSecret = process.env.SHARED_SECRET || '';
  var formPin = process.env.FORM_PIN;

  if (!scriptUrl) {
    return res.status(500).json({ ok: false, error: 'SCRIPT_URL is not set on this deployment.' });
  }
  if (!formPin) {
    return res.status(500).json({ ok: false, error: 'FORM_PIN is not set on this deployment.' });
  }

  var body = req.body;
  if (typeof body === 'string' || body === undefined) {
    try { body = JSON.parse(body || '{}'); }
    catch (err) { return res.status(400).json({ ok: false, error: 'Body is not valid JSON.' }); }
  }
  body = body || {};

  if (!body.pin || !equal(String(body.pin), formPin)) {
    return res.status(401).json({ ok: false, needPin: true, error: 'Wrong PIN.' });
  }
  if (ALLOWED_ACTIONS.indexOf(body.action) === -1) {
    return res.status(400).json({ ok: false, error: 'Unknown action: ' + body.action });
  }

  var payload = Object.assign({}, body, { token: sharedSecret });
  delete payload.pin;

  var upstream;
  try {
    upstream = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Could not reach Apps Script: ' + err.message });
  }

  var text = await upstream.text();
  try {
    return res.status(200).json(JSON.parse(text));
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: 'Apps Script did not return JSON. Check that the deployment is current and open to "Anyone".'
    });
  }
};

/** Compares without leaking the answer through how long it took. */
function equal(a, b) {
  var left = Buffer.from(String(a));
  var right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
