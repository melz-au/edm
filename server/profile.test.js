import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateColumns,
  classify,
  distinctValuesSql,
  profileSql,
  profileTable,
  quoteIdent,
  tableRef,
  topValuesSql,
} from './profile.js';

test('classify flags low-cardinality columns and rejects unique or varied ones', () => {
  assert.equal(classify({ name: 'status', distinct: 4, nonNull: 1016 }).categorical, true);
  assert.equal(classify({ name: 'status', distinct: 4, nonNull: 1016 }).confidence, 'high');
  assert.equal(classify({ name: 'manufacturer', distinct: 29, nonNull: 1016 }).confidence, 'medium');
  assert.equal(classify({ name: 'serialnum', distinct: 1016, nonNull: 1016 }).categorical, false);
  assert.equal(classify({ name: 'description', distinct: 400, nonNull: 1016 }).categorical, false);
  assert.equal(classify({ name: 'expected_life', distinct: 9, nonNull: 14 }).categorical, false);
  assert.equal(classify({ name: 'type', distinct: 3, nonNull: 8 }).categorical, true, 'name hint allows a higher ratio');
  assert.equal(classify({ name: 'x', distinct: 0, nonNull: 0 }).categorical, false);
});

test('candidateColumns skips single keys, foreign keys, measures, dates and blobs', () => {
  const cols = [
    { name: 'id', type: 'integer', pk: true },
    { name: 'status', type: 'text' },
    { name: 'parent_id', type: 'integer', fk: true },
    { name: 'price', type: 'numeric(12,2)' },
    { name: 'lat', type: 'numeric' },
    { name: 'qty', type: 'numeric(10,0)' },
    { name: 'created', type: 'timestamp with time zone' },
    { name: 'born', type: 'DATE' },
    { name: 'doc', type: 'jsonb' },
    { name: 'tags', type: 'ARRAY<STRING>' },
    { name: 'active', type: 'boolean' },
  ];
  assert.deepEqual(candidateColumns(cols, ['id']).map((c) => c.name), ['status', 'qty', 'active']);
  // Part of a composite key is still a candidate.
  assert.deepEqual(candidateColumns([{ name: 'attr', type: 'text', pk: true }], ['assetnum', 'attr']).map((c) => c.name), ['attr']);
});

test('identifiers are quoted per dialect, escaping embedded quotes', () => {
  assert.equal(quoteIdent('pg', 'we"ird'), '"we""ird"');
  assert.equal(quoteIdent('spark', 'we`ird'), '`we``ird`');
  assert.equal(tableRef('spark', ['main', 'sales', 'orders']), '`main`.`sales`.`orders`');
  assert.match(profileSql('pg', '"s"."t"', [{ name: 'status' }]), /count\(DISTINCT "status"\) AS d0, count\("status"\) AS nn0/);
  assert.match(topValuesSql('spark', '`t`', [{ name: 'status', index: 2 }]), /SELECT 2 AS i, CAST\(`status` AS STRING\)/);
  assert.match(distinctValuesSql('pg', '"t"', 'status'), /CAST\("status" AS TEXT\)/);
});

test('profileTable combines stats and top values in column order', async () => {
  const columns = [
    { name: 'id', type: 'integer', pk: true },
    { name: 'status', type: 'text' },
    { name: 'serial', type: 'text' },
  ];
  const statements = [];
  const run = async (sql) => {
    statements.push(sql);
    if (statements.length === 1) return [{ n: '100', d0: '3', nn0: '100', d1: '100', nn1: '100' }];
    return [
      { i: '0', v: 'OPEN', n: '60' },
      { i: '0', v: 'CLOSED', n: '30' },
      { i: '0', v: 'HOLD', n: '10' },
    ];
  };
  const result = await profileTable({ dialect: 'pg', ref: '"t"', columns, primaryKey: ['id'], run });
  assert.equal(result.sampled, 100);
  assert.deepEqual(result.columns.map((c) => c.name), ['id', 'status', 'serial']);
  const status = result.columns[1];
  assert.equal(status.categorical, true);
  assert.deepEqual(status.topValues.map((v) => v.value), ['OPEN', 'CLOSED', 'HOLD']);
  assert.equal(result.columns[2].categorical, false);
  assert.equal(result.columns[0].reason, 'primary key');
  assert.equal(statements.length, 2);
});
