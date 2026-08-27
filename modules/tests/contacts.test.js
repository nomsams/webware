// Run: node --test modules/tests/contacts.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVCard, parseVCardFile, generateVCard } from '../contacts.js';

test('parseVCard reads FN, ORG, TEL type, EMAIL, and ADR', () => {
  const vcf = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Jane Doe',
    'ORG:Acme AB',
    'TEL;TYPE=CELL:+46 70 123 45 67',
    'EMAIL;TYPE=WORK:jane@acme.example',
    'ADR;TYPE=WORK:;;Storgatan 1;Stockholm;;123 45;Sweden',
    'END:VCARD',
  ].join('\r\n');

  const contact = parseVCard(vcf);

  assert.equal(contact.name, 'Jane Doe');
  assert.equal(contact.org, 'Acme AB');
  assert.deepEqual(contact.phones, [{ type: 'CELL', value: '+46 70 123 45 67' }]);
  assert.deepEqual(contact.emails, [{ type: 'WORK', value: 'jane@acme.example' }]);
  assert.equal(contact.addresses[0].value, 'Storgatan 1\n123 45 Stockholm\nSweden');
});

test('parseVCard falls back to N when FN is absent, and handles bare TYPE params', () => {
  const vcf = 'BEGIN:VCARD\nN:Doe;Jane;;;\nTEL;CELL:070-1234567\nEND:VCARD';
  const contact = parseVCard(vcf);
  assert.equal(contact.name, 'Jane Doe');
  assert.equal(contact.phones[0].type, 'CELL');
});

test('parseVCard un-folds continuation lines (leading space)', () => {
  const vcf = 'BEGIN:VCARD\nFN:Very Long Company Name That Wraps\n ACROSS Two Lines\nEND:VCARD';
  const contact = parseVCard(vcf);
  assert.equal(contact.name, 'Very Long Company Name That WrapsACROSS Two Lines');
});

test('parseVCardFile splits multiple cards out of one file', () => {
  const vcf = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Alice', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Bob', 'END:VCARD',
  ].join('\r\n');

  const contacts = parseVCardFile(vcf);

  assert.equal(contacts.length, 2);
  assert.deepEqual(contacts.map((c) => c.name), ['Alice', 'Bob']);
});

test('generateVCard requires a name', () => {
  assert.throws(() => generateVCard({}), /name is required/);
});

test('generateVCard escapes special characters', () => {
  const vcf = generateVCard({ name: 'Doe, Jane; the Great' });
  assert.match(vcf, /FN:Doe\\, Jane\\; the Great/);
});

test('generateVCard output round-trips through parseVCard', () => {
  const vcf = generateVCard({
    name: 'Jane Doe',
    org: 'Acme AB',
    phone: '+46 70 123 45 67',
    email: 'jane@acme.example',
    addressLines: 'Storgatan 1\n123 45 Stockholm',
  });

  const contact = parseVCard(vcf);

  assert.equal(contact.name, 'Jane Doe');
  assert.equal(contact.org, 'Acme AB');
  assert.equal(contact.phones[0].value, '+46 70 123 45 67');
  assert.equal(contact.emails[0].value, 'jane@acme.example');
  assert.ok(contact.addresses[0].value.includes('Storgatan 1'));
});
