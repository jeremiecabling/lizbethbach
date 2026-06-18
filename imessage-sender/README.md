# Love Island Bach Weekend — Scheduled iMessage Sender

Sends a handful of pre-written, **blue iMessage** texts to specific people at specific
ET clock times across the weekend (Thu Jun 18 – Sun Jun 21, 2026, Miami).

There are two ways to run it. **The Mac path is the one to use** — it's free, instant,
needs no signup/approval, and is guaranteed blue because it sends through a real
Messages.app account. The cloud path (Google Sheet + LoopMessage) is kept as an option.

| | **Mac path (default)** | Cloud path |
|---|---|---|
| Schedule lives in | `schedule.csv` (you edit) | a Google Sheet |
| Sends via | Messages.app (AppleScript) | LoopMessage API |
| Scheduler | macOS `launchd` (every 5 min) | GitHub Actions cron |
| Cost / setup | $0, minutes | ~$16+/mo, signup + approval lead time |
| Config | `SOURCE=csv TRANSPORT=imessage` (defaults) | `SOURCE=sheet TRANSPORT=loop` |

The system **never writes message copy.** You author every message; the code treats it
as an opaque string and only schedules / sends / records it.

---

## Mac quick start (do this today)

You need: a Mac signed into iMessage that can stay awake all weekend, and Node 20+
(`node -v`; install from <https://nodejs.org> if missing).

### 1. Pick the sender identity + brand it with a vCard

You don't need a new Apple ID. Use your existing one, and (optionally) add a fresh email
to it so texts don't show your usual number:

- Add an email (e.g. `villa@yourdomain.com`) to your Apple ID at
  <https://account.apple.com> → verify it (verification goes to that inbox — no phone
  number needed). In **Messages → Settings → iMessage**, check that email under *Send &
  Receive* and set **"Start new conversations from"** to it.
- Make a themed contact card so your texts display under a name + photo:
  ```bash
  cd imessage-sender
  node vcard.mjs --name "Love Island Villa 💌" --handle villa@yourdomain.com --photo ./villa.jpg
  ```
  AirDrop/iMessage the resulting `contact.vcf` to each recipient and have them save it.
  Sending it first also "warms" the conversation, which makes automated sends reliable.

### 2. Fill in the schedule

Edit `schedule.csv`. Columns: `id, recipient_name, recipient_phone, moment,
send_at_local, message, status`.

- `recipient_phone` — the recipient's iMessage handle (phone in `+1…`, or an email).
- `send_at_local` — ET wall-clock, `YYYY-MM-DD HH:mm`. Keep it as plain text. (If you
  edit in Numbers, format that column as **Text** so it isn't reformatted.)
- `message` — your copy. If it contains a comma, wrap the cell in quotes (Numbers does
  this automatically on export).
- `status` — start everything at `HOLD`; flip to `READY` when a row is good to go.

### 3. Test with a dry run (sends nothing)

```bash
node send.mjs --dry-run     # prints exactly what WOULD send, right now
node preflight.mjs          # full check: schema, time math, Messages reachable
```

Do a real one-message smoke test: add a row targeting **your own** number, status
`SEND_NOW`, run `node send.mjs`. The first real send triggers a macOS prompt to let the
script control Messages — click **OK**. Confirm you get a blue bubble.

### 4. Schedule it + keep the Mac awake

```bash
bash macos/install.sh       # launchd agent: runs the sender every 5 min
bash macos/keep-awake.sh    # leave this Terminal window open all weekend
```

Logs: `~/Library/Logs/imessage-sender.out.log`. To stop: `bash macos/uninstall.sh`.

---

## How it decides what to send (the rules)

Each run reads every row and, per row:

| `status` | Behavior |
|---|---|
| `HOLD` | Never send. (Default.) |
| `SKIP` | Never send. |
| `READY` | Send **if** `send_at_local` is now-or-past **and** within the grace window. |
| `SEND_NOW` | Send on the next run **regardless** of time. |
| `SENT` | Never send again. |
| `FAILED` | Never auto-retry. Inspect, then reset to `READY` to try again. |
| `SENDING` | Internal reservation; never auto-sent (see idempotency). |
| _blank `message`_ | Never send, even if the time passed. "Not ready." |

**Grace window = 2h** (`GRACE_WINDOW_HOURS`): a slot missed by a run (or because the Mac
was briefly asleep) still fires; a row left `READY` from yesterday does not. Older than
2h needs `SEND_NOW`.

**Timezone:** every `send_at_local` is **America/New_York**, converted DST-correctly. It
never trusts the machine's local clock.

### Idempotency (exactly-once)

On the Mac path the schedule and the send-record are **separate files on purpose**:
- `schedule.csv` — you edit; the system only reads it.
- `sent-ledger.json` — the system owns it; once a row is reserved/sent/failed, the
  ledger's status wins. Writes are atomic.

So even if you have the CSV open in Numbers, nothing you do can wipe a `SENT` marker and
cause a resend. The send flow: reserve (`SENDING`) → send → record `SENT`. A lost record
leaves the row `SENDING` and it is **never auto-re-sent**; a clean failure → `FAILED`; a
timeout → left `SENDING` for you to inspect. We prefer "skip if uncertain" over "resend".

### Blue, never green

We target the **iMessage service** explicitly. If a handle can't receive iMessage, the
send errors and the row is marked `FAILED` — it can never silently go out as green SMS.

---

## Override cheat-sheet (edit `schedule.csv` → wait ≤5 min)

| You want to… | Set `status` to… | Notes |
|---|---|---|
| Send something right now | `SEND_NOW` | Ignores the scheduled time. |
| Stop a message | `SKIP` or `HOLD` | Safe anytime before it sends. |
| Re-time a message | keep `READY`, edit `send_at_local` | ET, `YYYY-MM-DD HH:mm`. |
| Retry a failure | `FAILED` → `READY` | After fixing the cause; then delete its entry from `sent-ledger.json` if it's there. |
| Arm a held message | `HOLD` → `READY` | Fill `message` first. |

A blank `message` is always "not ready" — it never sends.

---

## Tests

```bash
npm test     # 22 unit tests: timezone math, decision matrix, idempotency, CSV+ledger, dry-run
```

---

## Cloud path (alternative)

If you'd rather edit from your phone via Google Sheets and send via LoopMessage:

1. Create a Google service account + JSON key, enable the Sheets API, share one Sheet
   with the service-account email as Editor. `npm run seed` writes the 9 starter rows.
2. Sign up for LoopMessage, buy a **shared sender name**, and **do not enable SMS
   fallback** (keeps it blue-only).
3. Set env: `SOURCE=sheet TRANSPORT=loop` plus `SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`,
   `LOOPMESSAGE_AUTH_KEY`, `LOOPMESSAGE_SECRET_KEY`, `LOOPMESSAGE_SENDER_NAME`.
4. `.github/workflows/imessage-sender.yml` runs it every 5 min (secrets wired as above).

Note: LoopMessage senders have onboarding lead time (dedicated ~2 business days), which
is why the Mac path is the right call for a this-weekend event.

---

## Files

```
imessage-sender/
  send.mjs            orchestrator (read → decide → send → record). Picks store+transport.
  schedule.csv        the 9 rows you edit (Mac path)
  sent-ledger.json    runtime SENT record (created on first send; git-ignored)
  vcard.mjs           generate a themed .vcf contact card
  preflight.mjs       automated pre-flight check (changes nothing)
  seed.mjs            cloud path only: write 9 rows into a Google Sheet
  rows.seed.json      cloud-path seed data
  lib/config.mjs      config + status vocabulary + source/transport selection
  lib/schedule.mjs    ET↔UTC conversion + per-row decision (pure)
  lib/csv_store.mjs   schedule.csv + ledger adapter (Mac path)
  lib/imessage_mac.mjs  Messages.app sender via osascript (Mac path)
  lib/sheet.mjs       Google Sheet adapter (cloud path)
  lib/google.mjs      service-account JWT + Sheets REST (cloud path)
  lib/loop.mjs        LoopMessage send client (cloud path)
  macos/              send-imessage.applescript, run.sh, install.sh, uninstall.sh, keep-awake.sh
  test/run.test.mjs   unit tests
.github/workflows/imessage-sender.yml   (cloud path scheduler)
```

See `PREFLIGHT.md` for the night-before checklist.
