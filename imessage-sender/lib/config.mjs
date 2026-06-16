// Configuration + the controlled status vocabulary.
//
// All secrets come from environment variables (GitHub Actions Secrets in prod).
// Nothing sensitive is ever hard-coded.

export const STATUS = {
  READY: 'READY',       // due now-or-past (within grace) => send
  SEND_NOW: 'SEND_NOW', // send on the next run regardless of time
  SENT: 'SENT',         // terminal success; never re-send (idempotency anchor)
  FAILED: 'FAILED',     // provider rejected; do NOT auto-retry; user inspects
  SKIP: 'SKIP',         // never send; leave untouched
  HOLD: 'HOLD',         // never send; default seed state
  // SENDING is an internal, system-written reservation marker. We set it BEFORE
  // calling the provider so a lost status write-back can never cause a re-send.
  // It is treated like FAILED for scheduling: never auto-sent, user inspects.
  SENDING: 'SENDING',
};

export const REQUIRED_COLUMNS = [
  'id', 'recipient_name', 'recipient_phone', 'moment',
  'send_at_local', 'message', 'status', 'sent_at_utc', 'result_note',
];

/**
 * Load + validate config from env.
 * @param {Record<string,string|undefined>} env
 * @param {{requireSendCreds?: boolean}} opts  In --dry-run we read the Sheet but
 *   never send, so the LoopMessage creds are not required.
 */
export function loadConfig(env = process.env, { requireSendCreds = true } = {}) {
  const cfg = {
    sheetId: env.SHEET_ID,
    sheetTab: (env.SHEET_TAB && env.SHEET_TAB.trim()) || 'Schedule',
    tz: (env.SCHEDULE_TZ && env.SCHEDULE_TZ.trim()) || 'America/New_York',
    graceHours: env.GRACE_WINDOW_HOURS == null || env.GRACE_WINDOW_HOURS === ''
      ? 2
      : Number(env.GRACE_WINDOW_HOURS),
    serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON,
    loop: {
      authKey: env.LOOPMESSAGE_AUTH_KEY,
      secretKey: env.LOOPMESSAGE_SECRET_KEY,
      senderName: env.LOOPMESSAGE_SENDER_NAME,
      webhookUrl: (env.LOOP_WEBHOOK_URL && env.LOOP_WEBHOOK_URL.trim()) || undefined,
    },
  };

  const missing = [];
  if (!cfg.sheetId) missing.push('SHEET_ID');
  if (!cfg.serviceAccountJson) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (requireSendCreds) {
    if (!cfg.loop.authKey) missing.push('LOOPMESSAGE_AUTH_KEY');
    if (!cfg.loop.secretKey) missing.push('LOOPMESSAGE_SECRET_KEY');
    if (!cfg.loop.senderName) missing.push('LOOPMESSAGE_SENDER_NAME');
  }
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
  if (!Number.isFinite(cfg.graceHours) || cfg.graceHours < 0) {
    throw new Error(`GRACE_WINDOW_HOURS must be a non-negative number (got "${env.GRACE_WINDOW_HOURS}")`);
  }
  return cfg;
}
