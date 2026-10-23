// Integration test for saved data models against a real Postgres.
// Runs only when ERD_TEST_PGHOST is set (see refdata.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const enabled = Boolean(process.env.ERD_TEST_PGHOST);
const REF = `refdata_models_${process.pid}`;
const BUILD = `ddl_models_${process.pid}`;
let datamodels;
let lakebase;

before(async () => {
  if (!enabled) return;
  Object.assign(process.env, {
    PGHOST: process.env.ERD_TEST_PGHOST,
    PGUSER: process.env.ERD_TEST_PGUSER ?? 'postgres',
    PGPASSWORD: process.env.ERD_TEST_PGPASSWORD ?? '',
    PGDATABASE: process.env.ERD_TEST_PGDATABASE ?? 'postgres',
    PGSSLMODE: process.env.ERD_TEST_PGSSLMODE ?? 'disable',
    ERD_REFDATA_SCHEMA: REF,
    ERD_STEWARDS: 'steward@x.com',
  });
  lakebase = await import('./lakebase.js');
  datamodels = await import('./datamodels.js');
});

after(async () => {
  if (!enabled) return;
  await lakebase.query(`DROP SCHEMA IF EXISTS ${REF} CASCADE; DROP SCHEMA IF EXISTS ${BUILD} CASCADE`);
  await lakebase.close();
});

const content = (n) => ({
  tables: Array.from({ length: n }, (_, i) => ({
    name: `proposed_${i}`,
    columns: [{ name: 'id', type: 'bigint', pk: true }],
  })),
  positions: { 'maximo.proposed_0': { x: 10, y: 20 } },
});

test('data models: create, list, save with versions, conflicts, delete', { skip: !enabled }, async () => {
  const created = await datamodels.createModel(
    { name: 'Service requests', description: 'First cut', source: 'lakebase', scope: 'maximo', content: content(1) },
    'analyst@x.com',
  );
  assert.equal(created.version, 1);
  assert.deepEqual(created.content.positions, { 'maximo.proposed_0': { x: 10, y: 20 } });

  await assert.rejects(
    datamodels.createModel({ name: 'service REQUESTS', source: 'lakebase', scope: 'maximo', content: content(0) }, 'b@x.com'),
    (err) => err.status === 409 && /already exists/.test(err.message),
  );
  // Same name in another schema is fine.
  await datamodels.createModel({ name: 'Service requests', source: 'uc', scope: 'main.ops', content: content(0) }, 'b@x.com');
  await assert.rejects(
    datamodels.createModel({ name: 'Bad', source: 'lakebase', scope: 'maximo', content: { tables: [{ name: 'x y', columns: [] }] } }, 'b@x.com'),
    (err) => err.status === 400,
  );

  const list = await datamodels.listModels('lakebase', 'maximo');
  assert.deepEqual(list.map((m) => [m.name, m.entity_count]), [['Service requests', 1]]);

  const v2 = await datamodels.saveModel(created.id, { name: 'Service requests', content: content(2), version: 1 }, 'b@x.com');
  assert.equal(v2.version, 2);
  assert.equal(v2.updated_by, 'b@x.com');
  // A save based on version 1 now conflicts instead of overwriting b's work.
  await assert.rejects(
    datamodels.saveModel(created.id, { name: 'Service requests', content: content(3), version: 1 }, 'analyst@x.com'),
    (err) => err.status === 409 && /b@x.com saved this model \(version 2\)/.test(err.message),
  );

  const versions = await datamodels.listVersions(created.id);
  assert.deepEqual(versions.map((v) => [v.version, v.saved_by, v.entity_count]), [[2, 'b@x.com', 2], [1, 'analyst@x.com', 1]]);
  const old = await datamodels.getVersion(created.id, 1);
  assert.equal(old.content.tables.length, 1);
  assert.equal(old.description, 'First cut');

  await assert.rejects(datamodels.deleteModel(created.id, 'b@x.com'), (err) => err.status === 403);
  await datamodels.deleteModel(created.id, 'analyst@x.com');
  await assert.rejects(datamodels.getModel(created.id), (err) => err.status === 404);
  assert.deepEqual(await datamodels.listVersions(created.id), [], 'history goes with the model');
});

test('generated Postgres DDL runs and creates the keys and comments', { skip: !enabled }, async () => {
  const { applyProposals, validateProposal } = await import('../src/lib/proposals.js');
  const { generateDdl } = await import('../src/lib/ddl.js');
  await lakebase.query(`CREATE SCHEMA ${BUILD}; CREATE TABLE ${BUILD}.asset (assetnum text PRIMARY KEY, siteid text)`);
  const erd = await lakebase.getErd(BUILD);
  const proposal = validateProposal({
    tables: [
      {
        name: 'work_task',
        columns: [
          { name: 'task_id', type: 'bigint', pk: true },
          { name: 'request_id', type: 'bigint', nullable: false, references: { table: `${BUILD}.work_request`, column: 'request_id' } },
        ],
      },
      {
        name: 'work_request',
        comment: "Customer's request",
        columns: [
          { name: 'request_id', type: 'bigint', pk: true },
          { name: 'assetnum', type: 'text', nullable: false, references: { table: `${BUILD}.asset`, column: 'assetnum' }, comment: 'Asset to work on' },
          { name: 'site', type: 'text', references: { table: `${BUILD}.asset`, column: 'siteid' } },
          { name: 'parent_id', type: 'bigint', references: { table: `${BUILD}.work_request`, column: 'request_id' } },
          { name: 'raised_at', type: 'timestamptz', nullable: false },
          { name: 'cost', type: 'numeric(18,2)' },
        ],
      },
    ],
  });
  const { model } = applyProposals(erd, { source: 'lakebase', scope: BUILD, proposal });
  await lakebase.query(generateDdl(model, { source: 'lakebase' }));

  // The schema now reads back as the proposal: keys, foreign keys and comments.
  const built = await lakebase.getErd(BUILD);
  const request = built.tables.find((t) => t.name === 'work_request');
  assert.deepEqual(
    request.columns.map((c) => [c.name, c.type, c.nullable, c.pk]),
    [
      ['request_id', 'bigint', false, true],
      ['assetnum', 'text', false, false],
      ['site', 'text', true, false],
      ['parent_id', 'bigint', true, false],
      ['raised_at', 'timestamp with time zone', false, false],
      ['cost', 'numeric(18,2)', true, false],
    ],
  );
  assert.equal(request.comment, "Customer's request");
  assert.equal(request.columns[1].comment, 'Asset to work on');
  assert.deepEqual(
    built.relationships.map((r) => `${r.from.table}.${r.from.columns} → ${r.to.table}.${r.to.columns}`).sort(),
    [
      `${BUILD}.work_request.assetnum → ${BUILD}.asset.assetnum`,
      `${BUILD}.work_request.parent_id → ${BUILD}.work_request.request_id`,
      `${BUILD}.work_task.request_id → ${BUILD}.work_request.request_id`,
    ],
  );
  // Once built, the proposals show as built rather than proposed.
  assert.deepEqual(applyProposals(built, { source: 'lakebase', scope: BUILD, proposal }).built, ['work_task', 'work_request']);
});
