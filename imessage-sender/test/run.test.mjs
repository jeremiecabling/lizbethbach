import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STATUS } from '../lib/config.mjs';
import { localToUtc, getTimeZoneOffsetMs, decideRow } from '../lib/schedule.mjs';
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
  const store = new Map(); // rowNumber -> latest merged updates
  return {
    rows: rows.map((r, i) => ({ _rowNumber: i + 2, ...r })),
    update(rowNumber, updates) {
      events.push({ type: 'update', rowNumber, updates });
      if (failUpdate) return Promise.reject(new Error('sheet write failed'));
      store.set(rowNumber, { ...(store.get(rowNumber) || {}), ...updates });
      return Promise.resolve();
    },
    events,
    store,
  };
}

const loopCreds = { authKey: 'a', secretKey: 's', senderName: 'Sender' };
const runOpts = { now, graceMs, tz: TZ, loopCreds, log: () => {} };

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
