# Pre-flight checklist (Mac path)

Run this before you walk away and trust it to fire unattended.

## A. Automated check

```bash
cd imessage-sender
node preflight.mjs
```

Verifies (changes nothing): config loads, `schedule.csv` reads and the schema is right,
every `send_at_local` converts to the expected UTC instant, the per-row decision, that
osascript/Messages.app is reachable, and it loudly flags rows that are `READY` with a
blank message or a placeholder phone. Exits non-zero if it finds a problem.

## B. iMessage sender identity

- [ ] You're signed into Messages on this Mac with the Apple ID you want to send from.
- [ ] If using a themed email handle: it's added + verified on the Apple ID, checked in
      **Messages → Settings → iMessage → Send & Receive**, and set as **"Start new
      conversations from."**
- [ ] You generated the vCard and sent it to each recipient; they saved it. (This also
      opens each conversation, which makes automated sends reliable.)

## C. The schedule (`schedule.csv`)

- [ ] Every row has a **real** iMessage handle (no `+1XXXXXXXXXX` left).
- [ ] `send_at_local` reads like `2026-06-18 14:00` (plain text, ET).
- [ ] Every message you intend to send has copy AND status `READY`. Everything else is
      `HOLD`/`SKIP`.

## D. Live smoke test (do this once)

- [ ] Add a throwaway row targeting **your own** number, status `SEND_NOW`, short text.
- [ ] `node send.mjs` → approve the macOS "control Messages" prompt → confirm you get a
      **blue** bubble and `sent-ledger.json` shows the row as `SENT`. Then `SKIP`/remove
      that row (and its ledger entry).

## E. Scheduler + stay awake

- [ ] `bash macos/install.sh` ran cleanly; `~/Library/Logs/imessage-sender.out.log`
      shows a run within 5 minutes.
- [ ] `bash macos/keep-awake.sh` is running in an open Terminal window (and the Mac is
      on AC power). launchd will not fire while the Mac is asleep.

## F. Day-of muscle memory

- Fire now: set the row's `status` to `SEND_NOW`.
- Stop one: set `SKIP` or `HOLD`.
- A failure shows as `FAILED`; fix it, set `READY`, and remove its `sent-ledger.json`
  entry if present.
- A row stuck on `SENDING` = an uncertain/timed-out send — check whether it actually
  arrived in Messages before resetting it.

---

_Cloud path (Google Sheet + LoopMessage) instead? See the bottom of `README.md`; the
checklist there is account setup, secrets, SMS-fallback OFF, and a dry-run dispatch._
