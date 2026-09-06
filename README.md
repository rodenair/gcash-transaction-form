# GCash Tracker — mobile entry form

A one-screen web form for adding a record to the **R&S Sari-Sari Store — GCash Float & Fee Tracker**
spreadsheet, so you never have to edit the sheet itself on a phone.

The form posts JSON to a Google Apps Script Web App bound to the spreadsheet. The script appends a
row filling only the typed columns — Date, Type, Customer / Ref, Amount, Notes — and lets the
spreadsheet's own formulas calculate Cash Change, E-Money Change, Fee, both running balances and
Month, exactly as when you type a row by hand.

```
phone (index.html) ──POST /api/log──▶ Vercel function ──POST JSON──▶ Apps Script ──▶ Daily Log
                   ◀────balances─────  (holds URL +    ◀──────────────  (formulas)
                                        secret)
```

The phone sends only a PIN. The Apps Script URL and its shared secret live as
environment variables on the server, so neither is ever shipped to the browser.
On a host with no server — GitHub Pages, or the file opened locally — the form
detects that and falls back to talking to Apps Script directly, with the URL and
secret typed into the phone instead.

## What the form does

- Type, amount, customer, date and notes on one screen, with big touch targets.
- Quick-amount chips and a recent-customer list pulled from the sheet itself.
- Live fee preview read from your **Rate Card** sheet (2% − ₱10 above the top bracket).
- Shows the current cash and e-money balances before and after each save.
- Picks the right monthly sheet automatically — the one whose latest entry is in the same month as
  the record you are adding. You can override it in Settings.
- Queues records on this phone when the signal drops and retries them when you are back online.
- A repeated send never adds the row twice: each record carries a one-time id the script remembers
  for six hours.

## Setup

### 1. Deploy the Apps Script

1. Open the tracker spreadsheet → **Extensions → Apps Script**.
2. Delete the placeholder `Code.gs` content and paste [`apps-script/Code.gs`](apps-script/Code.gs).
3. Optional but recommended: set a secret at the top of the file, e.g.

   ```js
   sharedSecret: 'pick-any-random-string'
   ```

   A Web App deployed with "Anyone" access is a public URL. The secret keeps strangers who guess
   the URL from writing to your sheet.
4. **Deploy → New deployment → type: Web app**
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
5. Approve the permission prompt, then copy the `/exec` URL.

Whenever you edit the script afterwards, use **Deploy → Manage deployments → edit → Version: New
version**, otherwise the phone keeps hitting the old code.

### 2. Publish the form on Vercel

1. [vercel.com/new](https://vercel.com/new) → import `rodenair/gcash-transaction-form`.
2. Framework Preset **Other**; no build command, no output directory.
3. **Settings → Environment Variables**, for Production (and Preview, if you use preview URLs):

   | Name | Value |
   | --- | --- |
   | `SCRIPT_URL` | your Apps Script `/exec` URL |
   | `SHARED_SECRET` | the same string as `sharedSecret` in `Code.gs` |
   | `FORM_PIN` | the PIN you will type on the phone |

4. **Redeploy** — environment variables are read at request time, but a deployment made before
   they existed still needs one redeploy to pick up the project settings.

`api/log.js` refuses to run unless `SCRIPT_URL` and `FORM_PIN` are both set, so a half-configured
deployment fails loudly instead of quietly becoming an open write endpoint on your spreadsheet.

**GitHub Pages** works too, without the server piece: Settings → Pages → deploy from a branch,
`/ (root)`. The form then asks for the `/exec` URL and secret directly on the phone.

### 3. Connect the phone

1. Open the site. On Vercel it asks for the PIN; on a static host it asks for the URL and secret.
2. Whatever you type is stored in that browser's `localStorage` only — never in the repo.
3. Browser menu → **Add to Home Screen** for an app-like icon. The shell is cached by a service
   worker, so it opens instantly even on a weak signal.

## Using it

Pick a type, type the amount, optionally pick a customer, tap **Add record**. The confirmation
names the sheet and row it landed on and the new balances. Everything else the sheet calculates.

**Settings** lets you force a specific sheet (useful for backdating into a closed month), change
the URL or secret, or disconnect the phone.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The whole form — markup, styles and logic in one file. |
| `apps-script/Code.gs` | Web App backend: appends the row, returns balances, rate card and recent customers. |
| `api/log.js` | Vercel function holding the script URL and secret; checks the PIN and forwards. |
| `vercel.json` | Cache headers for the shell, function timeout. |
| `sw.js` | Service worker that caches the shell for offline opening. |
| `manifest.webmanifest`, `icon.svg` | Home-screen icon and app metadata. |

## API

Everything is a `POST` with a JSON body. The content type is `text/plain;charset=utf-8` on purpose:
it keeps the request "simple" so the browser skips the CORS preflight that Apps Script cannot answer.

```jsonc
// Add a record
{ "action": "append", "token": "…", "clientId": "x-abc123",
  "date": "2026-09-05", "type": "Cash In", "customer": "Iresh",
  "amount": 500, "notes": "", "sheet": "" }

// → { "ok": true, "sheet": "Sep 2026", "row": 10, "fee": 10,
//     "balances": { "cash": 22340, "emoney": 44220 } }
```

```jsonc
// Everything the form needs to render
{ "action": "config", "token": "…" }

// → { "ok": true, "sheets": [...], "activeSheet": "Sep 2026", "rowsUsed": 4,
//     "balances": {...}, "types": [...], "customers": [...], "rateCard": [...] }
```

Errors come back as `{ "ok": false, "error": "…" }` with HTTP 200, which is how Apps Script reports
failures.

## Notes and limits

- The script finds a log sheet by its header row (`Date | Type | Customer / Ref | Amount …`), so
  renaming tabs or adding a new month is fine as long as that header stays.
- Calculated columns are copied from the nearest row above that still holds formulas, so a row you
  once overwrote by hand does not become the template for new ones.
- The fee shown on the phone is a preview from the Rate Card. The value written to the sheet is
  always the one the sheet's own formula produces.
- The script only ever appends after the last dated row; it never edits or deletes existing rows.
- The PIN gates the proxy, and the proxy is the only thing that knows the Apps Script URL. Change
  the PIN by editing `FORM_PIN` and redeploying; every phone then has to type the new one.
- Keep `sharedSecret` blank in the committed `Code.gs`. Set the real value in the Apps Script
  editor and in `SHARED_SECRET` on Vercel — this repo is public.

## Tests

```bash
node tests/appscript.test.js   # backend logic against a simulated spreadsheet, no dependencies
node tests/proxy.test.js       # the Vercel function: PIN handling, secret injection, upstream errors
node tests/ui.test.js          # drives the form in Chromium, both PIN and direct modes (needs playwright)
```
