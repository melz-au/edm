import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProposals,
  freeSpot,
  placeNodes,
  referenceTargets,
  removeEntity,
  scopeName,
  upsertEntity,
  validateProposal,
} from './proposals.js';
import { deriveView } from './modelLevels.js';

const base = {
  tables: [
    {
      id: 'maximo.asset',
      name: 'asset',
      schema: 'maximo',
      type: 'TABLE',
      columns: [
        { name: 'assetnum', type: 'text', nullable: false, pk: true, fk: false },
        { name: 'siteid', type: 'text', nullable: true, pk: false, fk: false },
      ],
    },
    { id: 'other.site', name: 'site', schema: 'other', external: true, columns: [{ name: 'siteid', type: '', pk: true }] },
  ],
  relationships: [],
};

const request = {
  name: 'service_request',
  comment: 'A customer request',
  columns: [
    { name: 'request_id', type: 'bigint', pk: true },
    { name: 'assetnum', type: 'text', nullable: false, references: { table: 'maximo.asset', column: 'assetnum' } },
    { name: 'parent_id', type: 'bigint', references: { table: 'maximo.service_request', column: 'request_id' } },
  ],
};

test('scopeName per source', () => {
  assert.equal(scopeName('uc', 'main', 'sales'), 'main.sales');
  assert.equal(scopeName('uc', 'main', ''), null);
  assert.equal(scopeName('lakebase', '', 'maximo'), 'maximo');
  assert.equal(scopeName('demo'), 'demo.retail');
});

test('validateProposal normalises and rejects bad input', () => {
  const v = validateProposal({ tables: [{ ...request, name: ' service_request ' }], positions: { a: { x: 1.4, y: 2 }, b: { x: 'x' } } });
  assert.equal(v.tables[0].name, 'service_request');
  assert.equal(v.tables[0].columns[0].nullable, false, 'primary keys are required');
  assert.equal(v.tables[0].columns[2].nullable, true);
  assert.deepEqual(v.positions, { a: { x: 1, y: 2 } });

  const bad = (tables, re) => assert.throws(() => validateProposal({ tables }), re);
  bad([{ name: 'bad name', columns: [{ name: 'a', type: 'int' }] }], /valid entity name/);
  bad([{ name: 'x', columns: [] }], /at least one column/);
  bad([{ name: 'x', columns: [{ name: 'a', type: 'int' }, { name: 'A', type: 'int' }] }], /more than one column called A/);
  bad([{ name: 'x', columns: [{ name: 'a', type: 'int; DROP TABLE y' }] }], /valid data type/);
  bad([{ name: 'x', columns: [{ name: 'a', type: 'int' }] }, { name: 'X', columns: [{ name: 'a', type: 'int' }] }], /more than one proposed entity/);
  for (const type of ['DECIMAL(18,2)', 'varchar(255)', 'timestamptz', 'text[]', 'double precision']) {
    assert.doesNotThrow(() => validateProposal({ tables: [{ name: 'x', columns: [{ name: 'a', type }] }] }), type);
  }
});

test('applyProposals adds entities and relationships, including self-references', () => {
  const proposal = validateProposal({ tables: [request] });
  const { model, built, broken } = applyProposals(base, { source: 'lakebase', scope: 'maximo', proposal });
  assert.deepEqual(built, []);
  assert.deepEqual(broken, []);
  const t = model.tables.find((x) => x.id === 'maximo.service_request');
  assert.equal(t.proposed, true);
  assert.equal(t.schema, 'maximo');
  assert.deepEqual(t.columns.map((c) => c.fk), [false, true, true]);
  const rels = model.relationships.filter((r) => r.proposed);
  assert.deepEqual(rels.map((r) => `${r.from.table}.${r.from.columns} → ${r.to.table}.${r.to.columns}`), [
    'maximo.service_request.assetnum → maximo.asset.assetnum',
    'maximo.service_request.parent_id → maximo.service_request.request_id',
  ]);
  // Cardinality comes from the proposed keys, like any other table.
  const view = deriveView(model, 'logical');
  assert.equal(view.relationships.find((r) => r.from.columns[0] === 'assetnum').parentEnd, 'one');
  assert.equal(view.relationships.find((r) => r.from.columns[0] === 'parent_id').parentEnd, 'zero-one');
});

test('applyProposals: unity catalog scope parts, built entities and broken references', () => {
  const proposal = validateProposal({
    tables: [
      { name: 'asset', columns: [{ name: 'assetnum', type: 'text', pk: true }] },
      { name: 'work', columns: [{ name: 'id', type: 'int', pk: true }, { name: 'x', type: 'int', references: { table: 'maximo.gone', column: 'id' } }] },
    ],
  });
  const res = applyProposals(base, { source: 'lakebase', scope: 'maximo', proposal });
  assert.deepEqual(res.built, ['asset']);
  assert.equal(res.model.tables.filter((t) => t.name === 'asset').length, 1, 'built entity is not drawn twice');
  assert.deepEqual(res.broken, ['work.x → maximo.gone.id']);

  const uc = applyProposals({ tables: [], relationships: [] }, { source: 'uc', scope: 'main.sales', proposal });
  assert.deepEqual(
    uc.model.tables.map((t) => [t.id, t.catalog, t.schema]),
    [['main.sales.asset', 'main', 'sales'], ['main.sales.work', 'main', 'sales']],
  );
});

test('a proposed entity replaces the external stub with the same id', () => {
  const proposal = validateProposal({ tables: [{ name: 'site', columns: [{ name: 'siteid', type: 'text', pk: true }] }] });
  const { model } = applyProposals(base, { source: 'lakebase', scope: 'other', proposal });
  const sites = model.tables.filter((t) => t.id === 'other.site');
  assert.equal(sites.length, 1);
  assert.equal(sites[0].proposed, true);
});

test('upsertEntity renames references and positions; removeEntity clears them', () => {
  let p = validateProposal({ tables: [request], positions: { 'maximo.service_request': { x: 5, y: 6 } } });
  p = upsertEntity(p, 'maximo', { name: 'work_item', columns: [{ name: 'id', type: 'int', pk: true }] });
  p = upsertEntity(
    p,
    'maximo',
    { ...p.tables[0], name: 'request' },
    'service_request',
  );
  assert.deepEqual(p.tables.map((t) => t.name), ['request', 'work_item']);
  assert.equal(p.tables[0].columns[2].references.table, 'maximo.request', 'self-reference follows the rename');
  assert.deepEqual(p.positions, { 'maximo.request': { x: 5, y: 6 } });

  p = upsertEntity(p, 'maximo', {
    name: 'work_item',
    columns: [{ name: 'id', type: 'int', pk: true }, { name: 'request_id', type: 'bigint', references: { table: 'maximo.request', column: 'request_id' } }],
  }, 'work_item');
  const removed = removeEntity(p, 'maximo', 'request');
  assert.deepEqual(removed.tables.map((t) => t.name), ['work_item']);
  assert.equal(removed.tables[0].columns[1].references, undefined);
  assert.deepEqual(removed.positions, {});
  const built = removeEntity(p, 'maximo', 'request', { keepReferences: true });
  assert.equal(built.tables[0].columns[1].references.table, 'maximo.request');
});

test('referenceTargets offers primary keys, or every column when a table has none', () => {
  const model = {
    tables: [
      ...base.tables,
      { id: 'maximo.log', name: 'log', columns: [{ name: 'a', type: 'int' }, { name: 'b', type: 'int' }] },
    ],
  };
  assert.deepEqual(
    referenceTargets(model, 'maximo.asset').map((t) => `${t.table}.${t.column}`),
    ['other.site.siteid', 'maximo.log.a', 'maximo.log.b'],
  );
});

test('placeNodes keeps known positions and puts the rest below them', () => {
  const nodes = [
    { id: 'a', position: { x: 0, y: 0 } },
    { id: 'b', position: { x: 300, y: 50 } },
    { id: 'c', position: { x: 600, y: 80 } },
  ];
  const placed = placeNodes(nodes, { a: { x: 10, y: 20 } });
  assert.deepEqual(placed[0].position, { x: 10, y: 20 });
  assert.deepEqual(placed[1].position, { x: 10, y: 420 });
  assert.deepEqual(placed[2].position, { x: 310, y: 450 });
  assert.equal(placeNodes(nodes, {}), nodes);
});

test('freeSpot finds the nearest gap clear of other tables', () => {
  const size = { width: 100, height: 100 };
  assert.deepEqual(freeSpot([], { x: 0, y: 0 }, size), { x: 0, y: 0 });
  const rects = [{ x: -50, y: -50, width: 200, height: 200 }];
  const spot = freeSpot(rects, { x: 0, y: 0 }, size);
  const r = rects[0];
  const clear = spot.x + 100 + 40 <= r.x || r.x + r.width + 40 <= spot.x || spot.y + 100 + 40 <= r.y || r.y + r.height + 40 <= spot.y;
  assert.ok(clear, JSON.stringify(spot));
  assert.ok(Math.hypot(spot.x, spot.y) <= 200, 'stays close to the preferred spot');
});
