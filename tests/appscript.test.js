/* Harness: runs Code.gs against a fake Spreadsheet service shaped like the real tracker. */
const fs = require('fs');
const path = require('path');

const COLS = 11; // A..K
const rate = [
  { min: 1, max: 100, fee: 5 }, { min: 101, max: 500, fee: 10 },
  { min: 501, max: 1000, fee: 15 }, { min: 1001, max: 1500, fee: 20 },
  { min: 1501, max: 2000, fee: 30 }
];

function feeFor(amount, type) {
  if (type === 'Fund In' || type === 'Expense') return '';
  for (const b of rate) if (amount >= b.min && amount <= b.max) return b.fee;
  return Math.round(amount * 0.02 - 10);
}

class Cell {
  constructor(value = '', formula = '') { this.value = value; this.formula = formula; }
}

class FakeSheet {
  constructor(name, rows = 200) {
    this.name = name;
    this.grid = Array.from({ length: rows }, () => Array.from({ length: COLS }, () => new Cell()));
  }
  getName() { return this.name; }
  getMaxRows() { return this.grid.length; }
  insertRowsAfter(after, n) {
    for (let i = 0; i < n; i++) this.grid.push(Array.from({ length: COLS }, () => new Cell()));
  }
  deleteRow(row) {
    this.grid.splice(row - 1, 1);
    this.grid.push(Array.from({ length: COLS }, () => new Cell()));
    this.recalc();
  }
  cell(r, c) { return this.grid[r - 1][c - 1]; }
  set(r, c, value, formula = '') { this.grid[r - 1][c - 1] = new Cell(value, formula); }
  getLastRow() {
    for (let r = this.grid.length; r >= 1; r--) {
      if (this.grid[r - 1].some(cell => cell.value !== '' || cell.formula)) return r;
    }
    return 0;
  }
  getLastColumn() { return COLS; }
  getDataRange() { return this.getRange(1, 1, this.getLastRow() || 1, COLS); }
  getRange(row, col, numRows = 1, numCols = 1) { return new FakeRange(this, row, col, numRows, numCols); }
  recalc() {
    // Derived columns are recomputed for every row that carries a formula. A
    // Cash Change or E-Money Change typed in by hand has no formula, so the
    // balances follow the typed number instead of the calculated one.
    let cash = this.opening.cash, emoney = this.opening.emoney;
    for (let r = 6; r <= this.grid.length; r++) {
      const date = this.cell(r, 1).value;
      const type = this.cell(r, 2).value;
      const amount = this.cell(r, 4).value;
      const has = c => !!this.cell(r, c).formula;
      if (![5, 6, 7, 8, 9, 10].some(has)) continue;
      if (date === '' || date === null) {
        [5, 6, 7, 8, 9, 10].forEach(c => { if (has(c)) this.cell(r, c).value = ''; });
        continue;
      }
      const fee = feeFor(amount, type);
      let derivedCash = 0, derivedEmoney = 0;
      if (type === 'Cash In') { derivedCash = amount + (fee || 0); derivedEmoney = -amount; }
      else if (type === 'Cash Out') { derivedCash = -amount; derivedEmoney = amount + (fee || 0); }
      else if (type === 'Fund In') { derivedEmoney = amount; }
      else if (type === 'Load') { derivedCash = amount + (fee || 0); }
      else if (type === 'Expense') { derivedCash = -amount; }

      const literal = c => (typeof this.cell(r, c).value === 'number' ? this.cell(r, c).value : 0);
      const cashChange = has(5) ? derivedCash : literal(5);
      const emoneyChange = has(6) ? derivedEmoney : literal(6);
      cash += cashChange; emoney += emoneyChange;

      if (has(5)) this.cell(r, 5).value = cashChange;
      if (has(6)) this.cell(r, 6).value = emoneyChange;
      if (has(7)) this.cell(r, 7).value = fee;
      if (has(8)) this.cell(r, 8).value = cash;
      if (has(9)) this.cell(r, 9).value = emoney;
      if (has(10)) this.cell(r, 10).value = date instanceof Date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : '';
    }
  }
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet.cell(this.row + r, this.col + c).value);
      out.push(line);
    }
    return out;
  }
  getValue() { return this.sheet.cell(this.row, this.col).value; }
  setValue(value) {
    this.sheet.grid[this.row - 1][this.col - 1] = new Cell(value, '');
    this.sheet.recalc();
    return this;
  }
  getFormula() { return this.sheet.cell(this.row, this.col).formula; }
  copyTo(target) {
    const src = this.sheet.cell(this.row, this.col);
    // Row references shift like real relative formulas.
    const shifted = src.formula.replace(/(\$?[A-K])(\d+)/g, (m, letter, digits) =>
      letter + (Number(digits) + (target.row - this.row)));
    target.sheet.set(target.row, target.col, '', shifted);
    target.sheet.recalc();
  }
}

/* --- build a book shaped like the real one --- */
function logSheet(name, opening, rows) {
  const sheet = new FakeSheet(name);
  sheet.opening = opening;
  sheet.set(1, 1, 'DAILY TRANSACTION LOG');
  sheet.set(2, 1, 'Opening Cash on Hand'); sheet.set(2, 2, opening.cash);
  sheet.set(3, 1, 'Opening E-Money Balance'); sheet.set(3, 2, opening.emoney);
  ['Date', 'Type', 'Customer / Ref', 'Amount', 'Cash Change', 'E-Money Change', 'Fee',
   'Cash Balance', 'E-Money Balance', 'Month', 'Notes'].forEach((h, i) => sheet.set(5, i + 1, h));
  rows.forEach((row, i) => {
    const r = 6 + i;
    sheet.set(r, 1, row.date); sheet.set(r, 2, row.type);
    sheet.set(r, 3, row.customer || ''); sheet.set(r, 4, row.amount);
    if (row.manual) { [5, 6, 7, 8, 9, 10].forEach(c => sheet.set(r, c, 'hand-typed')); }
    else { [5, 6, 7, 8, 9, 10].forEach(c => sheet.set(r, c, '', `=FORMULA(A${r})`)); }
  });
  // Blank rows below the data keep their formulas, like the real sheet.
  for (let r = 6 + rows.length; r <= 6 + rows.length + 5; r++) {
    [5, 6, 7, 8, 9, 10].forEach(c => sheet.set(r, c, '', `=FORMULA(A${r})`));
  }
  sheet.recalc();
  return sheet;
}

function rateSheet() {
  const sheet = new FakeSheet('Rate Card', 20);
  sheet.opening = { cash: 0, emoney: 0 };
  sheet.set(1, 1, 'RATE CARD');
  sheet.set(4, 1, 'Min Amount'); sheet.set(4, 2, 'Max Amount'); sheet.set(4, 3, 'Fee');
  rate.forEach((b, i) => {
    sheet.set(5 + i, 1, b.min); sheet.set(5 + i, 2, b.max); sheet.set(5 + i, 3, b.fee);
  });
  return sheet;
}

const august = logSheet('Aug 2026', { cash: 4090, emoney: 4200 }, [
  { date: new Date(2026, 7, 1), type: 'Cash In', customer: 'Mariel', amount: 1000 },
  { date: new Date(2026, 7, 2), type: 'Cash Out', customer: 'Iresh', amount: 500, manual: true }
]);
const september = logSheet('Sep 2026', { cash: 20600, emoney: 45909 }, [
  { date: new Date(2026, 8, 2), type: 'Load', customer: '', amount: 99 },
  { date: new Date(2026, 8, 4), type: 'Cash In', customer: 'Josh', amount: 1000 }
]);
const book = {
  getName: () => 'GCash Tracker',
  getSpreadsheetTimeZone: () => 'Asia/Manila',
  getSheets: () => [august, september, rateSheet(), new FakeSheet('Monthly Summary', 5)]
};

/* --- fake Apps Script services --- */
const cacheStore = {};
global.SpreadsheetApp = { getActiveSpreadsheet: () => book, openById: () => book, flush() {} };
global.CacheService = { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) };
global.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
global.Session = { getScriptTimeZone: () => 'Asia/Manila' };
global.ContentService = {
  MimeType: { JSON: 'json' },
  createTextOutput: text => ({ setMimeType: () => text })
};
global.Utilities = {
  formatDate: (date, tz, format) => {
    const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
    return format === 'yyyy-MM' ? `${y}-${m}` : `${y}-${m}-${d}`;
  }
};

const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
eval(code);

/* --- assertions --- */
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : `\n      got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`));
}

const config = getConfig_();
check('log sheets found', config.sheets, ['Aug 2026', 'Sep 2026']);
check('active sheet is the latest month', config.activeSheet, 'Sep 2026');
check('rate card parsed', config.rateCard.length, rate.length);
check('customers most-recent-first', config.customers, ['Josh']);
check('types include sheet + defaults', config.types.indexOf('Load') > -1, true);
check('rows counted', config.rowsUsed, 2);

const before = config.balances;
const added = appendTransaction_({
  action: 'append', clientId: 'abc', date: '2026-09-05', type: 'Cash In',
  customer: 'Iresh', amount: 500, notes: 'test'
});
check('appended to September', added.sheet, 'Sep 2026');
check('appended after the last row', added.row, 8);
check('fee came from the sheet', added.fee, 10);
check('cash balance moved by amount + fee', added.balances.cash, before.cash + 510);
check('e-money balance moved by amount', added.balances.emoney, before.emoney - 500);
check('inputs landed in the right columns',
  september.getRange(8, 1, 1, 11).getValues()[0].slice(0, 4).map(String),
  [String(new Date(2026, 8, 5)), 'Cash In', 'Iresh', '500']);
check('notes written', september.getRange(8, 11).getValue(), 'test');

const repeat = appendTransaction_({ action: 'append', clientId: 'abc', date: '2026-09-05', type: 'Cash In', amount: 500 });
check('duplicate clientId does not append twice', [repeat.duplicate, repeat.row], [true, 8]);

// A record dated in August must land on the August sheet, and must not use the
// hand-typed row as its formula template.
const backdated = appendTransaction_({ action: 'append', clientId: 'def', date: '2026-08-15', type: 'Cash Out', customer: 'Rod', amount: 1000 });
check('backdated record goes to August', backdated.sheet, 'Aug 2026');
check('formula row skipped the hand-typed row', typeof backdated.fee, 'number');
check('August fee is calculated', backdated.fee, 15);

// A row appended where the blank row below has no formulas at all.
const bare = logSheet('Bare', { cash: 100, emoney: 100 }, [{ date: new Date(2026, 8, 1), type: 'Cash In', amount: 100 }]);
for (let r = 7; r <= bare.getMaxRows(); r++) [5, 6, 7, 8, 9, 10].forEach(c => bare.set(r, c, '', ''));
book.getSheets = () => [bare, rateSheet()];
const onBare = appendTransaction_({ action: 'append', clientId: 'ghi', date: '2026-09-06', type: 'Cash In', amount: 100 });
check('formulas copied down when the blank row had none', onBare.fee, 5);
check('balance continued from the row above', onBare.balances.cash, 100 + 105 + 105);

// A Cash Out where the fee comes out of the wallet, not the till: the two
// change columns are typed in and must survive as values, not formulas.
book.getSheets = () => [august, september, rateSheet(), new FakeSheet('Monthly Summary', 5)];
const beforeManual = getConfig_().balances;
const manual = appendTransaction_({
  action: 'append', clientId: 'manual-1', date: '2026-09-06', type: 'Cash Out',
  customer: 'Steph', amount: 500, cashChange: -500, emoneyChange: 510
});
check('typed changes are written as given', manual.changes, { cash: -500, emoney: 510 });
check('typed cells hold values, not formulas',
  [september.getRange(manual.row, 5).getFormula(), september.getRange(manual.row, 6).getFormula()], ['', '']);
check('balances follow the typed changes',
  [manual.balances.cash, manual.balances.emoney], [beforeManual.cash - 500, beforeManual.emoney + 510]);
check('fee still comes from the rate card', manual.fee, 10);
check('columns beside them keep their formulas',
  september.getRange(manual.row, 8).getFormula() !== '', true);

// Only one side typed in: the other keeps the sheet's formula.
const half = appendTransaction_({
  action: 'append', clientId: 'manual-2', date: '2026-09-06', type: 'Cash In',
  amount: 100, cashChange: 105
});
check('one typed side, one calculated',
  [september.getRange(half.row, 5).getFormula(), september.getRange(half.row, 6).getFormula() !== ''], ['', true]);
check('typed cash change used verbatim', half.changes.cash, 105);

// Zero is a value; blank means "let the sheet decide".
const zero = appendTransaction_({
  action: 'append', clientId: 'manual-3', date: '2026-09-06', type: 'Fund In',
  amount: 5000, cashChange: 0, emoneyChange: 5000
});
check('zero is written rather than ignored', zero.changes.cash, 0);
check('a zero cash change leaves the cash balance alone', zero.balances.cash, half.balances.cash);

const blank = appendTransaction_({
  action: 'append', clientId: 'manual-4', date: '2026-09-06', type: 'Cash In',
  amount: 100, cashChange: '', emoneyChange: null
});
check('blank falls back to the sheet formulas',
  [september.getRange(blank.row, 5).getFormula() !== '', september.getRange(blank.row, 6).getFormula() !== ''], [true, true]);

/* ------------------------------------------------ list, update, delete */

book.getSheets = () => [august, september, rateSheet(), new FakeSheet('Monthly Summary', 5)];

const listed = listTransactions_({ action: 'list', limit: 5 });
check('list returns the newest first', listed.rows[0].row > listed.rows[1].row, true);
check('list carries what the phone shows',
  Object.keys(listed.rows[0]).sort(),
  ['amount', 'balances', 'cashChange', 'customer', 'date', 'emoneyChange', 'fee', 'notes', 'row', 'type']);
check('list flags cells that are still calculated',
  listed.rows[listed.rows.length - 1].cashChange.calculated, true);
check('list flags cells that were typed in',
  listed.rows.find(r => r.customer === 'Steph').cashChange.calculated, false);

const target = listed.rows.find(r => r.customer === 'Steph');
const updated = updateTransaction_({
  action: 'update', clientId: 'u-1', row: target.row, sheet: 'Sep 2026',
  expect: { date: target.date, amount: target.amount },
  amount: 800, customer: 'Stephanie', notes: 'corrected'
});
check('update rewrites the row it was given', updated.row, target.row);
check('edited fields land in the sheet', [
  september.getRange(target.row, 3).getValue(),
  september.getRange(target.row, 4).getValue(),
  september.getRange(target.row, 11).getValue()
], ['Stephanie', 800, 'corrected']);
check('untouched typed changes stay as they were', updated.changes, { cash: -500, emoney: 510 });
check('fee follows the new amount', updated.fee, feeFor(800, 'Cash Out'));

const stale = (() => {
  try {
    updateTransaction_({ action: 'update', row: target.row, sheet: 'Sep 2026',
      expect: { date: target.date, amount: 500 }, amount: 900 });
  } catch (e) { return e.message; }
})();
check('a row that moved is refused rather than overwritten', /different amount/.test(stale), true);
check('the refused edit changed nothing', september.getRange(target.row, 4).getValue(), 800);

check('a repeated update is not applied twice',
  updateTransaction_({ action: 'update', clientId: 'u-1', row: target.row, amount: 999 }).duplicate, true);
check('and the amount is untouched by the repeat', september.getRange(target.row, 4).getValue(), 800);

const rowsBefore = listTransactions_({ action: 'list', limit: 50 }).rows.length;
const balancesBefore = getConfig_().balances;
const removed = deleteTransaction_({
  action: 'delete', clientId: 'd-1', row: target.row, sheet: 'Sep 2026',
  expect: { date: target.date, amount: 800 }
});
check('delete reports the row it removed', [removed.deleted, removed.row], [true, target.row]);
check('the sheet is one row shorter', listTransactions_({ action: 'list', limit: 50 }).rows.length, rowsBefore - 1);
check('that customer is gone', listTransactions_({ action: 'list', limit: 50 }).rows.some(r => r.customer === 'Stephanie'), false);
check('balances drop the deleted row', removed.balances.cash !== balancesBefore.cash, true);
check('a repeated delete does not remove a second row',
  deleteTransaction_({ action: 'delete', clientId: 'd-1', row: target.row }).duplicate, true);

const firstRow = september.getRange(6, 1).getValue();
const refused = (() => {
  try { deleteTransaction_({ action: 'delete', row: 6, sheet: 'Sep 2026' }); }
  catch (e) { return e.message; }
})();
check('the first row is protected', /first row/.test(refused), true);
check('and it is still there', september.getRange(6, 1).getValue(), firstRow);

const offSheet = (() => {
  try { updateTransaction_({ action: 'update', row: 3, sheet: 'Sep 2026', amount: 5 }); }
  catch (e) { return e.message; }
})();
check('rows above the header are not editable', /not a transaction row/.test(offSheet), true);

check('bad amount rejected', (() => { try { appendTransaction_({ amount: 0, type: 'Cash In', date: '2026-09-06' }); } catch (e) { return e.message; } })(),
  'Amount must be a number greater than zero.');
check('bad date rejected', (() => { try { appendTransaction_({ amount: 5, type: 'Cash In', date: '06/09/2026' }); } catch (e) { return e.message; } })(),
  'Date must be formatted yyyy-mm-dd.');

console.log(failures ? `\n${failures} failing check(s)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
