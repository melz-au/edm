import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCorrections, fitShape, proposeFix } from './corrections.js';

const fmt = (regex, extra = {}) => ({ rule_type: 'format', params: { regex, ...extra } });
const fix = (v, rule, ctx) => {
  const f = proposeFix(v, rule, ctx);
  return f && [f.value, f.safety];
};

test('fitShape lays characters into a format', () => {
  assert.equal(fitShape('545124', '999-999'), '545-124');
  assert.equal(fitShape('864170980k', '999-999-999A'), '864-170-980K');
  assert.equal(fitShape('12', '999'), null);
});

test('format fixes: lossless ones are safe, assumptions need review, losses are manual', () => {
  const bsb = fmt('^[0-9]{3}[-][0-9]{3}$', { pattern: '999-999' });
  assert.deepEqual(fix('545124', bsb), ['545-124', 'safe']);
  assert.deepEqual(fix(' 545-124 ', bsb), ['545-124', 'safe']);
  assert.equal(fix('545-124', bsb), null);

  const pc = fmt('^[0-9]{4}$', { pattern: '9999' });
  assert.deepEqual(fix('5066.0', pc), ['5066', 'safe']);
  assert.deepEqual(fix('506', pc), [null, 'manual']);

  const acct = fmt('^[0-9]{8}$', { pattern: '99999999' });
  assert.deepEqual(fix('3.74235E+7', acct), [null, 'manual']);

  const dob = fmt('^[0-9]{2}/[0-9]{2}/[0-9]{4}$', { pattern: '99/99/9999' });
  assert.deepEqual(fix('1963-01-20', dob), ['20/01/1963', 'safe']);
  assert.deepEqual(fix('11-MAR-42', dob, { pastDates: true }), ['11/03/1942', 'review']);
  assert.deepEqual(fix('10/30/1965', dob), ['30/10/1965', 'review'], 'month/day swapped');
  assert.deepEqual(fix('31/02/1980', dob), [null, 'manual']);

  const email = fmt('^[^@ ]+@[^@ ]+[.][A-Za-z]{2,}$', { piiType: 'email' });
  assert.deepEqual(fix('a@x.com ', email), ['a@x.com', 'safe']);
  assert.deepEqual(fix('a@example.con', email), ['a@example.com', 'review']);
  assert.deepEqual(fix('a.example.com', email), [null, 'manual']);

  const phone = fmt('^([+]61 ?|0)[2-478]( ?[0-9]){8}$', { piiType: 'phone' });
  const shapes = { phoneShapes: { mobile: '9999 999 999', landline: '(99) 9999 9999' } };
  assert.equal(fix('+61491570118', phone, shapes), null, 'valid numbers are left alone');
  assert.deepEqual(fix('61 491 570 118', phone, shapes), ['0491 570 118', 'safe']);
  assert.deepEqual(fix('491570118', phone, shapes), ['0491 570 118', 'review']);
  assert.deepEqual(fix('55501865', phone, { ...shapes, areaCode: '08' }), ['(08) 5550 1865', 'review']);
  assert.deepEqual(fix('12', phone, shapes), [null, 'manual']);
});

test('code fixes keep the source vocabulary', () => {
  const rule = { rule_type: 'allowed_values', params: { values: ['SA'] } };
  assert.deepEqual(fix('S.A.', rule), ['SA', 'safe']);
  assert.deepEqual(fix('sa', rule), ['SA', 'safe']);
  assert.deepEqual(fix('South Australia', rule), ['SA', 'review']);
  assert.deepEqual(fix('NSW', rule), [null, 'manual']);
  assert.equal(fix('', rule), null, 'missing values are the not_null rule’s concern');
  const yn = { rule_type: 'allowed_values', params: { values: ['N', 'Y'] } };
  assert.deepEqual(fix('yes', yn), ['Y', 'review']);
  assert.deepEqual(fix('0', yn), [null, 'manual']);
});

test('buildCorrections: mappings, duplicates, one fix per field, groups', () => {
  const rows = [
    { id: '1', status: 'A', st: 'SA' },
    { id: '2', status: 'A', st: 'S.A.' },
    { id: '3', status: 'act', st: 'sa' },
    { id: '4', status: 'Active', st: 'SA' },
    { id: '4', status: 'Active', st: 'SA' },
    { id: '5', status: 'N/A', st: '' },
  ];
  const rules = [
    { column_name: 'status', rule_type: 'allowed_values', params: { codeSetId: 1, from: 'mapping' } },
    { column_name: 'st', rule_type: 'allowed_values', params: { values: ['SA'] } },
    { column_name: 'st', rule_type: 'not_null', params: {} },
    { column_name: 'id', rule_type: 'unique', params: { columns: ['id'] } },
  ];
  // Approved mapping: A, act, Active → ACTIVE (id 10); N/A → missing.
  const mappings = ['A', 'act', 'Active'].map((v) => ({ source_column: 'status', source_value: v, code_value_id: 10, code_set_id: 1 }));
  mappings.push({ source_column: 'status', source_value: 'N/A', code_value_id: null, code_set_id: 1 });
  const { changes, groups } = buildCorrections({ rows, rules, keyColumns: ['id'], mappings });

  const statusFixes = changes.filter((c) => c.column === 'status').map((c) => [c.key.id, c.old, c.new, c.safety]);
  assert.deepEqual(statusFixes, [['3', 'act', 'A', 'safe'], ['4', 'Active', 'A', 'safe']], 'A is the source’s own spelling of ACTIVE');
  assert.deepEqual(changes.filter((c) => c.column === 'st').map((c) => [c.key.id, c.new]), [['2', 'SA'], ['3', 'SA']]);
  assert.equal(changes.filter((c) => c.key.id === '4' && c.column === 'status').length, 1, 'duplicate rows give one change');
  const dup = groups.find((g) => g.fix === 'duplicate');
  assert.equal(dup.count, 2, 'only the repeated id 4 rows');
  assert.ok(groups.find((g) => g.fix === 'missing_value' && g.column === 'st'));
  assert.equal(changes.some((c) => c.key.id === '5'), false, "'N/A' is missing: left to not_null, never sent");
  assert.deepEqual(groups.map((g) => g.safety), [...groups.map((g) => g.safety)].sort((a, b) => ['safe', 'review', 'manual'].indexOf(a) - ['safe', 'review', 'manual'].indexOf(b)));
});
