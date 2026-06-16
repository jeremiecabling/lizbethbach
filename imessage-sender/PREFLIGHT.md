# Pre-flight checklist — run Wednesday night (Jun 17)

Goal: be certain the unattended sender will fire correctly Thursday with no one watching.
Most of this is automated by `npm run preflight`; the rest is two-minute manual checks.

## A. Automated check

```bash
cd imessage-sender
export SHEET_ID=...                              # repo variable value
export GOOGLE_SERVICE_ACCOUNT_JSON="$(cat key.json)"
# optional, only if you have it: export LOOPMESSAGE_LOOKUP_KEY=...
npm run preflight
```

`preflight` verifies (and changes nothing):
- required env/secrets are present,
- the service account can read the Sheet and the schema is correct,
- every `send_at_local` converts to the expected UTC instant (DST sanity),
- the per-row send decision, and it **loudly flags** any row that is `READY` but has a
  blank message or a placeholder phone.

It exits non-zero if it finds a problem.

## B. LoopMessage account

- [ ] Signed up; a **shared sender name** is active (not a pending dedicated/branded one).
- [ ] **SMS fallback / RCS is OFF** on the sender (guarantees blue-only).
- [ ] `LOOPMESSAGE_AUTH_KEY`, `LOOPMESSAGE_SECRET_KEY`, `LOOPMESSAGE_SENDER_NAME` match
      the dashboard exactly.
- [ ] Plan/credits cover ~9 messages (trivial — confirm the month's charge at checkout).

## C. Google Sheet

- [ ] Tab name matches `SHEET_TAB` (or is `Schedule`).
- [ ] Header row is exactly: `id, recipient_name, recipient_phone, moment, send_at_local,
      message, status, sent_at_utc, result_note`.
- [ ] All 9 rows have **real** E.164 phone numbers (`+1…`), no `+1XXXXXXXXXX` left.
- [ ] `send_at_local` cells read like `2026-06-18 14:00` (plain text, ET wall-clock).
- [ ] Every message you intend to send has copy AND status `READY`. Everything else is
      `HOLD`/`SKIP`.
- [ ] Sheet is shared with the service-account email as **Editor**.

## D. GitHub

- [ ] All four secrets + `SHEET_ID` variable set with the **exact** names from the README.
- [ ] **Actions → iMessage Sender → Run workflow → dry_run = true** prints the rows you
      expect, with correct ET→UTC times, and reports `sent=0` (dry run sends nothing).
- [ ] The scheduled workflow is enabled (Actions tab shows it; note that GitHub may
      pause schedules on inactive repos — a manual dispatch wakes it).

## E. Live smoke test (recommended)

- [ ] Add one extra throwaway row targeting **your own phone**, status `SEND_NOW`, with a
      short test message. Wait ≤5 min → confirm you receive a **blue** iMessage and the
      row flips to `SENT` with a `message_id` in `result_note`. Then `SKIP` or delete it.

## F. Day-of muscle memory

- To fire now: set the row's status to `SEND_NOW`.
- To stop one: set `SKIP` or `HOLD`.
- A failure shows as `FAILED` with the reason in `result_note`; fix, then set `READY`.
- A row stuck on `SENDING` means an uncertain network result — check whether it actually
  arrived before resetting it.
