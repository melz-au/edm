// Integration test for saved data models against a real Postgres.
// Runs only when ERD_TEST_PGHOST is set (see refdata.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const enabled = Boolean(process.env.ERD_TEST_PGHOST);
const REF = `refdata_models_${process.pid}`;
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
  await lakebase.query(`DROP SCHEMA IF EXISTS ${REF} CASCADE`);
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
