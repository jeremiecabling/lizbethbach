// Automated pre-flight check — run this Wednesday night (and Thursday morning).
// It changes NOTHING. It verifies the parts that are easy to get wrong:
//   1. All required env vars / secrets are present.
//   2. The service account can authenticate and read the Sheet, and the schema is right.
//   3. Every row's ET time converts to the expected UTC instant (so DST math is sane).
//   4. It prints the dry-run decision per row and loudly flags rows that are READY but
//      still have a blank message (those will never send — by design — but you may have
//      meant to fill them).
//   5. (Optional) If LOOPMESSAGE_LOOKUP_KEY is set, it best-effort checks each phone for
//      iMessage capability via the LoopMessage Lookup API. This endpoint/credential must
//      be confirmed when you sign up; failures here are reported, not fatal.

import { loadConfig, STATUS } from './lib/config.mjs';
import { makeSheetClient } from './lib/sheet.mjs';
import { decideRow, localToUtc } from './lib/schedule.mjs';

const cfg = loadConfig(process.env, { requireSendCreds: false });
const graceMs = cfg.graceHours * 3600000;
const now = new Date();

let problems = 0;
const flag = (msg) => { problems++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

console.log('=== PRE-FLIGHT ===');
console.log(`now=${now.toISOString()}  tz=${cfg.tz}  grace=${cfg.graceHours}h  tab=${cfg.sheetTab}`);

// 1. Secrets present (send creds are only needed for live runs, but warn if absent).
console.log('\n[1] Secrets / config');
for (const k of ['SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON']) {
  process.env[k] ? ok(`${k} present`) : flag(`${k} MISSING`);
}
for (const k of ['LOOPMESSAGE_AUTH_KEY', 'LOOPMESSAGE_SECRET_KEY', 'LOOPMESSAGE_SENDER_NAME']) {
  process.env[k] ? ok(`${k} present`) : console.log(`  ! ${k} not set (required for LIVE sends)`);
}

// 2 + 3 + 4. Sheet read, schema, time conversion, decisions.
console.log('\n[2] Google Sheet read + schema');
let sheet;
try {
  sheet = await makeSheetClient(cfg);
  ok(`read ${sheet.rows.length} data row(s); schema OK`);
} catch (err) {
  flag(`could not read Sheet: ${err.message}`);
  console.log(`\nPRE-FLIGHT FAILED with ${problems} problem(s).`);
  process.exit(1);
}

console.log('\n[3] Time conversion + [4] per-row decision');
const phones = new Set();
for (const row of sheet.rows) {
  const status = String(row.status ?? '').trim().toUpperCase();
  const due = localToUtc(row.send_at_local, cfg.tz);
  const dueStr = due ? due.toISOString() : 'UNPARSEABLE';
  const decision = decideRow(row, { now, graceMs, tz: cfg.tz });
  console.log(`  • ${row.id}  ${row.send_at_local} ET -> ${dueStr}  [${status || 'EMPTY'}]  ${decision.send ? 'SEND' : 'skip'}: ${decision.reason}`);

  if (status === STATUS.READY && String(row.message ?? '').trim() === '') {
    flag(`${row.id} is READY but message is BLANK — it will NOT send. Fill copy or set HOLD.`);
  }
  if (status === STATUS.READY && !due) {
    flag(`${row.id} is READY but send_at_local is unparseable: "${row.send_at_local}"`);
  }
  if (/X/i.test(String(row.recipient_phone))) {
    flag(`${row.id} still has a placeholder phone: ${row.recipient_phone}`);
  }
  if (row.recipient_phone) phones.add(String(row.recipient_phone).trim());
}

// 5. Optional iMessage capability lookup (best-effort; endpoint must be confirmed at signup).
console.log('\n[5] iMessage capability lookup (optional)');
if (!process.env.LOOPMESSAGE_LOOKUP_KEY) {
  console.log('  ! LOOPMESSAGE_LOOKUP_KEY not set — skipping. '
    + '(Blue-only is still guaranteed by keeping SMS fallback OFF on the sender.)');
} else {
  for (const phone of phones) {
    if (/X/i.test(phone)) continue;
    try {
      const res = await fetch('https://a.looplookup.com/api/v1/lookup/', {
        method: 'POST',
        headers: {
          Authorization: process.env.LOOPMESSAGE_LOOKUP_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recipient: phone }),
      });
      const json = await res.json().catch(() => null);
      console.log(`  • ${phone}: ${res.status} ${JSON.stringify(json)}`);
    } catch (err) {
      console.log(`  • ${phone}: lookup unavailable (${err.message})`);
    }
  }
}

console.log(`\nPRE-FLIGHT ${problems ? `found ${problems} problem(s)` : 'clean'}.`);
process.exit(problems ? 1 : 0);
