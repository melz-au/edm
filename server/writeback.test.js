import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forDisplay, maskEntry, maskKeepingFormat, outboxEntries, renderPath, toCsv } from './writeback.js';

test('paths are rendered from key columns and URL-encoded', () => {
  assert.equal(renderPath('/customers/{CUST_NO}', { CUST_NO: 'C3000380' }), '/customers/C3000380');
  assert.equal(renderPath('/x/{a}/{b}', { a: 'A B', b: '1/2' }), '/x/A%20B/1%2F2');
  assert.throws(() => renderPath('/x/{nope}', { a: 1 }), /isn't a key column/);
});

test('one outbox entry per record with expected old values', () => {
  const entries = outboxEntries(
    [
      { key: { id: '1' }, column: 'STATE', old: 'S.A.', new: 'SA', fix: 'standardise_code' },
      { key: { id: '1' }, column: 'PCODE', old: '5066.0', new: '5066', fix: 'excel_decimal' },
      { key: { id: '2' }, column: 'STATE', old: 'sa', new: 'SA', fix: 'standardise_code' },
    ],
    { method: 'PATCH', pathTemplate: '/customers/{id}' },
  );
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    record_key: { id: '1' },
    method: 'PATCH',
    path: '/customers/1',
    body: { set: { STATE: 'SA', PCODE: '5066' }, expect: { STATE: 'S.A.', PCODE: '5066.0' }, fixes: { STATE: 'standardise_code', PCODE: 'excel_decimal' } },
  });
  const csv = toCsv([{ id: 7, source_table: 't', status: 'pending', ...entries[0] }]);
  assert.equal(csv.split('\n').length, 4, 'header + one row per field');
  assert.match(csv, /7,t,"\{""id"":""1""\}",PATCH,\/customers\/1,STATE,S\.A\.,SA,standardise_code,pending/);
});

test('display masking keeps formats visible and hides personal data', () => {
  assert.equal(maskKeepingFormat('545124'), '••••24');
  assert.equal(maskKeepingFormat('545-124'), '•••-•24');
  const e = maskEntry({ body: { set: { BSB_NO: '545-124', STATE: 'SA' }, expect: { BSB_NO: '545124', STATE: 'S.A.' } } });
  assert.deepEqual(e.body.set, { BSB_NO: '•••-•24', STATE: 'SA' });
  assert.deepEqual(e.body.expect, { BSB_NO: '••••24', STATE: 'S.A.' });
  const viaRequest = maskEntry({ pii_types: { MOBILE_NO_X: 'phone' }, body: { set: { MOBILE_NO_X: '0491 570 138' }, expect: { MOBILE_NO_X: '61 491 570 138' } } });
  assert.deepEqual(viaRequest.body.set, { MOBILE_NO_X: '•••• ••• •38' }, 'PII types recorded with the request are honoured');
  const cr = forDisplay({
    kind: 'writeback',
    payload: { changes: Array.from({ length: 80 }, (_, i) => ({ key: { id: i }, column: 'EMAIL_ADDR', old: `p${i}@x.com `, new: `p${i}@x.com` })), piiTypes: { EMAIL_ADDR: 'email' }, groups: [] },
  });
  assert.equal(cr.payload.changeCount, 80);
  assert.equal(cr.payload.changes.length, 50);
  assert.equal(cr.payload.changes[0].new, 'p•••@x.com');
  assert.equal(forDisplay({ kind: 'code_set', payload: { a: 1 } }).payload.a, 1);
});
