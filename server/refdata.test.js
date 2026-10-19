// Integration test for the approval workflow against a real Postgres.
// Runs only when ERD_TEST_PGHOST is set, e.g.:
//   ERD_TEST_PGHOST=localhost ERD_TEST_PGUSER=postgres ERD_TEST_PGPASSWORD=pw npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const enabled = Boolean(process.env.ERD_TEST_PGHOST);
const suffix = `${process.pid}`;
const REF = `refdata_test_${suffix}`;
const MASTER = `master_test_${suffix}`;
let refdata;
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
    ERD_STEWARDS: 'steward@x.com,steward2@x.com',
  });
  lakebase = await import('./lakebase.js');
  refdata = await import('./refdata.js');
  await lakebase.query(`CREATE SCHEMA ${MASTER};
    CREATE TABLE ${MASTER}.site (siteid text PRIMARY KEY, name text NOT NULL, status text);
    INSERT INTO ${MASTER}.site VALUES ('METRO', 'Metro', 'ACTIVE'), ('NORTH', 'North', 'ACTIVE');`);
});

after(async () => {
  if (!enabled) return;
  await lakebase.query(`DROP SCHEMA IF EXISTS ${MASTER} CASCADE; DROP SCHEMA IF EXISTS ${REF} CASCADE;`);
  await lakebase.close();
});

test('code set lifecycle: propose, approve, update value, audit', { skip: !enabled }, async () => {
  const cr = await refdata.proposeChange(
    {
      kind: 'code_set',
      action: 'create',
      payload: { name: 'Site Status', values: [{ code: 'ACTIVE', label: 'Active' }, { code: 'CLOSED' }] },
    },
    'analyst@x.com',
  );
  assert.equal(cr.status, 'pending');
  await assert.rejects(refdata.reviewChange(cr.id, { decision: 'approve' }, 'analyst@x.com'), /stewards/);

  const applied = await refdata.reviewChange(cr.id, { decision: 'approve' }, 'steward@x.com');
  assert.equal(applied.status, 'applied');
  const set = await refdata.getCodeSet(applied.target.codeSetId);
  assert.deepEqual(set.values.map((v) => v.code), ['ACTIVE', 'CLOSED']);

  await assert.rejects(
    refdata.proposeChange({ kind: 'code_set', action: 'create', payload: { name: 'site status', values: [] } }, 'a@x.com'),
    /already exists/,
  );

  const closed = set.values.find((v) => v.code === 'CLOSED');
  const deactivate = await refdata.proposeChange(
    { kind: 'code_value', action: 'update', target: { codeSetId: set.id, codeValueId: closed.id }, payload: { active: false } },
    'analyst@x.com',
  );
  assert.match(deactivate.summary, /Deactivate code "CLOSED"/);
  assert.equal((await refdata.reviewChange(deactivate.id, { decision: 'approve' }, 'steward@x.com')).status, 'applied');
  assert.equal((await refdata.getCodeSet(set.id)).values.find((v) => v.code === 'CLOSED').active, false);

  const audit = await refdata.auditLog();
  assert.equal(audit.length, 2);
  assert.equal(audit[0].approved_by, 'steward@x.com');
});

test('master row edits are approved, conflict-checked and audited', { skip: !enabled }, async () => {
  const target = { schema: MASTER, table: 'site', key: { siteid: 'METRO' } };
  const cr = await refdata.proposeChange(
    { kind: 'master_row', action: 'update', target, payload: { name: 'Metropolitan', status: 'ACTIVE' } },
    'analyst@x.com',
  );
  assert.deepEqual(cr.payload, { name: 'Metropolitan' }, 'unchanged columns are dropped');
  assert.deepEqual(cr.previous, { name: 'Metro' });

  // Someone edits the row directly before approval → the change fails safely.
  await lakebase.query(`UPDATE ${MASTER}.site SET name = 'Metro Region' WHERE siteid = 'METRO'`);
  const failed = await refdata.reviewChange(cr.id, { decision: 'approve' }, 'steward@x.com');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /changed since/);

  const retry = await refdata.proposeChange({ kind: 'master_row', action: 'update', target, payload: { name: 'Metropolitan' } }, 'analyst@x.com');
  assert.equal((await refdata.reviewChange(retry.id, { decision: 'approve' }, 'steward@x.com')).status, 'applied');
  const { rows } = await lakebase.query(`SELECT name FROM ${MASTER}.site WHERE siteid = 'METRO'`);
  assert.equal(rows[0].name, 'Metropolitan');

  // Create and delete.
  const add = await refdata.proposeChange(
    { kind: 'master_row', action: 'create', target: { schema: MASTER, table: 'site' }, payload: { siteid: 'SOUTH', name: 'South' } },
    'analyst@x.com',
  );
  assert.equal((await refdata.reviewChange(add.id, { decision: 'approve' }, 'steward@x.com')).status, 'applied');
  const del = await refdata.proposeChange(
    { kind: 'master_row', action: 'delete', target: { schema: MASTER, table: 'site', key: { siteid: 'NORTH' } } },
    'analyst@x.com',
  );
  assert.equal((await refdata.reviewChange(del.id, { decision: 'approve' }, 'steward2@x.com')).status, 'applied');
  const { rows: sites } = await lakebase.query(`SELECT siteid FROM ${MASTER}.site ORDER BY 1`);
  assert.deepEqual(sites.map((r) => r.siteid), ['METRO', 'SOUTH']);
});

test('guards: own requests, unknown columns, protected schema, cancel and reject', { skip: !enabled }, async () => {
  const own = await refdata.proposeChange(
    { kind: 'master_row', action: 'update', target: { schema: MASTER, table: 'site', key: { siteid: 'SOUTH' } }, payload: { status: 'X' } },
    'steward@x.com',
  );
  await assert.rejects(refdata.reviewChange(own.id, { decision: 'approve' }, 'steward@x.com'), /your own/);
  assert.equal((await refdata.reviewChange(own.id, { decision: 'reject', comment: 'no' }, 'steward2@x.com')).status, 'rejected');
  await assert.rejects(refdata.reviewChange(own.id, { decision: 'approve' }, 'steward2@x.com'), /already rejected/);

  await assert.rejects(
    refdata.proposeChange({ kind: 'master_row', action: 'update', target: { schema: MASTER, table: 'site', key: { siteid: 'SOUTH' } }, payload: { nope: 1 } }, 'a@x.com'),
    /Unknown columns/,
  );
  await assert.rejects(
    refdata.proposeChange({ kind: 'master_row', action: 'delete', target: { schema: REF, table: 'code_set', key: { id: 1 } } }, 'a@x.com'),
    /managed through code sets/,
  );
  await assert.rejects(
    refdata.proposeChange({ kind: 'master_row', action: 'update', target: { schema: MASTER, table: 'nope', key: {} }, payload: {} }, 'a@x.com'),
    /not found/,
  );

  const mine = await refdata.proposeChange({ kind: 'code_set', action: 'create', payload: { name: 'Temp', values: [] } }, 'a@x.com');
  await assert.rejects(refdata.cancelChange(mine.id, 'b@x.com'), /Only the requester/);
  assert.equal((await refdata.cancelChange(mine.id, 'a@x.com')).status, 'cancelled');
  assert.equal(await refdata.pendingCount(), 0);
});

test('code mappings: propose, approve, conflict check, view, remove', { skip: !enabled }, async () => {
  const set = await refdata.proposeChange(
    { kind: 'code_set', action: 'create', payload: { name: 'Account Status', values: [{ code: 'ACTIVE' }, { code: 'CLOSED' }] } },
    'analyst@x.com',
  );
  const { target: { codeSetId } } = await refdata.reviewChange(set.id, { decision: 'approve' }, 'steward@x.com');
  const codes = Object.fromEntries((await refdata.getCodeSet(codeSetId)).values.map((v) => [v.code, v.id]));
  const source = { system: 'lakebase', table: 'billing.customer_master', column: 'ACCT_STATUS' };

  const cr = await refdata.proposeChange(
    {
      kind: 'code_mapping',
      action: 'create',
      target: { codeSetId, source },
      payload: { mappings: [{ value: 'A', codeValueId: codes.ACTIVE }, { value: 'Closed ', codeValueId: codes.CLOSED }, { value: 'N/A', codeValueId: null }] },
    },
    'analyst@x.com',
  );
  assert.match(cr.summary, /Map 3 values of billing.customer_master.ACCT_STATUS to Account Status/);
  assert.equal(cr.payload.codes[codes.ACTIVE], 'ACTIVE');
  assert.equal((await refdata.reviewChange(cr.id, { decision: 'approve' }, 'steward@x.com')).status, 'applied');

  const { rows } = await lakebase.query(
    `SELECT source_value, code, maps_to_missing FROM ${REF}.code_mapping_v WHERE source_column = 'ACCT_STATUS' ORDER BY 1`,
  );
  assert.deepEqual(rows.map((r) => [r.source_value, r.code, r.maps_to_missing]), [
    ['A', 'ACTIVE', false], ['Closed ', 'CLOSED', false], ['N/A', null, true],
  ]);

  await assert.rejects(
    refdata.proposeChange({ kind: 'code_mapping', action: 'create', target: { codeSetId, source }, payload: { mappings: [{ value: 'A', codeValueId: codes.ACTIVE }] } }, 'a@x.com'),
    /already mapped that way/,
  );
  await assert.rejects(
    refdata.proposeChange({ kind: 'code_mapping', action: 'create', target: { codeSetId, source }, payload: { mappings: [{ value: 'X', codeValueId: 99999 }] } }, 'a@x.com'),
    /is not in Account Status/,
  );

  // Two competing remaps: the second approval fails the conflict check.
  const r1 = await refdata.proposeChange({ kind: 'code_mapping', action: 'create', target: { codeSetId, source }, payload: { mappings: [{ value: 'A', codeValueId: codes.CLOSED }] } }, 'a@x.com');
  const r2 = await refdata.proposeChange({ kind: 'code_mapping', action: 'create', target: { codeSetId, source }, payload: { mappings: [{ value: 'A', codeValueId: null }] } }, 'b@x.com');
  assert.equal((await refdata.reviewChange(r1.id, { decision: 'approve' }, 'steward@x.com')).status, 'applied');
  const failed = await refdata.reviewChange(r2.id, { decision: 'approve' }, 'steward@x.com');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Mappings changed/);

  const del = await refdata.proposeChange({ kind: 'code_mapping', action: 'delete', target: { codeSetId, source }, payload: { values: ['N/A'] } }, 'a@x.com');
  assert.equal((await refdata.reviewChange(del.id, { decision: 'approve' }, 'steward@x.com')).status, 'applied');
  assert.deepEqual((await refdata.listMappings(codeSetId)).map((m) => m.source_value), ['A', 'Closed ']);
  assert.equal((await refdata.mappingsForSource('lakebase', 'billing.customer_master', 'ACCT_STATUS')).length, 2);
});
