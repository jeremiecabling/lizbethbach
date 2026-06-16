// LoopMessage client — sends a true blue iMessage.
//
// Verified against the current LoopMessage API (June 2026):
//   POST https://server.loopmessage.com/api/v1/message/send/
//   Headers: Authorization: <auth key>, Loop-Secret-Key: <secret key>, Content-Type: application/json
//   Body:    { recipient, text, sender_name, service: "imessage" }
//   Returns: HTTP 200 + { message_id, success } when accepted/queued. Final delivery
//            (and any failure) is reported asynchronously via webhook — a 5-min cron
//            cannot observe it — so we treat the synchronous message_id as the SENT anchor.
//
// BLUE-NOT-GREEN: we pin service:"imessage" and never enable SMS fallback. SMS fallback
// is a separately-purchased add-on on the sender; with it OFF, a failed iMessage simply
// fails — it can never silently downgrade to a green SMS.

const SEND_ENDPOINT = 'https://server.loopmessage.com/api/v1/message/send/';

/**
 * @returns one of:
 *   { ok: true,  messageId, raw }                  // accepted/queued
 *   { ok: false, uncertain: true,  error }         // network/timeout/5xx — may or may not have sent
 *   { ok: false, uncertain: false, error }         // clean rejection — definitely NOT sent
 */
export async function sendImessage(
  { authKey, secretKey, senderName, recipient, text, webhookUrl },
  { fetchImpl = fetch, timeoutMs = 20000 } = {},
) {
  const body = {
    recipient,
    text,                    // verbatim, opaque — never modified
    sender_name: senderName,
    service: 'imessage',     // force blue
  };
  if (webhookUrl) body.webhook_url = webhookUrl;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(SEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: authKey,
        'Loop-Secret-Key': secretKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    // Network error or timeout: we do not know if the server accepted it.
    // UNCERTAIN -> caller leaves the row reserved (SENDING), never auto-retries.
    const why = err && err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err && err.message) || String(err);
    return { ok: false, uncertain: true, error: `network: ${why}` };
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }

  const messageId = json && (json.message_id || json.id);
  if (res.status >= 200 && res.status < 300 && json && json.success !== false && messageId) {
    return { ok: true, messageId, raw: json };
  }

  // 5xx: server-side; the request may have been queued. Treat as uncertain.
  if (res.status >= 500) {
    return { ok: false, uncertain: true, error: `server ${res.status}: ${summarize(json)}` };
  }

  // 4xx or explicit success:false => clean rejection; nothing was sent.
  const reason = (json && (json.message || json.error)) || `HTTP ${res.status}`;
  const code = json && json.error_code != null ? ` (error_code ${json.error_code})` : '';
  return { ok: false, uncertain: false, error: `${reason}${code}` };
}

function summarize(json) {
  try { return JSON.stringify(json).slice(0, 300); } catch { return String(json); }
}
