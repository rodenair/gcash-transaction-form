/**
 * R&S Sari-Sari Store — GCash Float & Fee Tracker
 * Web App backend for the mobile entry form.
 *
 * Deploy: Extensions > Apps Script (from the tracker spreadsheet), paste this file,
 * then Deploy > New deployment > Web app > Execute as ME, access ANYONE.
 * Paste the /exec URL into the form's setup screen.
 *
 * The form fills the typed columns (Date, Type, Customer, Amount, Notes) and,
 * when the phone sends them, Cash Change and E-Money Change — the fee is
 * sometimes paid in cash and sometimes taken from the wallet, so those two are
 * not derivable. Leave them out and the sheet's own formulas fill them instead.
 * Every other calculated column keeps its formula, copied down from the last row
 * that still has one.
 */

var SETTINGS = {
  // Leave blank when this script is bound to the tracker spreadsheet.
  // Otherwise put the spreadsheet ID here (the long id in its URL).
  spreadsheetId: '',

  // Set a random string here and enter the same one in the form's setup screen.
  // Leave blank to allow anyone with the URL to post. A secret is recommended,
  // because a Web App deployed with "Anyone" access is a public URL.
  sharedSecret: '',

  // How many rows back to look when collecting customer names for autocomplete.
  recentCustomerRows: 400,
  maxCustomers: 40
};

var DEFAULT_TYPES = ['Cash In', 'Cash Out', 'Fund In', 'Load', 'Expense'];

/* ---------------------------------------------------------------- routing */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'config') return handle_({ action: 'config', token: e.parameter.token }, e);
  return json_({ ok: true, service: 'gcash-tracker', version: 1 });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Body is not valid JSON.' });
  }
  return handle_(body, e);
}

function handle_(body, e) {
  try {
    if (SETTINGS.sharedSecret && body.token !== SETTINGS.sharedSecret) {
      return json_({ ok: false, error: 'Unauthorized — the secret in the form does not match the script.' });
    }
    switch (body.action) {
      case 'config':
        return json_(getConfig_());
      case 'append':
        return json_(appendTransaction_(body));
      case 'list':
        return json_(listTransactions_(body));
      case 'update':
        return json_(updateTransaction_(body));
      case 'delete':
        return json_(deleteTransaction_(body));
      default:
        return json_({ ok: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------ sheet model */

function book_() {
  return SETTINGS.spreadsheetId
    ? SpreadsheetApp.openById(SETTINGS.spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
}

/** Row number of the "Date | Type | Customer / Ref | Amount ..." header, or 0. */
function headerRow_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (!lastRow || !lastCol) return 0;
  var rows = Math.min(12, lastRow);
  var values = sheet.getRange(1, 1, rows, Math.min(12, lastCol)).getValues();
  for (var i = 0; i < values.length; i++) {
    var row = values[i].map(function (v) { return String(v).trim().toLowerCase(); });
    if (row[0] === 'date' && row[1] === 'type' && row.indexOf('amount') !== -1) return i + 1;
  }
  return 0;
}

/** Header name -> column number, for the columns the form cares about. */
function columns_(sheet, hRow) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(hRow, 1, 1, lastCol).getValues()[0];
  var cols = { all: [] };
  for (var c = 0; c < headers.length; c++) {
    var name = String(headers[c]).trim().toLowerCase();
    if (!name) continue;
    var col = c + 1;
    cols.all.push({ name: name, col: col });
    if (name === 'date') cols.date = col;
    else if (name === 'type') cols.type = col;
    else if (name.indexOf('customer') === 0) cols.customer = col;
    else if (name === 'amount') cols.amount = col;
    else if (name === 'cash change') cols.cashChange = col;
    else if (name === 'e-money change') cols.emoneyChange = col;
    else if (name === 'fee') cols.fee = col;
    else if (name === 'cash balance') cols.cashBalance = col;
    else if (name === 'e-money balance') cols.emoneyBalance = col;
    else if (name === 'notes') cols.notes = col;
  }
  return cols;
}

/** Columns the form types into; everything else on a log row is calculated. */
function inputCols_(cols) {
  return [cols.date, cols.type, cols.customer, cols.amount, cols.notes].filter(function (c) { return !!c; });
}

/** Last row that has a date, i.e. the last real transaction. */
function lastDataRow_(sheet, cols, hRow) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= hRow) return hRow;
  var values = sheet.getRange(hRow + 1, cols.date, lastRow - hRow, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (values[i][0] !== '' && values[i][0] !== null) return hRow + 1 + i;
  }
  return hRow;
}

/** All sheets that look like a daily transaction log. */
function logSheets_() {
  return book_().getSheets().map(function (sheet) {
    var hRow = headerRow_(sheet);
    if (!hRow) return null;
    var cols = columns_(sheet, hRow);
    if (!cols.date || !cols.type || !cols.amount) return null;
    return { sheet: sheet, name: sheet.getName(), headerRow: hRow, cols: cols };
  }).filter(function (s) { return !!s; });
}

/** Newest transaction date on a log sheet, as a millisecond value (0 if empty). */
function latestDate_(log) {
  var row = lastDataRow_(log.sheet, log.cols, log.headerRow);
  if (row <= log.headerRow) return 0;
  var value = log.sheet.getRange(row, log.cols.date).getValue();
  return (value instanceof Date) ? value.getTime() : 0;
}

/** The sheet a new record should go to: this month's log, else the most recent one. */
function pickLogSheet_(logs, isoDate) {
  if (!logs.length) throw new Error('No sheet with a "Date / Type / Customer / Amount" header was found.');
  var target = isoDate ? isoDate.slice(0, 7) : Utilities.formatDate(new Date(), timezone_(), 'yyyy-MM');
  var best = null;
  var newest = null;
  for (var i = 0; i < logs.length; i++) {
    var ms = latestDate_(logs[i]);
    if (ms && Utilities.formatDate(new Date(ms), timezone_(), 'yyyy-MM') === target) best = logs[i];
    if (!newest || ms >= latestDate_(newest)) newest = logs[i];
  }
  return best || newest || logs[logs.length - 1];
}

function timezone_() {
  return book_().getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'Asia/Manila';
}

/** The log a request should act on: the named sheet if given, else the auto pick. */
function resolveLog_(logs, sheetName, isoDate) {
  var log = sheetName
    ? logs.filter(function (l) { return l.name === sheetName; })[0]
    : pickLogSheet_(logs, isoDate);
  if (!log) throw new Error('Sheet not found: ' + sheetName);
  return log;
}

/* -------------------------------------------------------------- read side */

function getConfig_() {
  var logs = logSheets_();
  var active = pickLogSheet_(logs);
  var row = lastDataRow_(active.sheet, active.cols, active.headerRow);

  var balances = { cash: null, emoney: null };
  if (row > active.headerRow) {
    if (active.cols.cashBalance) balances.cash = numberOrNull_(active.sheet.getRange(row, active.cols.cashBalance).getValue());
    if (active.cols.emoneyBalance) balances.emoney = numberOrNull_(active.sheet.getRange(row, active.cols.emoneyBalance).getValue());
  }

  return {
    ok: true,
    timezone: timezone_(),
    today: Utilities.formatDate(new Date(), timezone_(), 'yyyy-MM-dd'),
    spreadsheetName: book_().getName(),
    sheets: logs.map(function (l) { return l.name; }),
    activeSheet: active.name,
    rowsUsed: Math.max(0, row - active.headerRow),
    balances: balances,
    types: typesFrom_(active),
    customers: customersFrom_(active),
    rateCard: rateCard_()
  };
}

function numberOrNull_(value) {
  return (typeof value === 'number' && isFinite(value)) ? value : null;
}

/** Parses a value the phone sent. Blank, null or absent all mean "not given". */
function number_(value) {
  if (value === null || value === undefined || value === '') return null;
  var parsed = Number(value);
  return isFinite(parsed) ? parsed : null;
}

function typesFrom_(log) {
  var types = DEFAULT_TYPES.slice();
  var row = lastDataRow_(log.sheet, log.cols, log.headerRow);
  if (row > log.headerRow) {
    var values = log.sheet.getRange(log.headerRow + 1, log.cols.type, row - log.headerRow, 1).getValues();
    values.forEach(function (r) {
      var v = String(r[0]).trim();
      if (v && types.indexOf(v) === -1) types.push(v);
    });
  }
  return types;
}

/** Recent customer names, most recently used first. */
function customersFrom_(log) {
  if (!log.cols.customer) return [];
  var row = lastDataRow_(log.sheet, log.cols, log.headerRow);
  if (row <= log.headerRow) return [];
  var start = Math.max(log.headerRow + 1, row - SETTINGS.recentCustomerRows + 1);
  var values = log.sheet.getRange(start, log.cols.customer, row - start + 1, 1).getValues();
  var seen = {};
  var names = [];
  for (var i = values.length - 1; i >= 0; i--) {
    var name = String(values[i][0]).replace(/\/+$/, '').trim();
    if (!name || seen[name.toLowerCase()]) continue;
    seen[name.toLowerCase()] = true;
    names.push(name);
    if (names.length >= SETTINGS.maxCustomers) break;
  }
  return names;
}

/** The Rate Card sheet as [{min, max, fee}], used for the form's fee preview. */
function rateCard_() {
  var sheets = book_().getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    if (String(sheet.getRange(1, 1).getValue()).trim().toUpperCase().indexOf('RATE CARD') !== 0) continue;
    var values = sheet.getDataRange().getValues();
    var brackets = [];
    for (var r = 0; r < values.length; r++) {
      var min = values[r][0], max = values[r][1], fee = values[r][2];
      if (typeof min === 'number' && typeof max === 'number' && typeof fee === 'number') {
        brackets.push({ min: min, max: max, fee: fee });
      }
    }
    if (brackets.length) return brackets;
  }
  return [];
}

/* ------------------------------------------------------------- write side */

function appendTransaction_(body) {
  var amount = Number(body.amount);
  if (!isFinite(amount) || amount <= 0) throw new Error('Amount must be a number greater than zero.');
  var type = String(body.type || '').trim();
  if (!type) throw new Error('Type is required.');
  var isoDate = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error('Date must be formatted yyyy-mm-dd.');

  var cached = cachedResult_(body);
  if (cached) return cached;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var logs = logSheets_();
    var log = resolveLog_(logs, body.sheet, isoDate);

    var sheet = log.sheet, cols = log.cols, hRow = log.headerRow;
    var lastRow = lastDataRow_(sheet, cols, hRow);
    var targetRow = lastRow + 1;
    if (targetRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);

    // Typed-in changes replace the formula in those cells; anything left blank
    // on the phone keeps whatever the sheet calculates.
    var cashChange = number_(body.cashChange);
    var emoneyChange = number_(body.emoneyChange);
    var typedIn = [];
    if (cols.cashChange && cashChange !== null) typedIn.push(cols.cashChange);
    if (cols.emoneyChange && emoneyChange !== null) typedIn.push(cols.emoneyChange);

    fillFormulas_(sheet, cols, hRow, lastRow, targetRow, typedIn);

    var parts = isoDate.split('-');
    sheet.getRange(targetRow, cols.date).setValue(new Date(+parts[0], +parts[1] - 1, +parts[2]));
    sheet.getRange(targetRow, cols.type).setValue(type);
    if (cols.customer) sheet.getRange(targetRow, cols.customer).setValue(String(body.customer || '').trim());
    sheet.getRange(targetRow, cols.amount).setValue(amount);
    if (cols.cashChange && cashChange !== null) sheet.getRange(targetRow, cols.cashChange).setValue(cashChange);
    if (cols.emoneyChange && emoneyChange !== null) sheet.getRange(targetRow, cols.emoneyChange).setValue(emoneyChange);
    if (cols.notes) sheet.getRange(targetRow, cols.notes).setValue(String(body.notes || '').trim());

    SpreadsheetApp.flush();

    var out = {
      ok: true,
      sheet: log.name,
      row: targetRow,
      fee: cols.fee ? numberOrNull_(sheet.getRange(targetRow, cols.fee).getValue()) : null,
      changes: {
        cash: cols.cashChange ? numberOrNull_(sheet.getRange(targetRow, cols.cashChange).getValue()) : null,
        emoney: cols.emoneyChange ? numberOrNull_(sheet.getRange(targetRow, cols.emoneyChange).getValue()) : null
      },
      balances: {
        cash: cols.cashBalance ? numberOrNull_(sheet.getRange(targetRow, cols.cashBalance).getValue()) : null,
        emoney: cols.emoneyBalance ? numberOrNull_(sheet.getRange(targetRow, cols.emoneyBalance).getValue()) : null
      }
    };
    return remember_(body, out);
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------- edit an existing row */

/** The most recent rows of a sheet, newest first, for the phone's list. */
function listTransactions_(body) {
  var logs = logSheets_();
  var log = resolveLog_(logs, body.sheet);

  var limit = Math.min(Math.max(Number(body.limit) || 25, 1), 100);
  var lastRow = lastDataRow_(log.sheet, log.cols, log.headerRow);
  var firstRow = Math.max(log.headerRow + 1, lastRow - limit + 1);
  if (firstRow > lastRow) return { ok: true, sheet: log.name, rows: [] };

  // One pair of range reads for the whole block instead of one per cell per
  // row — a 100-row list would otherwise cost ~1000 individual Sheets calls.
  var block = readBlock_(log.sheet, firstRow, lastRow - firstRow + 1);
  var rows = [];
  for (var row = lastRow; row >= firstRow; row--) {
    var i = row - firstRow;
    rows.push(rowFromBlock_(log.cols, log.name, row, block.values[i], block.formulas[i]));
  }
  return { ok: true, sheet: log.name, rows: rows };
}

/** Reads every column of `numRows` rows starting at `firstRow` in one shot. */
function readBlock_(sheet, firstRow, numRows) {
  var range = sheet.getRange(firstRow, 1, numRows, sheet.getLastColumn());
  return { values: range.getValues(), formulas: range.getFormulas() };
}

/**
 * One row as the phone shows it, built from an already-fetched row of values
 * and formulas (see readBlock_). Cash Change and E-Money Change report
 * whether they still hold a formula, so editing a row does not silently
 * freeze a calculated cell into a typed-in number.
 */
function rowFromBlock_(cols, sheetName, row, values, formulas) {
  var cell = function (col) { return col ? values[col - 1] : null; };
  var formula = function (col) { return col ? formulas[col - 1] : ''; };
  var date = cell(cols.date);
  var out = {
    row: row,
    sheet: sheetName,
    date: (date instanceof Date) ? Utilities.formatDate(date, timezone_(), 'yyyy-MM-dd') : '',
    type: cols.type ? String(cell(cols.type)) : '',
    customer: cols.customer ? String(cell(cols.customer)) : '',
    amount: cols.amount ? numberOrNull_(cell(cols.amount)) : null,
    fee: cols.fee ? numberOrNull_(cell(cols.fee)) : null,
    notes: cols.notes ? String(cell(cols.notes)) : '',
    balances: {
      cash: cols.cashBalance ? numberOrNull_(cell(cols.cashBalance)) : null,
      emoney: cols.emoneyBalance ? numberOrNull_(cell(cols.emoneyBalance)) : null
    }
  };
  ['cashChange', 'emoneyChange'].forEach(function (key) {
    if (!cols[key]) { out[key] = { value: null, calculated: false }; return; }
    out[key] = { value: numberOrNull_(cell(cols[key])), calculated: !!formula(cols[key]) };
  });
  return out;
}

/** One row as the phone shows it, read directly from the sheet (single row). */
function rowValues_(sheet, cols, row, sheetName) {
  var block = readBlock_(sheet, row, 1);
  return rowFromBlock_(cols, sheetName || '', row, block.values[0], block.formulas[0]);
}

/**
 * Finds the row the phone asked for and refuses if it no longer holds the
 * record that was on screen — rows shift when the sheet is edited elsewhere,
 * and overwriting the wrong transaction is worse than a failed save.
 */
function locateRow_(body) {
  var logs = logSheets_();
  var log = resolveLog_(logs, body.sheet);

  var row = Number(body.row);
  var lastRow = lastDataRow_(log.sheet, log.cols, log.headerRow);
  if (!row || row <= log.headerRow || row > lastRow) throw new Error('Row ' + body.row + ' is not a transaction row.');

  var current = rowValues_(log.sheet, log.cols, row, log.name);
  var expect = body.expect || {};
  if (expect.date && expect.date !== current.date) {
    throw new Error('That row now holds a different date. Refresh the list and try again.');
  }
  if (expect.amount !== undefined && expect.amount !== null && Number(expect.amount) !== current.amount) {
    throw new Error('That row now holds a different amount. Refresh the list and try again.');
  }
  // Date + amount alone can collide (e.g. two same-day, same-amount "Load"
  // transactions) — customer narrows that further when the phone sent it.
  if (expect.customer !== undefined && expect.customer !== null && String(expect.customer) !== current.customer) {
    throw new Error('That row now holds a different customer. Refresh the list and try again.');
  }
  return { log: log, row: row, current: current, firstDataRow: log.headerRow + 1, lastRow: lastRow };
}

function updateTransaction_(body) {
  var cached = cachedResult_(body);
  if (cached) return cached;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = locateRow_(body);
    var sheet = found.log.sheet, cols = found.log.cols, row = found.row;

    if (body.date !== undefined && body.date !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) throw new Error('Date must be formatted yyyy-mm-dd.');
      var parts = String(body.date).split('-');
      sheet.getRange(row, cols.date).setValue(new Date(+parts[0], +parts[1] - 1, +parts[2]));
    }
    if (body.type) sheet.getRange(row, cols.type).setValue(String(body.type).trim());
    if (body.customer !== undefined && cols.customer) sheet.getRange(row, cols.customer).setValue(String(body.customer).trim());
    if (body.notes !== undefined && cols.notes) sheet.getRange(row, cols.notes).setValue(String(body.notes).trim());

    if (body.amount !== undefined && body.amount !== '') {
      var amount = Number(body.amount);
      if (!isFinite(amount) || amount <= 0) throw new Error('Amount must be a number greater than zero.');
      sheet.getRange(row, cols.amount).setValue(amount);
    }

    // A blank change field leaves that cell exactly as it is, formula included.
    var cashChange = number_(body.cashChange);
    var emoneyChange = number_(body.emoneyChange);
    if (cols.cashChange && cashChange !== null) sheet.getRange(row, cols.cashChange).setValue(cashChange);
    if (cols.emoneyChange && emoneyChange !== null) sheet.getRange(row, cols.emoneyChange).setValue(emoneyChange);

    SpreadsheetApp.flush();
    var after = rowValues_(sheet, cols, row);
    return remember_(body, {
      ok: true, sheet: found.log.name, row: row, fee: after.fee,
      changes: { cash: after.cashChange.value, emoney: after.emoneyChange.value },
      balances: after.balances
    });
  } finally {
    lock.releaseLock();
  }
}

function deleteTransaction_(body) {
  var cached = cachedResult_(body);
  if (cached) return cached;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = locateRow_(body);
    // The first data row is where the running balances pick up the opening
    // figures; removing it would leave the next row pointing at the header.
    if (found.row === found.firstDataRow) {
      throw new Error('This is the first row of the sheet — edit it instead of deleting it.');
    }
    found.log.sheet.deleteRow(found.row);
    SpreadsheetApp.flush();

    var lastRow = lastDataRow_(found.log.sheet, found.log.cols, found.log.headerRow);
    var balances = { cash: null, emoney: null };
    if (lastRow > found.log.headerRow) {
      var tail = rowValues_(found.log.sheet, found.log.cols, lastRow);
      balances = tail.balances;
    }
    return remember_(body, { ok: true, sheet: found.log.name, row: found.row, deleted: true, balances: balances });
  } finally {
    lock.releaseLock();
  }
}

/* A retried write from the phone must not be applied twice. */

function cacheKey_(body) {
  return body.clientId ? 'req_' + body.clientId : null;
}

function cachedResult_(body) {
  var key = cacheKey_(body);
  if (!key) return null;
  var previous = CacheService.getScriptCache().get(key);
  if (!previous) return null;
  var result = JSON.parse(previous);
  result.duplicate = true;
  return result;
}

function remember_(body, result) {
  var key = cacheKey_(body);
  if (key) CacheService.getScriptCache().put(key, JSON.stringify(result), 21600); // 6 hours
  return result;
}

/**
 * Give the new row the same calculated columns as the rest of the sheet.
 * Blank rows below the data often already carry the formulas; when they do not,
 * they are copied from the nearest row above that still has them, so a row the
 * owner once overwrote by hand does not become the template.
 */
function fillFormulas_(sheet, cols, hRow, lastRow, targetRow, typedIn) {
  var typed = inputCols_(cols).concat(typedIn || []);
  var calculated = cols.all
    .map(function (h) { return h.col; })
    .filter(function (col) { return typed.indexOf(col) === -1; });
  if (!calculated.length || lastRow <= hRow) return;

  for (var i = 0; i < calculated.length; i++) {
    var col = calculated[i];
    if (sheet.getRange(targetRow, col).getFormula()) continue;
    var source = 0;
    for (var row = lastRow; row > hRow && row > lastRow - 200; row--) {
      if (sheet.getRange(row, col).getFormula()) { source = row; break; }
    }
    if (source) sheet.getRange(source, col).copyTo(sheet.getRange(targetRow, col));
  }
}
