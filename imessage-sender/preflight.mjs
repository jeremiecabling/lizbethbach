// Automated pre-flight check — run before the weekend (and again that morning).
// It changes NOTHING. It verifies the parts that are easy to get wrong:
//   1. Config loads (and, for the cloud path, secrets are present).
//   2. The schedule store reads (CSV file or Google Sheet) and the schema is right.
//   3. Every send_at_local converts to the expected UTC instant (DST sanity).
//   4. The per-row send decision, loudly flagging rows that are READY but have a blank
//      message or a placeholder phone.
//   5. Mac path: confirms osascript + Messages.app are present (no message is sent).

import { loadConfig, STATUS } from './lib/config.mjs';
import { decideRow, localToUtc } from './lib/schedule.mjs';
import { execFile } from 'node:child_process';

const cfg = loadConfig(process.env, { requireSendCreds: false });
const graceMs = cfg.graceHours * 3600000;
const now = new Date();

let problems = 0;
const flag = (m) => { problems++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

console.log('=== PRE-FLIGHT ===');
console.log(`now=${now.toISOString()}  source=${cfg.source}  transport=${cfg.transport}  tz=${cfg.tz}  grace=${cfg.graceHours}h`);

// [1] config / secrets
console.log('\n[1] Config');
ok(`source=${cfg.source}, transport=${cfg.transport}`);
if (cfg.transport === 'loop') {
  for (const k of ['LOOPMESSAGE_AUTH_KEY', 'LOOPMESSAGE_SECRET_KEY', 'LOOPMESSAGE_SENDER_NAME']) {
    process.env[k] ? ok(`${k} present`) : console.log(`  ! ${k} not set (required for LIVE loop sends)`);
  }
}

// [2] store read + schema
console.log(`\n[2] Read schedule (${cfg.source})`);
let store;
try {
  if (cfg.source === 'sheet') {
    const { makeSheetClient } = await import('./lib/sheet.mjs');
    store = await makeSheetClient(cfg);
  } else {
    const { makeCsvClient } = await import('./lib/csv_store.mjs');
    store = makeCsvClient(cfg);
  }
  ok(`read ${store.rows.length} row(s); schema OK`);
} catch (err) {
  flag(`could not read schedule: ${err.message}`);
  console.log(`\nPRE-FLIGHT FAILED with ${problems} problem(s).`);
  process.exit(1);
}

// [3] + [4] time conversion and per-row decision
console.log('\n[3] Time conversion + [4] per-row decision');
for (const row of store.rows) {
  const status = String(row.status ?? '').trim().toUpperCase();
  const due = localToUtc(row.send_at_local, cfg.tz);
  const dueStr = due ? due.toISOString() : 'UNPARSEABLE';
  const d = decideRow(row, { now, graceMs, tz: cfg.tz });
  console.log(`  • ${row.id}  ${row.send_at_local} ET -> ${dueStr}  [${status || 'EMPTY'}]  ${d.send ? 'SEND' : 'skip'}: ${d.reason}`);

  if (status === STATUS.READY && String(row.message ?? '').trim() === '') {
    flag(`${row.id} is READY but message is BLANK — it will NOT send. Fill copy or set HOLD.`);
  }
  if (status === STATUS.READY && !due) {
    flag(`${row.id} is READY but send_at_local is unparseable: "${row.send_at_local}"`);
  }
  if (/X/i.test(String(row.recipient_phone))) {
    flag(`${row.id} still has a placeholder handle: ${row.recipient_phone}`);
  }
}

// [5] transport reachability
console.log('\n[5] Transport check');
if (cfg.transport === 'imessage') {
  await new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application "Messages" to get name'], { timeout: 10000 }, (err, stdout) => {
      if (err) flag(`osascript/Messages not reachable: ${String(err.message).slice(0, 200)} `
        + `(run on the Mac, and approve the Automation prompt)`);
      else ok(`Messages.app reachable via osascript (${String(stdout).trim()})`);
      resolve();
    });
  });
  console.log('  · Blue-only is guaranteed: we target the iMessage service; non-iMessage handles error out (FAILED), never green.');
} else {
  console.log('  · loop transport: blue-only relies on NOT enabling SMS fallback on the sender.');
}

console.log(`\nPRE-FLIGHT ${problems ? `found ${problems} problem(s)` : 'clean'}.`);
process.exit(problems ? 1 : 0);
