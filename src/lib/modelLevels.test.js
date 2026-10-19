import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeName, codeSetName, deriveView, entityName, logicalType } from './modelLevels.js';
import { demoModel } from '../../server/model.js';

test('names are humanised for logical and conceptual levels', () => {
  assert.equal(entityName('order_items'), 'Order Item');
  assert.equal(entityName('dim_customer'), 'Customer');
  assert.equal(entityName('categories'), 'Category');
  assert.equal(entityName('statuses'), 'Status');
  assert.equal(entityName('warehouses'), 'Warehouse');
  assert.equal(attributeName('customer_id'), 'Customer ID');
  assert.equal(attributeName('createdAt'), 'Created At');
});

test('physical types map onto logical types', () => {
  assert.equal(logicalType('bigint'), 'Integer');
  assert.equal(logicalType('character varying(20)'), 'Text');
  assert.equal(logicalType('decimal(12,2)'), 'Number');
  assert.equal(logicalType('timestamp with time zone'), 'Timestamp');
  assert.equal(logicalType('ARRAY<STRING>'), 'Structured');
});

test('physical view keeps names and types', () => {
  const view = deriveView(demoModel(), 'physical');
  const orders = view.tables.find((t) => t.name === 'orders');
  assert.equal(orders.label, 'orders');
  assert.equal(orders.columns.find((c) => c.name === 'total_amount').displayType, 'decimal(12,2)');
});

test('cardinality comes from nullability and keys', () => {
  const view = deriveView(demoModel(), 'logical');
  const rel = (from, col) => view.relationships.find((r) => r.from.table.endsWith(from) && r.from.columns[0] === col);
  assert.equal(rel('.orders', 'customer_id').parentEnd, 'one'); // NOT NULL
  assert.equal(rel('.orders', 'store_id').parentEnd, 'zero-one'); // nullable
  assert.equal(rel('.orders', 'customer_id').childEnd, 'many');
  assert.equal(rel('.orders', 'customer_id').label, 'Order N:1 Customer');

  const oneToOne = deriveView({
    tables: [
      { id: 's.users', name: 'users', columns: [{ name: 'id', type: 'int', pk: true, nullable: false }] },
      { id: 's.user_profiles', name: 'user_profiles', columns: [{ name: 'user_id', type: 'int', pk: true, fk: true, nullable: false }] },
    ],
    relationships: [{ id: 'r', name: 'r', from: { table: 's.user_profiles', columns: ['user_id'] }, to: { table: 's.users', columns: ['id'] } }],
  }, 'logical');
  assert.equal(oneToOne.relationships[0].cardinality, '1:1');
  assert.equal(oneToOne.relationships[0].childEnd, 'zero-one');
});

test('conceptual view collapses junction tables into many-to-many', () => {
  const model = demoModel();
  const view = deriveView(model, 'conceptual');
  const ids = view.tables.map((t) => t.name);
  assert.ok(!ids.includes('inventory'), 'inventory is a pure junction of stores and products');
  assert.ok(ids.includes('order_items'), 'order_items has its own key part (line_no)');
  const m2m = view.relationships.filter((r) => r.cardinality === 'M:N');
  assert.equal(m2m.length, 1);
  assert.equal(m2m[0].label, 'Store M:N Product (via Inventory)');
  assert.ok(!view.relationships.some((r) => r.from.table.endsWith('.inventory')));
  assert.equal(view.relationships.length, model.relationships.length - 2 + 1);
});

test('code set names avoid repeating the entity', () => {
  assert.equal(codeSetName('asset', 'assettype'), 'Asset Type');
  assert.equal(codeSetName('asset', 'status'), 'Asset Status');
  assert.equal(codeSetName('locations', 'type'), 'Location Type');
  assert.equal(codeSetName('orders', 'order_status'), 'Order Status');
});
