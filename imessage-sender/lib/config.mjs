// Configuration + the controlled status vocabulary.
//
// The system has two pluggable axes, chosen by env:
//   SOURCE    = 'csv'      (default) | 'sheet'     -- where the schedule lives
//   TRANSPORT = 'imessage' (default) | 'loop'      -- how messages are sent
//
// Mac path (default): SOURCE=csv + TRANSPORT=imessage. No external credentials at
// all — the schedule is a local CSV and sending goes through Messages.app.
//
// Cloud path: SOURCE=sheet + TRANSPORT=loop. Needs Google + LoopMessage secrets.
//
// Nothing sensitive is ever hard-coded; cloud secrets come from env only.

export const STATUS = {
  READY: 'READY',       // due now-or-past (within grace) => send
  SEND_NOW: 'SEND_NOW', // send on the next run regardless of time
  SENT: 'SENT',         // terminal success; never re-send (idempotency anchor)
  FAILED: 'FAILED',     // send rejected; do NOT auto-retry; user inspects
  SKIP: 'SKIP',         // never send; leave untouched
  HOLD: 'HOLD',         // never send; default seed state
  // SENDING is an internal, system-written reservation marker. We set it BEFORE
  // sending so a lost status write-back can never cause a re-send. It is treated
  // like FAILED for scheduling: never auto-sent, user inspects.
  SENDING: 'SENDING',
};

export const REQUIRED_COLUMNS = [
  'id', 'recipient_name', 'recipient_phone', 'moment',
  'send_at_local', 'message', 'status', 'sent_at_utc', 'result_note',
];

export function loadConfig(env = process.env, { requireSendCreds = true } = {}) {
  const source = (env.SOURCE && env.SOURCE.trim().toLowerCase()) || 'csv';
  const transport = (env.TRANSPORT && env.TRANSPORT.trim().toLowerCase()) || 'imessage';

  const cfg = {
    source,
    transport,
    tz: (env.SCHEDULE_TZ && env.SCHEDULE_TZ.trim()) || 'America/New_York',
    graceHours: env.GRACE_WINDOW_HOURS == null || env.GRACE_WINDOW_HOURS === ''
      ? 2
      : Number(env.GRACE_WINDOW_HOURS),

    // SOURCE=csv
    csvPath: (env.SCHEDULE_CSV && env.SCHEDULE_CSV.trim()) || 'schedule.csv',
    ledgerPath: (env.SENT_LEDGER && env.SENT_LEDGER.trim()) || 'sent-ledger.json',

    // SOURCE=sheet
    sheetId: env.SHEET_ID,
    sheetTab: (env.SHEET_TAB && env.SHEET_TAB.trim()) || 'Schedule',
    serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON,

    // TRANSPORT=imessage (Mac / Messages.app)
    // Optional: the iMessage handle to send FROM, if you run multiple. Messages picks
    // the default "Start new conversations from" handle when this is blank.
    imessage: {
      fromHandle: (env.IMESSAGE_FROM && env.IMESSAGE_FROM.trim()) || undefined,
    },

    // TRANSPORT=loop (LoopMessage cloud)
    loop: {
      authKey: env.LOOPMESSAGE_AUTH_KEY,
      secretKey: env.LOOPMESSAGE_SECRET_KEY,
      senderName: env.LOOPMESSAGE_SENDER_NAME,
      webhookUrl: (env.LOOP_WEBHOOK_URL && env.LOOP_WEBHOOK_URL.trim()) || undefined,
    },
  };

  const missing = [];
  if (source === 'sheet') {
    if (!cfg.sheetId) missing.push('SHEET_ID');
    if (!cfg.serviceAccountJson) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  } else if (source !== 'csv') {
    throw new Error(`Unknown SOURCE "${source}" (expected csv|sheet)`);
  }

  if (requireSendCreds && transport === 'loop') {
    if (!cfg.loop.authKey) missing.push('LOOPMESSAGE_AUTH_KEY');
    if (!cfg.loop.secretKey) missing.push('LOOPMESSAGE_SECRET_KEY');
    if (!cfg.loop.senderName) missing.push('LOOPMESSAGE_SENDER_NAME');
  }
  if (transport !== 'loop' && transport !== 'imessage') {
    throw new Error(`Unknown TRANSPORT "${transport}" (expected imessage|loop)`);
  }
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
  if (!Number.isFinite(cfg.graceHours) || cfg.graceHours < 0) {
    throw new Error(`GRACE_WINDOW_HOURS must be a non-negative number (got "${env.GRACE_WINDOW_HOURS}")`);
  }
  return cfg;
}
