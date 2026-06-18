import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { STATUS } from '../lib/config.mjs';
import { localToUtc, getTimeZoneOffsetMs, decideRow } from '../lib/schedule.mjs';
import { parseCsv, makeCsvClient } from '../lib/csv_store.mjs';
import { run } from '../send.mjs';

const TZ = 'America/New_York';
const HOUR = 3600000;

// ---------------------------------------------------------------------------
// Timezone conversion (the highest-risk piece)
// ---------------------------------------------------------------------------

test('EDT (summer): 2026-06-18 14:00 ET -> 18:00 UTC', () => {
  assert.equal(localToUtc('2026-06-18 14:00', TZ).toISOString(), '2026-06-18T18:00:00.000Z');
});

test('EST (winter): 2026-01-10 09:00 ET -> 14:00 UTC', () => {
  assert.equal(localToUtc('2026-01-10 09:00', TZ).toISOString(), '2026-01-10T14:00:00.000Z');
});

test('accepts "T" separator and seconds', () => {
  assert.equal(localToUtc('2026-06-21T09:00:00', TZ).toISOString(), '2026-06-21T13:00:00.000Z');
});

test('accepts US / spreadsheet format (Numbers may reformat the cell)', () => {
  assert.equal(localToUtc('6/18/2026 2:00 PM', TZ).toISOString(), '2026-06-18T18:00:00.000Z');
  assert.equal(localToUtc('6/18/2026 14:00', TZ).toISOString(), '2026-06-18T18:00:00.000Z');
  assert.equal(localToUtc('12/31/2026 12:00 AM', TZ).toISOString(), '2026-12-31T05:00:00.000Z');
});

test('offset is -4h in June, -5h in January for ET', () => {
  assert.equal(getTimeZoneOffsetMs(new Date('2026-06-18T18:00:00Z'), TZ), -4 * HOUR);
  assert.equal(getTimeZoneOffsetMs(new Date('2026-01-10T14:00:00Z'), TZ), -5 * HOUR);
});

test('unparseable time -> null', () => {
  assert.equal(localToUtc('not a date', TZ), null);
  assert.equal(localToUtc('', TZ), null);
});

// ---------------------------------------------------------------------------
// decideRow matrix
// ---------------------------------------------------------------------------

const now = new Date('2026-06-18T18:30:00Z'); // 14:30 ET on Boat... er, BBQ day
const graceMs = 2 * HOUR;
const ctx = { now, graceMs, tz: TZ };
const baseRow = (over = {}) => ({
  id: 'r', recipient_name: 'X', recipient_phone: '+15550001111',
  moment: 'm', send_at_local: '2026-06-18 14:00', message: 'hi', status: 'READY', ...over,
});

test('READY + due within grace -> send', () => {
  assert.equal(decideRow(baseRow(), ctx).send, true);
});

test('READY + future -> no send', () => {
  assert.equal(decideRow(baseRow({ send_at_local: '2026-06-18 20:00' }), ctx).send, false);
});

test('READY + missed beyond grace -> no send (needs SEND_NOW)', () => {
  // due 14:00 ET = 18:00Z; now 18:30Z is within 2h. Push due back to 15:00Z (missed 3.5h).
  const r = baseRow({ send_at_local: '2026-06-18 11:00' }); // 15:00Z, 3.5h ago
  assert.equal(decideRow(r, ctx).send, false);
});

test('SEND_NOW -> send regardless of time', () => {
  const r = baseRow({ status: 'SEND_NOW', send_at_local: '2030-01-01 00:00' });
  assert.equal(decideRow(r, ctx).send, true);
});

test('blank message -> never send even if due', () => {
  assert.equal(decideRow(baseRow({ message: '' }), ctx).send, false);
  assert.equal(decideRow(baseRow({ message: '   ' }), ctx).send, false);
  assert.equal(decideRow(baseRow({ status: 'SEND_NOW', message: '' }), ctx).send, false);
});

test('terminal/hold states never send', () => {
  for (const status of ['SENT', 'SENDING', 'SKIP', 'HOLD', 'FAILED']) {
    assert.equal(decideRow(baseRow({ status }), ctx).send, false, `${status} should not send`);
  }
});

test('status is case/space tolerant', () => {
  assert.equal(decideRow(baseRow({ status: ' ready ' }), ctx).send, true);
  assert.equal(decideRow(baseRow({ status: 'sent' }), ctx).send, false);
});

// ---------------------------------------------------------------------------
// Orchestrator: idempotency + verbatim copy + dry-run
// ---------------------------------------------------------------------------

function fakeSheet(rows, { failUpdate = false } = {}) {
  const events = [];
  const store = new Map(); // key -> latest merged updates
  return {
    rows: rows.map((r, i) => ({ _key: i + 2, ...r })),
    update(key, updates) {
      events.push({ type: 'update', key, updates });
      if (failUpdate) return Promise.reject(new Error('store write failed'));
      store.set(key, { ...(store.get(key) || {}), ...updates });
      return Promise.resolve();
    },
    events,
    store,
  };
}

const runOpts = { now, graceMs, tz: TZ, log: () => {} };

test('happy path: reserves SENDING before send, then writes SENT + message_id', async () => {
  const sheet = fakeSheet([baseRow({ id: 'go', message: 'verbatim copy', status: 'READY' })]);
  const sends = [];
  const send = async (args) => { sends.push(args); return { ok: true, messageId: 'MID-1' }; };

  const summary = await run({ sheet, send, ...runOpts });

  assert.equal(summary.sent, 1);
  // text passed through verbatim, service is forced blue by loop.mjs (not here)
  assert.equal(sends[0].text, 'verbatim copy');
  assert.equal(sends[0].recipient, '+15550001111');
  // order: SENDING reservation BEFORE the SENT write
  const updateStatuses = sheet.events.filter(e => e.updates.status).map(e => e.updates.status);
  assert.deepEqual(updateStatuses, [STATUS.SENDING, STATUS.SENT]);
  assert.equal(sheet.store.get(2).result_note, 'MID-1');
});

test('SENT/HOLD/SKIP rows are never sent and never written', async () => {
  const sheet = fakeSheet([
    baseRow({ id: 'a', status: 'SENT' }),
    baseRow({ id: 'b', status: 'HOLD' }),
    baseRow({ id: 'c', status: 'SKIP' }),
  ]);
  let called = 0;
  await run({ sheet, send: async () => { called++; return { ok: true, messageId: 'x' }; }, ...runOpts });
  assert.equal(called, 0);
  assert.equal(sheet.events.length, 0);
});

test('idempotency: an UNCERTAIN send leaves SENDING and never re-sends on a second run', async () => {
  const row = baseRow({ id: 'net', status: 'READY' });
  const sheet = fakeSheet([row]);
  let sendCount = 0;
  const flakySend = async () => { sendCount++; return { ok: false, uncertain: true, error: 'network: timeout' }; };

  await run({ sheet, send: flakySend, ...runOpts });
  assert.equal(sendCount, 1);
  assert.equal(sheet.store.get(2).status, STATUS.SENDING); // reserved, left in-flight

  // Simulate the NEXT cron run reading the same Sheet (now status=SENDING).
  const sheet2 = fakeSheet([{ ...row, status: sheet.store.get(2).status }]);
  await run({ sheet: sheet2, send: flakySend, ...runOpts });
  assert.equal(sendCount, 1, 'must not re-send a SENDING row');
  assert.equal(sheet2.events.length, 0);
});

test('clean rejection -> FAILED, no auto-retry next run', async () => {
  const row = baseRow({ id: 'rej', status: 'READY' });
  const sheet = fakeSheet([row]);
  let sendCount = 0;
  const send = async () => { sendCount++; return { ok: false, uncertain: false, error: 'recipient cannot receive iMessage' }; };

  const summary = await run({ sheet, send, ...runOpts });
  assert.equal(summary.failed, 1);
  assert.equal(sheet.store.get(2).status, STATUS.FAILED);
  assert.match(sheet.store.get(2).result_note, /cannot receive iMessage/);

  const sheet2 = fakeSheet([{ ...row, status: STATUS.FAILED }]);
  await run({ sheet: sheet2, send, ...runOpts });
  assert.equal(sendCount, 1, 'FAILED must not auto-retry');
});

test('lost SENT write-back leaves SENDING (no re-send), never throws', async () => {
  const sheet = fakeSheet([baseRow({ id: 'wb', status: 'READY' })], { failUpdate: true });
  // Reserve write will also fail here -> we must NOT send (safe).
  let sendCount = 0;
  await run({ sheet, send: async () => { sendCount++; return { ok: true, messageId: 'x' }; }, ...runOpts });
  assert.equal(sendCount, 0, 'if we cannot even reserve, we do not send');
});

test('dry-run touches nothing and never calls the provider', async () => {
  const sheet = fakeSheet([
    baseRow({ id: 'a', status: 'READY' }),
    baseRow({ id: 'b', status: 'SEND_NOW' }),
  ]);
  let called = 0;
  const summary = await run({
    sheet, send: async () => { called++; return { ok: true, messageId: 'x' }; },
    dryRun: true, ...runOpts,
  });
  assert.equal(called, 0);
  assert.equal(sheet.events.length, 0);
  assert.equal(summary.sent, 0);
  assert.equal(summary.dryRun, true);
});

// ---------------------------------------------------------------------------
// Local CSV store + append-only ledger (the Mac path)
// ---------------------------------------------------------------------------

test('CSV parser handles quoted commas, quotes, and newlines', () => {
  const csv = 'a,b,c\n1,"x, y","he said ""hi"""\n2,"line1\nline2",z\n';
  const m = parseCsv(csv);
  assert.deepEqual(m[0], ['a', 'b', 'c']);
  assert.deepEqual(m[1], ['1', 'x, y', 'he said "hi"']);
  assert.deepEqual(m[2], ['2', 'line1\nline2', 'z']);
});

function tmpFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-'));
  return { csv: path.join(dir, 'schedule.csv'), ledger: path.join(dir, 'sent-ledger.json') };
}

const CSV_HEADER = 'id,recipient_name,recipient_phone,moment,send_at_local,message,status';

test('ledger status overrides the CSV status column', () => {
  const { csv, ledger } = tmpFiles();
  fs.writeFileSync(csv, `${CSV_HEADER}\nr1,Julia,+15550001111,m,2026-06-18 14:00,hi,READY\n`);
  fs.writeFileSync(ledger, JSON.stringify({ r1: { status: 'SENT', result_note: 'MID' } }));
  const client = makeCsvClient({ csvPath: csv, ledgerPath: ledger });
  assert.equal(client.rows[0].status, 'SENT');
  assert.equal(client.rows[0]._key, 'r1');
});

test('end-to-end CSV: sends once, writes ledger, never re-sends on a second run', async () => {
  const { csv, ledger } = tmpFiles();
  fs.writeFileSync(csv, `${CSV_HEADER}\nr1,Julia,+15550001111,m,2026-06-18 14:00,"hi, there",READY\n`);

  let sendCount = 0;
  const send = async () => { sendCount++; return { ok: true, messageId: 'MID-1' }; };

  // First run: due row -> sends, ledger records SENT.
  await run({ sheet: makeCsvClient({ csvPath: csv, ledgerPath: ledger }), send, ...runOpts });
  assert.equal(sendCount, 1);
  const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(led.r1.status, STATUS.SENT);
  assert.equal(led.r1.result_note, 'MID-1');

  // Second run reads the same files; the ledger makes it SENT -> no resend.
  await run({ sheet: makeCsvClient({ csvPath: csv, ledgerPath: ledger }), send, ...runOpts });
  assert.equal(sendCount, 1, 'must not re-send after ledger marks SENT');

  // The editable CSV was never modified by the system.
  assert.match(fs.readFileSync(csv, 'utf8'), /READY/);
});
