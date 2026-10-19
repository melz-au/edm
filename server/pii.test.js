import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, detectByName, detectByValues, detectInFreeText, luhn, mask, samplesSql, validTfn, valueColumns } from './pii.js';
import { profileTable } from './profile.js';

test('column names map to PII types across naming styles', () => {
  const cases = {
    email: 'email', EMAIL_ADDRESS: 'email', contactEmail: 'email',
    first_name: 'person_name', LastName: 'person_name', SURNAME: 'person_name', customer_name: 'person_name',
    mobile_phone: 'phone', Telephone: 'phone',
    dob: 'date_of_birth', date_of_birth: 'date_of_birth',
    tfn: 'government_id', medicare_no: 'government_id', passport_number: 'government_id', drivers_licence_no: 'government_id',
    credit_card_number: 'financial', bsb: 'financial', bank_account: 'financial',
    password_hash: 'credential', gender: 'special_category',
    street_address: 'address', CHANGEBY: 'person_id', created_by: 'person_id', username: 'person_id',
    latitude: 'location', postcode: 'location',
    concession_card_number: 'government_id', preferred_name: 'person_name', account_manager: 'person_id',
    // Legacy billing-system names.
    CUST_NAME: 'person_name', CONC_CARD: 'government_id', BANK_ACCT: 'financial', SUPPLY_ADDR_1: 'address',
    MAIL_ADDR: 'address', PCODE: 'location', LAST_UPD_USER: 'person_id',
  };
  for (const [name, type] of Object.entries(cases)) assert.equal(detectByName(name), type, name);
  for (const name of ['status', 'assettype', 'description', 'serialnum', 'siteid', 'glaccount', 'product_name', 'orgid', 'location', 'notes']) {
    assert.equal(detectByName(name), null, name);
  }
});

test('value formats: email, phone, card, IP, SSN, TFN', () => {
  assert.equal(detectByValues(['a@x.com', 'b.c@y.org', 'd@z.com.au']).type, 'email');
  assert.equal(detectByValues(['0412 345 678', '+61 8 8123 4567', '(08) 8123 4567']).type, 'phone');
  assert.equal(detectByValues(['4111 1111 1111 1111', '5555555555554444', '4012-8888-8888-1881']).type, 'financial');
  assert.equal(detectByValues(['10.0.0.1', '192.168.1.20', '8.8.8.8']).type, 'ip_address');
  assert.equal(detectByValues(['123-45-6789', '987-65-4321', '111-22-3333']).type, 'government_id');
  assert.equal(detectByValues(['123 456 782', '123 456 782', '123 456 782']).type, 'government_id');
  // Not PII: asset numbers, GUIDs, times, prices, codes.
  assert.equal(detectByValues(['100001', '100002', '100003']), null);
  assert.equal(detectByValues(['9d9262af-2c8d-0e44', 'a1b2c3d4-0000', 'ffff-0000-1111']), null);
  assert.equal(detectByValues(['10:30:00', '11:45:00', '09:00:00']), null);
  assert.equal(detectByValues(['62397.77', '1844.82', '7457.72']), null);
  assert.equal(detectByValues(['OPERATING', 'BROKEN', 'NOT READY']), null);
  assert.equal(detectByValues(['SN99245317', 'SN12345678', 'SN55554444']), null);
});

test('checksums', () => {
  assert.equal(luhn('4111111111111111'), true);
  assert.equal(luhn('4111111111111112'), false);
  assert.equal(validTfn('123456782'), true);
  assert.equal(validTfn('123456789'), false);
});

test('masking keeps only a hint of the value', () => {
  assert.equal(mask('jane.smith@example.com', 'email'), 'j•••@example.com');
  assert.equal(mask('4111 1111 1111 1111', 'financial'), '•••• 1111');
  assert.equal(mask('0412 345 678', 'phone'), '•••• 78');
  assert.equal(mask('BOCONNOR', 'person_id'), 'B•••R');
  assert.equal(mask('Wei', 'person_name'), '•••');
});

test('assess combines evidence and masks examples', () => {
  const r = assess('contact', ['jane1@example.com', 'john2@example.com', 'wei3@example.com']);
  assert.equal(r.type, 'email');
  assert.equal(r.confidence, 'high');
  assert.ok(r.examples.every((e) => e.includes('•••')));
  assert.equal(assess('mobile', ['0412 345 678', '0400 000 001', '0499 123 456']).evidence.startsWith('column name;'), true);
  assert.equal(assess('status', ['OPEN', 'CLOSED', 'OPEN']), null);
});

test('only text-like columns are sampled for values', () => {
  const cols = valueColumns([
    { name: 'a', type: 'text' }, { name: 'b', type: 'character varying(20)' }, { name: 'c', type: 'STRING' },
    { name: 'd', type: 'bigint' }, { name: 'e', type: 'numeric(12,2)' }, { name: 'f', type: 'date' }, { name: 'g', type: 'integer' },
  ]);
  assert.deepEqual(cols.map((c) => c.name), ['a', 'b', 'c', 'd']);
  assert.match(samplesSql('spark', '`t`', [{ name: 'email', index: 3 }], 100), /SELECT 3 AS i, CAST\(`email` AS STRING\)/);
});

test('profileTable flags PII, masks categorical top values, and ignores asset coordinates', async () => {
  const columns = [
    { name: 'id', type: 'integer', pk: true },
    { name: 'created_by', type: 'text' },
    { name: 'latitude', type: 'numeric' },
    { name: 'status', type: 'text' },
  ];
  const run = async (sql) => {
    if (sql.includes('count(DISTINCT')) return [{ n: '100', d0: '2', nn0: '100', d1: '2', nn1: '100' }];
    if (sql.includes('row_number() OVER (PARTITION BY i ORDER BY n DESC')) {
      return [
        { i: '0', v: 'jsmith', n: '60' }, { i: '0', v: 'akumar', n: '40' },
        { i: '1', v: 'OPEN', n: '70' }, { i: '1', v: 'CLOSED', n: '30' },
      ];
    }
    return [{ i: '1', v: 'jsmith' }, { i: '1', v: 'akumar' }, { i: '3', v: 'OPEN' }];
  };
  const r = await profileTable({ dialect: 'pg', ref: '"t"', columns, primaryKey: ['id'], run });
  const by = Object.fromEntries(r.columns.map((c) => [c.name, c]));
  assert.equal(by.created_by.pii.type, 'person_id');
  assert.deepEqual(by.created_by.topValues.map((v) => v.value), ['j•••h', 'a•••r']);
  assert.equal(by.latitude.pii, null, 'no direct identifiers → coordinates are not personal data');
  assert.equal(by.status.pii, null);
  assert.deepEqual(by.status.topValues.map((v) => v.value), ['OPEN', 'CLOSED']);
});

test('personal data inside free text is reported by kind, never by value', () => {
  const notes = [
    'Prefers contact after 5pm.', 'Requested paper bills.', 'Call back on 0491 570 118 re payment plan.',
    'Leak allowance applied.', 'CUST DOB 1987-05-02', 'Reported low water pressure.', 'Meter access via side gate.',
  ];
  const found = detectInFreeText(notes);
  assert.ok(found.some((f) => f.startsWith('a phone number')));
  assert.ok(found.some((f) => f.startsWith('a date of birth')));
  const r = assess('COMMENTS', notes);
  assert.equal(r.type, 'free_text');
  assert.deepEqual(r.examples, []);
  assert.equal(assess('COMMENTS', ['HARDSHIP - SEE FILE', 'OWNER OCCUPIER', 'TENANT - BILL OWNER', 'PAYMENT ARRANGEMENT $20/FN', 'CONVERTED FROM LEGACY SYSTEM 2009']), null);
  assert.equal(detectInFreeText(['20260205015300', '20260116084400', '20260818182800', '20260616011900', '20261001120000']), null);
  assert.equal(detectInFreeText(['Asset 100001 serviced', 'Pump replaced 2024-03-01', 'Valve 4500 checked', 'Reading 123456789', 'ok']), null);
});
