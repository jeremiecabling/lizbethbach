// Local schedule store: a CSV you edit + a separate append-only JSON ledger the
// system owns. This split is deliberate and is what makes the Mac path safe:
//
//   * schedule.csv      -- YOU edit (times, copy, status overrides). The system
//                          only READS it. So nothing the system does can ever be
//                          clobbered by you having the file open in Numbers, and
//                          nothing you do can wipe a "SENT" marker and cause a resend.
//   * sent-ledger.json  -- the system owns it. Once a row is reserved/sent/failed,
//                          the ledger's status wins over the CSV. Writes are atomic
//                          (temp file + rename) so a crash mid-write can't corrupt it.
//
// The effective status fed to the scheduler is: ledger status if the id is in the
// ledger, otherwise the CSV's status column. That means a SENT/SENDING/FAILED row is
// governed by the ledger and can never be re-sent by editing the CSV.

import fs from 'node:fs';
import path from 'node:path';

const CSV_REQUIRED = ['id', 'recipient_name', 'recipient_phone', 'moment', 'send_at_local', 'message', 'status'];

/** Minimal RFC4180 CSV parser: handles quoted fields, embedded commas/quotes/newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  // flush last field/row (unless trailing newline already pushed an empty row)
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // drop a single trailing empty row
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

function readLedger(ledgerPath) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch {
    return {}; // missing or unreadable -> empty ledger (no row has been touched yet)
  }
}

function writeLedgerAtomic(ledgerPath, ledger) {
  const dir = path.dirname(path.resolve(ledgerPath));
  const tmp = path.join(dir, `.${path.basename(ledgerPath)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, ledgerPath); // atomic on same filesystem
}

export function makeCsvClient(cfg) {
  const text = fs.readFileSync(cfg.csvPath, 'utf8');
  const matrix = parseCsv(text);
  if (!matrix.length) throw new Error(`CSV "${cfg.csvPath}" is empty`);

  const header = matrix[0].map((h) => String(h).trim());
  const idx = {};
  header.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });
  const missing = CSV_REQUIRED.filter((c) => idx[c] == null);
  if (missing.length) throw new Error(`CSV "${cfg.csvPath}" missing column(s): ${missing.join(', ')}`);

  const ledger = readLedger(cfg.ledgerPath);

  const rows = [];
  for (let i = 1; i < matrix.length; i++) {
    const raw = matrix[i] || [];
    const obj = {};
    for (const col of header) obj[col] = (raw[idx[col]] ?? '').trim();
    const id = obj.id;
    if (id === '') continue; // ignore blank rows
    const led = ledger[id];
    // Ledger status (if any) overrides the CSV status column.
    obj.status = led && led.status ? led.status : obj.status;
    obj.sent_at_utc = led && led.sent_at_utc ? led.sent_at_utc : (obj.sent_at_utc || '');
    obj.result_note = led && led.result_note ? led.result_note : (obj.result_note || '');
    obj._key = id;
    rows.push(obj);
  }

  return {
    rows,
    update(id, updates) {
      const current = ledger[id] || {};
      ledger[id] = { ...current, ...updates, updated_at_utc: new Date().toISOString() };
      writeLedgerAtomic(cfg.ledgerPath, ledger);
      return Promise.resolve();
    },
  };
}
