# Love Island Bach Weekend — Scheduled iMessage Sender

Sends a handful of pre-written, **blue iMessage** texts to specific bridesmaids at
specific ET clock times across the weekend (Thu Jun 18 – Sun Jun 21, 2026, Miami).

- **Schedule + source of truth:** one Google Sheet tab. You edit the Sheet; the next
  5-minute run obeys it. No redeploys.
- **Runtime:** GitHub Actions cron `*/5 * * * *` (+ a manual **Run workflow** button).
- **Provider:** [LoopMessage](https://loopmessage.com) (true blue iMessage).
- **Language:** Node (ESM, `.mjs`), **zero runtime dependencies** — native `fetch`,
  `crypto`, and `Intl`. Nothing to `npm install`, so nothing to break in CI.

The system never writes message copy. **You** author every message in the Sheet; the
code treats message text as an opaque string and only schedules/sends/records it.

---

## How it decides what to send (the rules)

On each run it reads every row and, per row:

| Sheet `status` | Behavior |
|---|---|
| `HOLD` | Never send. (Default seed state.) |
| `SKIP` | Never send. |
| `READY` | Send **if** `send_at_local` is now-or-past **and** within the grace window. |
| `SEND_NOW` | Send on the next run **regardless** of time. |
| `SENT` | Never send again (idempotency anchor). |
| `FAILED` | Never auto-retry. Inspect, then reset to `READY` to try again. |
| `SENDING` | Internal reservation (see below). Never auto-sent; inspect manually. |
| _blank `message`_ | Never send, even if the time has passed. Treated as "not ready". |

**Grace window = 2 hours** (`GRACE_WINDOW_HOURS`). Rationale: GitHub's scheduler can
lag or skip a tick under load, so a slot missed by one run still goes out — but a row
left `READY` from yesterday won't suddenly fire. Anything older than 2h needs an
explicit `SEND_NOW`.

**Timezone:** every `send_at_local` is **America/New_York** wall-clock. The runner is
UTC; the code converts explicitly and DST-correctly (June = EDT, −4h). It never trusts
the runner's local clock.

### Idempotency (exactly-once, the part that matters most)

1. A row in any terminal/hold/in-flight state is never sent.
2. **Before** calling LoopMessage, the row is reserved: `status → SENDING`. If that
   write fails, nothing was sent and the row is retried next run.
3. On accept, `status → SENT` + the provider `message_id` is recorded. If that
   write-back is lost, the row stays `SENDING` and is **never auto-re-sent**.
4. Network error / timeout / 5xx → **UNCERTAIN**: the row is left `SENDING` for you to
   inspect; it is never auto-retried.
5. A clean rejection (4xx / `success:false`, e.g. recipient can't receive iMessage) →
   `FAILED` with the reason. Nothing was sent.

Net effect: **at-most-once-perceived**. We prefer "skip if uncertain" over "send again".

### Blue, never green

We send with `service: "imessage"` and **never enable SMS fallback** on the sender.
SMS fallback is a separately-purchased LoopMessage add-on; with it off, a message that
can't be delivered as iMessage simply fails (→ `FAILED`) instead of silently going out
as a green SMS.

---

## Setup — do these in order

### 1) LoopMessage (do this first; it has lead time)

1. Sign up at <https://loopmessage.com>.
2. Buy a **shared sender name** (cheapest path that allows outbound-first sending).
   Do **not** buy a dedicated/branded sender for this weekend — those take ~2 business
   days to verify + up to 48h to propagate and won't be ready in time.
3. **Do NOT enable SMS fallback / RCS** on the sender (keeps it blue-only).
4. From the dashboard, grab your **Authorization key** and **Secret key**, and note the
   exact **sender name** string.
5. Pricing: entry tiers start around **$15.99/mo**; a free **sandbox** exists but
   requires each recipient to text the LoopMessage number once first. For ~9 messages
   the per-message cost is negligible — the only real cost is one month of the cheapest
   plan. Confirm the exact figure at checkout.

### 2) Google service account + Sheet

1. In Google Cloud Console, create a **service account** and a **JSON key**.
2. Enable the **Google Sheets API** for that project.
3. Create (or use) one Google Sheet. Share it with the service account's email
   (`...@...iam.gserviceaccount.com`) as **Editor**. The account has access to **only
   this Sheet** — nothing else.
4. Copy the Sheet ID from its URL: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.
5. Name the tab `Schedule` (or set `SHEET_TAB`).

**Seed the rows** (header + 9 starter rows, blank copy, `HOLD`):

```bash
cd imessage-sender
export SHEET_ID=...                         # from the Sheet URL
export GOOGLE_SERVICE_ACCOUNT_JSON="$(cat path/to/key.json)"
npm run seed                                # add --force to overwrite an existing tab
```

Then in the Sheet: fill **real phone numbers** (E.164, `+1…`) and your **message copy**,
and flip each row from `HOLD` to `READY` when it's ready.

### 3) GitHub configuration

**Repository → Settings → Secrets and variables → Actions.**

Secrets (exact names):

| Secret | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Entire contents of the service-account JSON key |
| `LOOPMESSAGE_AUTH_KEY` | LoopMessage Authorization key |
| `LOOPMESSAGE_SECRET_KEY` | LoopMessage Secret key |
| `LOOPMESSAGE_SENDER_NAME` | Your exact shared sender name |

Repository **Variables** (not secret):

| Variable | Value |
|---|---|
| `SHEET_ID` | The Google Sheet ID |
| `SHEET_TAB` | Tab name (optional; defaults to `Schedule`) |

No credentials live in the repo or the code.

---

## Testing

```bash
cd imessage-sender
npm test          # 18 unit tests: timezone math, decision matrix, idempotency, dry-run
```

### Dry run (this is how you test Thursday morning)

Prints exactly what **would** send and touches nothing:

```bash
export SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON="$(cat key.json)"
npm run dry-run
```

Or from GitHub: **Actions → iMessage Sender → Run workflow → dry_run = true**.

---

## Override cheat-sheet (edit Sheet → wait ≤5 min)

| You want to… | Set `status` to… | Notes |
|---|---|---|
| Send something right now | `SEND_NOW` | Ignores the scheduled time. |
| Stop a message from going out | `SKIP` or `HOLD` | Safe anytime before it sends. |
| Re-time a message | keep `READY`, edit `send_at_local` | ET wall-clock, `YYYY-MM-DD HH:mm`. |
| Retry a failure | `FAILED` → `READY` | After you've fixed the cause. |
| Arm a held message | `HOLD` → `READY` | Make sure `message` is filled first. |

A blank `message` cell is always treated as "not ready" — it will never send.

---

## Files

```
imessage-sender/
  send.mjs            orchestrator (read → decide → send → write back)
  seed.mjs            one-time: write header + 9 starter rows into the Sheet
  preflight.mjs       automated Wednesday-night check (changes nothing)
  rows.seed.json      the 9 starter rows (edit before seeding)
  lib/config.mjs      env + status vocabulary
  lib/schedule.mjs    ET↔UTC conversion + per-row send decision (pure)
  lib/google.mjs      service-account JWT + Sheets REST
  lib/sheet.mjs       Sheet → { rows, update } adapter
  lib/loop.mjs        LoopMessage send client (blue-only)
  test/run.test.mjs   unit tests
.github/workflows/imessage-sender.yml
```

See `PREFLIGHT.md` for the Wednesday-night checklist.
