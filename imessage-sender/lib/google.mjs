// Google Sheets access via a service account — zero dependencies.
// We sign a JWT with node:crypto (RS256), exchange it for an access token, then
// call the Sheets v4 REST API. The service account needs access to ONLY this Sheet.

import crypto from 'node:crypto';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Exchange a service-account JSON (string or object) for an OAuth access token. */
export async function getAccessToken(serviceAccountJson, { fetchImpl = fetch } = {}) {
  const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  if (!sa.client_email || !sa.private_key) {
    throw new Error('Service account JSON missing client_email / private_key');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.access_token) {
    throw new Error(`Google token error (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

/** Read the whole tab as a 2D array of strings (FORMATTED_VALUE keeps text as-typed). */
export async function readSheet(token, sheetId, tab, { fetchImpl = fetch } = {}) {
  const range = encodeURIComponent(tab);
  const url = `${SHEETS_BASE}/${sheetId}/values/${range}`
    + `?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Sheets read error (${res.status}): ${JSON.stringify(json)}`);
  return (json && json.values) || [];
}

/**
 * Write specific named columns back to one row.
 * @param headerIndex map of column-name -> 0-based column index
 * @param updates     { status?, sent_at_utc?, result_note? }
 */
export async function updateCells(token, sheetId, tab, rowNumber, headerIndex, updates, { fetchImpl = fetch } = {}) {
  const data = [];
  for (const [key, value] of Object.entries(updates)) {
    const colIdx = headerIndex[key];
    if (colIdx == null) continue;
    data.push({ range: `${tab}!${columnLetter(colIdx)}${rowNumber}`, values: [[value]] });
  }
  if (!data.length) return null;
  const res = await fetchImpl(`${SHEETS_BASE}/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Sheets update error (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

/** Overwrite a contiguous A1 range (used by the seeder). */
export async function writeRange(token, sheetId, range, values, { fetchImpl = fetch } = {}) {
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Sheets write error (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

/** 0-based column index -> A1 letter (0->A, 25->Z, 26->AA). */
export function columnLetter(idx) {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
