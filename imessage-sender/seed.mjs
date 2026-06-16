// One-time seeder: writes the header + the 9 starter rows from rows.seed.json into
// the configured Google Sheet tab. Message cells are LEFT BLANK and status = HOLD,
// so nothing can fire until the user reviews and flips rows to READY.
//
// Safe by default: refuses to run if the tab already has data rows. Pass --force to
// overwrite (e.g. after editing rows.seed.json). RAW write keeps send_at_local as a
// plain text string so Sheets never re-interprets "2026-06-18 14:00" as a locale date.
//
//   node seed.mjs            # seed an empty tab
//   node seed.mjs --force    # overwrite existing contents

import fs from 'node:fs';
import { loadConfig, REQUIRED_COLUMNS } from './lib/config.mjs';
import { getAccessToken, readSheet, writeRange, columnLetter } from './lib/google.mjs';

const force = process.argv.includes('--force');
const cfg = loadConfig(process.env, { requireSendCreds: false });

const seedRows = JSON.parse(fs.readFileSync(new URL('./rows.seed.json', import.meta.url), 'utf8'));
const token = await getAccessToken(cfg.serviceAccountJson);

const existing = await readSheet(token, cfg.sheetId, cfg.sheetTab);
if (existing.length > 1 && !force) {
  console.error(
    `Refusing to seed: tab "${cfg.sheetTab}" already has ${existing.length - 1} data row(s).\n`
    + `Re-run with --force to overwrite (this will not touch any other tab).`,
  );
  process.exit(1);
}

const values = [REQUIRED_COLUMNS, ...seedRows.map((r) => REQUIRED_COLUMNS.map((h) => r[h] ?? ''))];
const lastCol = columnLetter(REQUIRED_COLUMNS.length - 1);
const range = `${cfg.sheetTab}!A1:${lastCol}${values.length}`;

await writeRange(token, cfg.sheetId, range, values);
console.log(
  `Seeded ${seedRows.length} rows into "${cfg.sheetTab}".\n`
  + `Next: fill real phone numbers + your message copy, then flip status HOLD -> READY when ready.`,
);
