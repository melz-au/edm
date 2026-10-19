import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, normalise, suggestMappings } from './mapping.js';

const codes = (pairs) => pairs.map(([code, label], i) => ({ id: i + 1, code, label, active: true }));
const pick = (list, values, known) => {
  const byId = Object.fromEntries(list.map((c) => [c.id, c.code]));
  return Object.fromEntries(
    suggestMappings(values, list, known).map((s) => [s.value, s.missing ? '∅' : byId[s.codeValueId] ?? null]),
  );
};

test('normalise and edit distance', () => {
  assert.equal(normalise(' Closed '), 'CLOSED');
  assert.equal(normalise('S.A.'), 'SA');
  assert.equal(editDistance('INACTVE', 'INACTIVE'), 1);
});

test('status variants map to standard codes', () => {
  const status = codes([['ACTIVE', 'Active'], ['INACTIVE', 'Inactive'], ['CLOSED', 'Closed'], ['PROSPECT', 'Prospect']]);
  assert.deepEqual(pick(status, ['A', 'a', 'act', 'Active', 'I', 'INACT', 'i', 'C', 'CLS', 'Closed ', 'Inactve']), {
    A: 'ACTIVE', a: 'ACTIVE', act: 'ACTIVE', Active: 'ACTIVE', I: 'INACTIVE', INACT: 'INACTIVE', i: 'INACTIVE',
    C: 'CLOSED', CLS: 'CLOSED', 'Closed ': 'CLOSED', Inactve: 'INACTIVE',
  });
});

test('initials, words and punctuation', () => {
  const pay = codes([['DIRECT DEBIT', 'Direct Debit'], ['BPAY', 'Bpay'], ['CARD', 'Card'], ['CENTREPAY', 'Centrepay'], ['CHEQUE', 'Cheque']]);
  assert.deepEqual(pick(pay, ['DD', 'D/D', 'B-PAY', 'Credit Card', 'CHQ', 'CTP', 'CC']), {
    DD: 'DIRECT DEBIT', 'D/D': 'DIRECT DEBIT', 'B-PAY': 'BPAY', 'Credit Card': 'CARD', CHQ: 'CHEQUE', CTP: 'CENTREPAY', CC: null,
  });
  assert.deepEqual(pick(codes([['SA', 'SA']]), ['S.A.', 'South Australia', 'NSW']), { 'S.A.': 'SA', 'South Australia': 'SA', NSW: null });
});

test('missing-value tokens, but a real code wins', () => {
  const g = codes([['F', 'F'], ['M', 'M']]);
  assert.deepEqual(pick(g, ['NULL', 'N/A', '-', ' ', '', 'Unknown', 'Male']), {
    NULL: '∅', 'N/A': '∅', '-': '∅', ' ': '∅', '': '∅', Unknown: '∅', Male: 'M',
  });
  assert.equal(pick(codes([['UNKNOWN', 'Unknown'], ['M', 'M']]), ['Unknown']).Unknown, 'UNKNOWN');
});

test('ties are left for a person and earlier decisions are reused', () => {
  const t = codes([['CANCELLED', 'Cancelled'], ['CLOSED', 'Closed']]);
  const [s] = suggestMappings(['C'], t);
  assert.equal(s.codeValueId, null);
  assert.match(s.reason, /ambiguous: CANCELLED or CLOSED/);
  const [k] = suggestMappings(['c'], t, [{ source_value: 'C', code_value_id: 2 }]);
  assert.equal(k.codeValueId, 2);
  assert.match(k.reason, /another source/);
  // Inactive codes are never suggested.
  const inactive = [{ id: 1, code: 'OLD', label: 'Old', active: false }];
  assert.equal(suggestMappings(['OLD'], inactive)[0].codeValueId, null);
});
