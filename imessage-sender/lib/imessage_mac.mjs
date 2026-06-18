// Mac transport: send a blue iMessage by driving Messages.app via osascript.
//
// We use execFile (no shell) and pass the recipient + text as argv, so message copy
// is never shell-interpreted — quotes, emoji, apostrophes go through verbatim.
//
// AppleScript's `send` confirms dispatch, not delivery (same as a provider's 200 +
// message_id). We map exit codes to the same result contract the orchestrator uses:
//   exit 0            -> { ok: true, messageId }
//   timeout (killed)  -> { ok: false, uncertain: true }   (leave reserved, no retry)
//   other non-zero    -> { ok: false, uncertain: false }  (clean failure -> FAILED)

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(new URL('../macos/send-imessage.applescript', import.meta.url));

export function sendViaMessages({ recipient, text }, { scriptPath = SCRIPT_PATH, timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    execFile('osascript', [scriptPath, recipient, text], { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (!err) {
        resolve({ ok: true, messageId: `imessage:${new Date().toISOString()}` });
        return;
      }
      if (err.killed) {
        resolve({ ok: false, uncertain: true, error: `osascript timeout after ${timeoutMs}ms` });
        return;
      }
      const detail = String(stderr || err.message || '').replace(/\s+/g, ' ').trim();
      // A bad/unreachable handle or "service not found" is a definitive failure: nothing
      // was sent. Surface it as a clean rejection so the row is marked FAILED, not retried.
      resolve({ ok: false, uncertain: false, error: detail.slice(0, 300) || `osascript exit ${err.code}` });
    });
  });
}
