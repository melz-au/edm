import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoModel, inferRelationships } from './model.js';
import { buildModelFromPgRows } from './lakebase.js';

const table = (name, cols) => ({
  id: `s.${name}`,
  name,
  schema: 's',
  columns: cols.map(([n, pk]) => ({ name: n, type: 'int', nullable: true, pk: Boolean(pk), fk: false })),
});

test('inferRelationships matches plural tables and pk columns', () => {
  const model = {
    tables: [
      table('customers', [['id', true], ['name']]),
      table('categories', [['category_id', true]]),
      table('orders', [['id', true], ['customer_id'], ['category_id'], ['ext_id']]),
    ],
    relationships: [],
  };
  const out = inferRelationships(model).relationships;
  assert.deepEqual(
    out.map((r) => `${r.from.table}.${r.from.columns} -> ${r.to.table}.${r.to.columns}`).sort(),
    ['s.orders.category_id -> s.categories.category_id', 's.orders.customer_id -> s.customers.id'],
  );
  assert.ok(out.every((r) => r.inferred));
});

test('inferRelationships does not duplicate declared keys or self-link a pk', () => {
  const model = demoModel();
  const out = inferRelationships(model);
  assert.equal(out.relationships.length, model.relationships.length);
});

test('buildModelFromPgRows maps constraints', () => {
  const cols = [
    { schema_name: 's', table_name: 'a', relkind: 'r', column_name: 'id', data_type: 'int', nullable: false },
    { schema_name: 's', table_name: 'b', relkind: 'v', column_name: 'a_id', data_type: 'int', nullable: true },
  ];
  const cons = [
    { name: 'a_pkey', type: 'p', table_name: 'a', columns: ['id'] },
    { name: 'b_fk', type: 'f', table_name: 'b', columns: ['a_id'], ref_schema: 's', ref_table: 'a', ref_columns: ['id'] },
  ];
  const m = buildModelFromPgRows('s', cols, cons);
  assert.equal(m.tables[0].columns[0].pk, true);
  assert.equal(m.tables[1].type, 'VIEW');
  assert.equal(m.tables[1].columns[0].fk, true);
  assert.deepEqual(m.relationships[0].to, { table: 's.a', columns: ['id'] });
});
