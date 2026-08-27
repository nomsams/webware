// Minimal vCard (.vcf) parse/export, hand-rolled — no library, same approach
// https://github.com/nomsams/contactview uses. Ported subset covers the fields most useful for
// a recipient address book (FN/N, ORG, TEL, EMAIL, ADR). contactview's autosave and "Google
// Calendar sync" aren't ported: autosave is plain localStorage (nothing to port, just call
// localStorage.setItem wherever this ends up wired in), and the calendar sync turned out to be
// just a calendar.google.com deep link / .ics download rather than a real API integration — not
// worth a separate module for that.
//
// STATUS: standalone, not wired into index.html yet. Intended use: a "saved recipients" picker
// for Pack Order — import contacts from a phone's exported .vcf, pick one to fill the recipient
// name/address fields, and optionally export a chosen recipient back out as a .vcf.

// Parses one or more vCards from a .vcf file's text content. Handles RFC 6350 line-folding (a
// continuation line starts with a space or tab) and both TYPE=X and bare-parameter styles
// (e.g. "TEL;TYPE=CELL:" and "TEL;CELL:" both work).
export function parseVCardFile(text) {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const cards = unfolded.split(/BEGIN:VCARD/i).slice(1); // discard anything before the first BEGIN
  return cards
    .map((chunk) => `BEGIN:VCARD${chunk.split(/END:VCARD/i)[0]}`)
    .map(parseVCard);
}

export function parseVCard(text) {
  const contact = { name: '', org: '', title: '', phones: [], emails: [], addresses: [], note: '' };
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const lines = unfolded.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (/^(BEGIN|END|VERSION):/i.test(line)) continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex);
    const value = line.slice(colonIndex + 1);
    const [field, ...params] = key.split(';');
    const type = paramType(params);

    switch (field.toUpperCase()) {
      case 'FN': contact.name = value; break;
      case 'N': if (!contact.name) contact.name = value.split(';').filter(Boolean).reverse().join(' '); break;
      case 'ORG': contact.org = value.replace(/;/g, ' ').trim(); break;
      case 'TITLE': contact.title = value; break;
      case 'TEL': contact.phones.push({ type, value }); break;
      case 'EMAIL': contact.emails.push({ type, value }); break;
      case 'ADR': contact.addresses.push({ type, value: formatAdrValue(value) }); break;
      case 'NOTE': contact.note = value; break;
      default: break; // PHOTO and anything else: not needed for an address book, skipped
    }
  }
  return contact;
}

function paramType(params) {
  for (const p of params) {
    const [k, v] = p.split('=');
    if (v && k.toUpperCase() === 'TYPE') return v.split(',')[0];
    if (!v && p) return p; // bare "CELL" style param
  }
  return '';
}

// ADR value is 7 semicolon-separated components: PO box; extended; street; city; region;
// postal code; country. Join the populated ones into a readable multi-line address.
function formatAdrValue(value) {
  const [, , street, city, region, postal, country] = value.split(';');
  return [street, [postal, city].filter(Boolean).join(' '), region, country].filter(Boolean).join('\n');
}

// Generates vCard 3.0 text for one contact, in the shape parseVCard()/parseVCardFile() can read
// back — round-trips through both functions in the tests below. addressLines is free text (as
// stored on a Pack Order recipient) rather than structured street/city/postal, since that's what
// this app actually has to hand.
export function generateVCard({ name, org = '', phone = '', email = '', addressLines = '' }) {
  if (!name) throw new Error('generateVCard: name is required');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escapeVCardValue(name)}`, `N:${escapeVCardValue(name)};;;;`];
  if (org) lines.push(`ORG:${escapeVCardValue(org)}`);
  if (phone) lines.push(`TEL;TYPE=WORK:${escapeVCardValue(phone)}`);
  if (email) lines.push(`EMAIL;TYPE=WORK:${escapeVCardValue(email)}`);
  if (addressLines) lines.push(`ADR;TYPE=WORK:;;${escapeVCardValue(addressLines.replace(/\n/g, ', '))};;;;`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

function escapeVCardValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}
