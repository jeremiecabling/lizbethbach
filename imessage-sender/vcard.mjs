// Generate a themed contact card (.vcf). Send/AirDrop it to each recipient once; when
// they save it, your blue iMessages show up under this name + photo instead of a raw
// handle — that's the "make it look different" trick.
//
// The handle here is the address your messages are sent FROM (your Apple ID's email or
// phone), NOT the recipient's. This does not generate message copy.
//
// Usage:
//   node vcard.mjs --name "Love Island Villa 💌" --handle villa@yourdomain.com \
//        [--phone +1XXXXXXXXXX] [--photo ./villa.jpg] [--org "Love Island"] [--out villa.vcf]

import fs from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i++, i)] : 'true';
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.name || (!args.handle && !args.phone)) {
  console.error('Usage: node vcard.mjs --name "<display name>" --handle <email-or-phone> '
    + '[--phone +1...] [--photo file] [--org "..."] [--out file.vcf]');
  process.exit(1);
}

const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:;${args.name};;;`, `FN:${args.name}`];
if (args.org) lines.push(`ORG:${args.org}`);

// The "handle" can be an email or a phone; --phone is an extra phone if you want both.
const handles = [];
if (args.handle) handles.push(args.handle);
if (args.phone) handles.push(args.phone);
for (const h of handles) {
  if (h.includes('@')) lines.push(`EMAIL;type=INTERNET:${h}`);
  else lines.push(`TEL;type=CELL:${h}`);
}

if (args.photo && args.photo !== 'true') {
  const buf = fs.readFileSync(args.photo);
  const ext = args.photo.toLowerCase().endsWith('.png') ? 'PNG' : 'JPEG';
  lines.push(`PHOTO;ENCODING=b;TYPE=${ext}:${buf.toString('base64')}`);
}

lines.push('END:VCARD');

const out = args.out && args.out !== 'true' ? args.out : 'contact.vcf';
fs.writeFileSync(out, lines.join('\r\n') + '\r\n');
console.log(`Wrote ${out}. Send/AirDrop it to each recipient; have them tap "Create New Contact" / save it.`);
console.log(`Reminder: in Messages → Settings → iMessage, set "Start new conversations from" to ${args.handle || args.phone}.`);
