// Thin adapter that turns the raw Sheet into { rows, update } for the orchestrator.
// Rows are objects keyed by column name and carry their 1-based sheet row number so
// write-backs target the exact row even if the user re-sorts visually.

import { REQUIRED_COLUMNS } from './config.mjs';
import { getAccessToken, readSheet, updateCells } from './google.mjs';

export async function makeSheetClient(cfg, { fetchImpl = fetch } = {}) {
  const token = await getAccessToken(cfg.serviceAccountJson, { fetchImpl });
  const values = await readSheet(token, cfg.sheetId, cfg.sheetTab, { fetchImpl });

  const header = (values[0] || []).map((h) => String(h).trim());
  const headerIndex = {};
  header.forEach((h, i) => { if (!(h in headerIndex)) headerIndex[h] = i; });

  const missing = REQUIRED_COLUMNS.filter((c) => headerIndex[c] == null);
  if (missing.length) {
    throw new Error(`Sheet "${cfg.sheetTab}" is missing column(s): ${missing.join(', ')}`);
  }

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i] || [];
    const obj = { _rowNumber: i + 1 };
    for (const col of header) obj[col] = raw[headerIndex[col]] ?? '';
    if (String(obj.id ?? '').trim() === '') continue; // ignore blank trailing rows
    rows.push(obj);
  }

  return {
    rows,
    update(rowNumber, updates) {
      return updateCells(token, cfg.sheetId, cfg.sheetTab, rowNumber, headerIndex, updates, { fetchImpl });
    },
  };
}
