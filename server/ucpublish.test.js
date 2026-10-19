import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatements, literal, replaceTableSql, validTarget } from './ucpublish.js';

test('literals escape for Databricks SQL', () => {
  assert.equal(literal("O'Connor", 'STRING'), "'O\\'Connor'");
  assert.equal(literal('C:\\temp', 'STRING'), "'C:\\\\temp'");
  assert.equal(literal('Closed ', 'STRING'), "'Closed '");
  assert.equal(literal(null, 'STRING'), 'NULL');
  assert.equal(literal(false, 'BOOLEAN'), 'false');
  assert.equal(literal('7', 'INT'), '7');
  assert.throws(() => literal('7; DROP', 'INT'));
  assert.equal(literal('2026-10-19 19:29:34.123+00', 'TIMESTAMP'), "'2026-10-19T19:29:34.123Z'");
});

test('targets must be catalog.schema', () => {
  assert.equal(validTarget('main.refdata'), true);
  assert.equal(validTarget('main'), false);
  assert.equal(validTarget('main.ref data'), false);
  assert.equal(validTarget('a.b.c'), false);
  assert.equal(validTarget('main.`x`; DROP'), false);
});

test('replace statements are typed Delta CTAS, with an empty-table form', () => {
  const sql = replaceTableSql('main.refdata', 'code_value', [
    { id: 1, code_set_id: 1, code_set: 'Status', code: 'A', label: null, description: null, sort_order: 1, active: true, updated_at: null, updated_by: 'x' },
  ], '2026-10-19T00:00:00Z');
  assert.match(sql, /^CREATE OR REPLACE TABLE `main`\.`refdata`\.`code_value`\nUSING DELTA\nCOMMENT '/);
  assert.match(sql, /CAST\(c7 AS BOOLEAN\) AS `active`/);
  assert.match(sql, /\(1, 1, 'Status', 'A', NULL, NULL, 1, true, NULL, 'x'\)/);
  assert.doesNotMatch(sql, /WHERE false/);
  const empty = replaceTableSql('main.refdata', 'code_mapping', [], 'now');
  assert.match(empty, /FROM VALUES\n {2}\(NULL(, NULL){12}\)\nAS v\(c0, .*c12\)\nWHERE false$/);
});

test('buildStatements covers the three tables with row counts', () => {
  const s = buildStatements('main.refdata', { code_set: [{ id: 1, name: 'S' }], code_value: [], code_mapping: [] });
  assert.deepEqual(s.map((x) => [x.table, x.rows]), [['code_set', 1], ['code_value', 0], ['code_mapping', 0]]);
});
