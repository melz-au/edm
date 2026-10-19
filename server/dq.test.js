import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dominantShape, ruleSql, shapeOf, shapeRegex, suggestRules } from './dq.js';

test('shapes and shape regexes', () => {
  assert.equal(shapeOf('WC-2514886'), 'AA-9999999');
  assert.equal(shapeRegex('AA-9999999'), '^[A-Z]{2}[-][0-9]{7}$');
  assert.equal(shapeRegex('(99) 9999 9999'), '^[(][0-9]{2}[)] [0-9]{4} [0-9]{4}$');
  assert.equal(shapeRegex('9999.9'), '^[0-9]{4}[.][0-9]$');
  for (const v of ['WC-2514886', '30/10/1965', '+61491570118', '(08) 5550 1865', '3.74235E+7']) {
    assert.ok(new RegExp(shapeRegex(shapeOf(v))).test(v), v);
  }
  const dates = [...Array(12).fill('30/10/1965'), '1965-10-30', '18-AUG-26'];
  assert.deepEqual(dominantShape(dates), { pattern: '99/99/9999', regex: '^[0-9]{2}/[0-9]{2}/[0-9]{4}$', share: 0.857, shapes: 3 });
  assert.equal(dominantShape(['a', 'b']), null, 'too few values');
  assert.equal(dominantShape(Array.from({ length: 20 }, (_, i) => `Note number ${i} about things`)), null, 'free text');
});

const col = (name, type = 'text', extra = {}) => ({ name, type, pk: false, fk: false, ...extra });
const prof = (sampled, columns) => ({ sampled, columns });

test('suggestions from a profile', () => {
  const table = {
    id: 's.customer',
    columns: [col('id', 'integer', { pk: true }), col('acct_no'), col('status'), col('state'), col('email'), col('dob', 'date'), col('notes'), col('region_id', 'integer', { fk: true })],
  };
  const profile = prof(100, [
    { name: 'id', filled: 100 },
    { name: 'acct_no', filled: 100, distinct: 96, nonNull: 100, shape: { pattern: 'AA9999999', regex: '^[A-Z]{2}[0-9]{7}$', share: 0.6, shapes: 3 } },
    { name: 'status', filled: 100, distinct: 3, nonNull: 100, categorical: true, topValues: [{ value: 'OPEN', count: 70 }, { value: 'CLOSED', count: 28 }, { value: 'HOLD', count: 2 }] },
    { name: 'state', filled: 99, distinct: 4, nonNull: 99, categorical: true, topValues: [{ value: 'SA', count: 80 }, { value: 'S.A.', count: 10 }, { value: 'NSW', count: 1 }, { value: 'N/A', count: 8 }] },
    { name: 'email', filled: 90, distinct: 90, nonNull: 90, pii: { type: 'email', label: 'Email address' } },
    { name: 'dob', filled: 50 },
    { name: 'notes', filled: 30, shape: null },
    { name: 'region_id', filled: 100 },
  ]);
  const relationships = [{ name: 'fk_region', from: { table: 's.customer', columns: ['region_id'] }, to: { table: 's.region', columns: ['id'] } }];
  const s = suggestRules({ table, profile, relationships });
  const find = (column, type) => s.find((r) => r.column === column && r.rule_type === type);

  assert.equal(find('id', 'unique').severity, 'error');
  assert.ok(find('id', 'not_null'));
  assert.match(find('acct_no', 'unique').reason, /4 repeated values/);
  assert.equal(find('acct_no', 'format').params.regex, '^[A-Z]{2}[0-9]{7}$');
  assert.deepEqual(find('status', 'allowed_values').params.values, ['OPEN', 'CLOSED', 'HOLD'], 'clean list keeps rare valid values');
  assert.deepEqual(find('state', 'allowed_values').params.values, ['SA'], 'variants fold into SA; NSW is rare; N/A is missing');
  assert.equal(find('email', 'format').params.piiType, 'email');
  assert.ok(find('dob', 'not_future'));
  assert.equal(find('dob', 'not_null'), undefined, 'only half filled');
  assert.equal(find('notes', 'not_null'), undefined);
  assert.deepEqual(find('region_id', 'references').params, { parentTable: 's.region', parentColumn: 'id' });

  const mapped = suggestRules({ table, profile, codeSets: [{ column: 'status', codeSetId: 7, name: 'Status', from: 'mapping' }] });
  assert.deepEqual(mapped.find((r) => r.column === 'status' && r.rule_type === 'allowed_values').params, { codeSetId: 7, from: 'mapping' });
});

test('rule SQL per dialect', () => {
  const r = (rule_type, column, params = {}) => ({ rule_type, column, params });
  const nn = ruleSql('pg', '"s"."t"', r('not_null', 'email'));
  assert.match(nn.countSql, /t\."email" IS NULL OR upper\(trim\(CAST\(t\."email" AS TEXT\)\)\) IN \('', 'NULL'/);
  const fmt = ruleSql('spark', '`c`.`s`.`t`', r('format', 'pcode', { regex: '^[0-9]{4}$' }));
  assert.match(fmt.countSql, /CAST\(t\.`pcode` AS STRING\) RLIKE '\^\[0-9\]\{4\}\$'/);
  assert.match(fmt.countSql, /NOT \(t\.`pcode` IS NULL OR/, 'missing values are left to not_null');
  const av = ruleSql('pg', '"t"', r('allowed_values', 'state', { values: ["SA", "O'Brien"] }));
  assert.match(av.countSql, /NOT IN \('SA', 'O''Brien'\)/);
  const spark = ruleSql('spark', '`t`', r('allowed_values', 'state', { values: ["O'Brien"] }));
  assert.match(spark.countSql, /NOT IN \('O\\'Brien'\)/);
  const uq = ruleSql('pg', '"t"', r('unique', 'a,b', { columns: ['a', 'b'] }));
  assert.match(uq.countSql, /count\(\*\) OVER \(PARTITION BY t\."a", t\."b"\) AS dq_cnt/);
  assert.match(uq.sampleSql, /concat_ws\(' \| '/);
  const ref = ruleSql('pg', '"s"."asset"', r('references', 'location', { parentColumn: 'location' }), { parentRef: '"s"."locations"' });
  assert.match(ref.countSql, /LEFT JOIN \(SELECT DISTINCT "location" AS k FROM "s"\."locations"\) p ON p\.k = t\."location"/);
});
