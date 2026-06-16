// Orchestrator: read Sheet -> decide due rows -> send blue -> write status back.
//
// Idempotency is the whole game. The exactly-once design:
//   1. decideRow() refuses to send anything in a terminal/hold/in-flight state.
//   2. Before calling the provider we RESERVE the row (status -> SENDING). If that
//      write fails we did not send, so the row stays as-is and is retried next run.
//   3. On a clean accept we write SENT + message_id. If THAT write-back is lost, the
//      row remains SENDING and is never auto-re-sent (at-most-once-perceived).
//   4. Network/timeout/5xx => UNCERTAIN: leave the row SENDING for manual inspection;
//      never auto-retry. We prefer "skip if uncertain" over "send again".
//   5. A clean rejection (4xx / success:false) => FAILED (nothing was sent); the user
//      can reset it to READY to try again.
//
// `run` takes injected dependencies so the full decision loop is unit-tested offline.

import { STATUS, loadConfig } from './lib/config.mjs';
import { decideRow } from './lib/schedule.mjs';
import { makeSheetClient } from './lib/sheet.mjs';
import { sendImessage } from './lib/loop.mjs';

export async function run({
  sheet,            // { rows, update(rowNumber, updates) }
  send,             // async ({ ...loopCreds, recipient, text, webhookUrl }) -> result
  now,              // Date
  graceMs,
  tz,
  loopCreds,        // { authKey, secretKey, senderName }
  webhookUrl,
  dryRun = false,
  log = console.log,
}) {
  const summary = { considered: 0, sent: 0, failed: 0, skipped: 0, reserved: 0, dryRun: !!dryRun };

  for (const row of sheet.rows) {
    summary.considered++;
    const tag = `[${row.id}] ${row.recipient_name} — "${row.moment}"`;
    const decision = decideRow(row, { now, graceMs, tz });

    if (!decision.send) {
      summary.skipped++;
      log(`SKIP   ${tag} :: ${decision.reason}`);
      continue;
    }

    if (dryRun) {
      log(`WOULD-SEND ${tag} @ ${row.send_at_local} ${tz} -> ${row.recipient_phone} `
        + `:: "${preview(row.message)}"  (${decision.reason})`);
      continue;
    }

    // --- RESERVE before sending (idempotency anchor) ---
    try {
      await sheet.update(row._rowNumber, { status: STATUS.SENDING });
      summary.reserved++;
    } catch (err) {
      // Reserve failed -> we have NOT sent. Leave the row untouched; retried next run.
      summary.skipped++;
      log(`SKIP   ${tag} :: reserve write failed, not sending this run: ${err.message}`);
      continue;
    }

    let res;
    try {
      res = await send({
        ...loopCreds,
        webhookUrl,
        recipient: row.recipient_phone,
        text: row.message, // verbatim, opaque
      });
    } catch (err) {
      res = { ok: false, uncertain: true, error: `unexpected: ${err.message}` };
    }

    if (res.ok) {
      summary.sent++;
      await safeUpdate(sheet, row._rowNumber, {
        status: STATUS.SENT,
        sent_at_utc: new Date(now).toISOString(),
        result_note: String(res.messageId),
      }, log, tag);
      log(`SENT   ${tag} :: message_id=${res.messageId}`);
    } else if (res.uncertain) {
      // Leave SENDING (already reserved). No auto-retry; flag for the user.
      summary.failed++;
      await safeUpdate(sheet, row._rowNumber, { result_note: `UNCERTAIN: ${res.error}` }, log, tag);
      log(`UNCERT ${tag} :: left SENDING (inspect manually) :: ${res.error}`);
    } else {
      summary.failed++;
      await safeUpdate(sheet, row._rowNumber, {
        status: STATUS.FAILED,
        result_note: res.error,
      }, log, tag);
      log(`FAILED ${tag} :: ${res.error}`);
    }
  }

  log(`\nDONE  considered=${summary.considered} sent=${summary.sent} `
    + `failed/uncertain=${summary.failed} skipped=${summary.skipped} dryRun=${summary.dryRun}`);
  return summary;
}

// Write-back that never throws: if the Sheet write fails after a send we must not
// crash (which could look like a fresh failure next run). We log and move on; the
// reservation (SENDING) already protects against a re-send.
async function safeUpdate(sheet, rowNumber, updates, log, tag) {
  try {
    await sheet.update(rowNumber, updates);
  } catch (err) {
    log(`WARN   ${tag} :: status write-back failed ${JSON.stringify(updates)}: ${err.message}`);
  }
}

function preview(message) {
  const t = String(message ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

// ---- CLI entry ----
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = loadConfig(process.env, { requireSendCreds: !dryRun });
  const graceMs = cfg.graceHours * 3600000;

  console.log(`iMessage sender — ${dryRun ? 'DRY RUN' : 'LIVE'} | tz=${cfg.tz} | grace=${cfg.graceHours}h | now=${new Date().toISOString()}`);

  const sheet = await makeSheetClient(cfg);
  await run({
    sheet,
    send: (args) => sendImessage(args),
    now: new Date(),
    graceMs,
    tz: cfg.tz,
    loopCreds: {
      authKey: cfg.loop.authKey,
      secretKey: cfg.loop.secretKey,
      senderName: cfg.loop.senderName,
    },
    webhookUrl: cfg.loop.webhookUrl,
    dryRun,
    log: console.log,
  });
}
