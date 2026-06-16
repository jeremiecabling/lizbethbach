// Timezone + scheduling decision logic. PURE (no I/O) so it is fully unit-tested.
//
// CRITICAL: all `send_at_local` values are America/New_York (Miami) wall-clock.
// The GitHub Actions runner is UTC. We convert explicitly using the Intl API and
// NEVER trust the runner's local clock.

import { STATUS } from './config.mjs';

/**
 * How far ahead of UTC the given zone is, AT the given instant (DST-correct).
 * Returns ms such that: (wall-clock fields rendered in tz, read as if UTC) - instant.
 * For America/New_York this is -4h in EDT (summer) and -5h in EST (winter).
 */
export function getTimeZoneOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const hour = p.hour === '24' ? 0 : Number(p.hour); // guard against legacy h24
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/**
 * Convert an ET wall-clock string ("YYYY-MM-DD HH:mm" or with "T"/seconds) into a
 * real UTC instant. Returns a Date, or null if the string is not parseable.
 */
export function localToUtc(localStr, tz) {
  const m = String(localStr ?? '').trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s] = m;
  // Step 1: pretend the wall-clock fields are UTC.
  const wallAsUtc = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, s ? +s : 0);
  // Step 2: subtract the zone offset at that approximate instant.
  const off1 = getTimeZoneOffsetMs(new Date(wallAsUtc), tz);
  let utc = wallAsUtc - off1;
  // Step 3: re-check at the corrected instant (covers DST-boundary wall times).
  const off2 = getTimeZoneOffsetMs(new Date(utc), tz);
  if (off2 !== off1) utc = wallAsUtc - off2;
  return new Date(utc);
}

/**
 * Decide whether a single row should send right now.
 * Returns { send: boolean, reason: string, dueUtc?: Date }.
 *
 * Rules (implemented exactly per the brief):
 *  - SENT/SENDING/SKIP/HOLD/FAILED  -> never auto-send.
 *  - blank message                  -> never send (not ready), even if time passed.
 *  - SEND_NOW                       -> send regardless of time.
 *  - READY + due (now-or-past) AND within the grace window -> send.
 *  - READY + future                 -> wait.
 *  - READY + missed by > grace      -> do NOT fire (use SEND_NOW); avoids day-late blasts.
 */
export function decideRow(row, { now, graceMs, tz }) {
  const status = String(row.status ?? '').trim().toUpperCase();
  const hasCopy = String(row.message ?? '').trim() !== '';

  // Terminal / hold states: never auto-send.
  if (status === STATUS.SENT) return { send: false, reason: 'already SENT' };
  if (status === STATUS.SENDING) {
    return { send: false, reason: 'in-flight SENDING — manual inspect, no auto-retry' };
  }
  if (status === STATUS.SKIP) return { send: false, reason: 'SKIP' };
  if (status === STATUS.HOLD) return { send: false, reason: 'HOLD' };
  if (status === STATUS.FAILED) {
    return { send: false, reason: 'FAILED — no auto-retry; reset to READY to resend' };
  }

  // We never send without author-provided copy.
  if (!hasCopy) return { send: false, reason: 'blank message — not ready' };

  if (status === STATUS.SEND_NOW) {
    return { send: true, reason: 'SEND_NOW override' };
  }

  if (status === STATUS.READY) {
    const dueUtc = localToUtc(row.send_at_local, tz);
    if (!dueUtc) {
      return { send: false, reason: `unparseable send_at_local: "${row.send_at_local}"` };
    }
    const delta = now.getTime() - dueUtc.getTime();
    if (delta < 0) {
      return { send: false, reason: `not due yet (due ${dueUtc.toISOString()})`, dueUtc };
    }
    if (delta > graceMs) {
      const h = (delta / 3600000).toFixed(1);
      return {
        send: false,
        reason: `missed by ${h}h (> grace ${graceMs / 3600000}h) — use SEND_NOW to force`,
        dueUtc,
      };
    }
    return { send: true, reason: `due (${dueUtc.toISOString()})`, dueUtc };
  }

  return { send: false, reason: `unknown status "${row.status}"` };
}
