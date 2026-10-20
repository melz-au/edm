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

test('publishing: settings, snapshot, run log, serialised runs and the applied hook', { skip: !enabled }, async () => {
  const ucpublish = await import('./ucpublish.js');
  await assert.rejects(refdata.setPublishSettings({ target: 'main.refdata' }, 'analyst@x.com'), /Only data stewards/);
  await assert.rejects(refdata.setPublishSettings({ target: 'nope' }, 'steward@x.com'), /catalog\.schema/);
  const settings = await refdata.setPublishSettings({ target: 'main.refdata', auto: true }, 'steward@x.com');
  assert.deepEqual([settings.target, settings.auto], ['main.refdata', true]);

  const statements = [];
  const fakeRun = async (sql) => {
    statements.push(sql);
    await new Promise((r) => setTimeout(r, 20));
    return [];
  };
  const run = await ucpublish.publish({ trigger: 'manual', user: 'steward@x.com', run: fakeRun });
  assert.equal(run.status, 'succeeded');
  assert.ok(run.counts.code_set >= 2 && run.counts.code_mapping >= 1, JSON.stringify(run.counts));
  assert.equal(statements.length, 3);
  assert.ok(statements.every((s) => s.startsWith('CREATE OR REPLACE TABLE `main`.`refdata`.')));

  // A publish requested while one runs is queued once, not run in parallel.
  statements.length = 0;
  const first = ucpublish.publish({ run: fakeRun });
  const second = ucpublish.publish({ run: fakeRun });
  assert.equal(first, second);
  await first;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(statements.length, 6, 'one queued re-run after the first');

  const failed = await ucpublish.publish({ run: async () => { throw new Error('PERMISSION_DENIED'); } }).catch((e) => e);
  assert.match(failed.message, /PERMISSION_DENIED/);
  const runs = await refdata.listPublishRuns();
  assert.equal(runs[0].status, 'failed');
  assert.match(runs[0].error, /PERMISSION_DENIED/);

  // The applied hook fires after an approval commits.
  const seen = [];
  refdata.onApplied((cr) => seen.push(cr.kind));
  const cr = await refdata.proposeChange({ kind: 'code_set', action: 'create', payload: { name: 'Hooked', values: [] } }, 'a@x.com');
  await refdata.reviewChange(cr.id, { decision: 'approve' }, 'steward@x.com');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, ['code_set']);
});

test('data quality rules run against Postgres, including orphaned references', { skip: !enabled }, async () => {
  const dqstore = await import('./dqstore.js');
  const dq = await import('./dq.js');
  await lakebase.query(`CREATE TABLE ${MASTER}.region (id int PRIMARY KEY);
    INSERT INTO ${MASTER}.region VALUES (1), (2);
    CREATE TABLE ${MASTER}.cust (id int, email text, region_id int, state text);
    INSERT INTO ${MASTER}.cust VALUES (1, 'a@x.com', 1, 'SA'), (2, 'bad-email', 2, 'S.A.'), (2, '', 9, 'N/A'), (4, NULL, NULL, 'SA');`);
  const table = `${MASTER}.cust`;
  await dqstore.addRules('lakebase', table, [
    { column: 'id', rule_type: 'unique', params: { columns: ['id'] }, severity: 'error', description: 'id unique' },
    { column: 'email', rule_type: 'not_null', params: {}, description: 'email filled' },
    { column: 'email', rule_type: 'format', params: { regex: '^[^@ ]+@[^@ ]+[.][A-Za-z]{2,}$', piiType: 'email' }, description: 'email format' },
    { column: 'region_id', rule_type: 'references', params: { parentTable: `${MASTER}.region`, parentColumn: 'id' }, description: 'region exists' },
    { column: 'state', rule_type: 'allowed_values', params: { values: ['SA'] }, description: 'state' },
    { column: 'nope', rule_type: 'not_null', params: {}, description: 'gone' },
  ], 'a@x.com');
  const results = await dqstore.runRules({
    system: 'lakebase',
    table,
    exec: async (sql) => (await lakebase.query(sql)).rows,
    dialect: 'pg',
    ref: dq.tableRef('pg', [MASTER, 'cust']),
    columns: [{ name: 'id' }, { name: 'email' }, { name: 'region_id' }, { name: 'state' }],
    parentRef: async (name) => dq.tableRef('pg', name.split('.')),
  });
  const by = Object.fromEntries(results.map((r) => [`${r.column_name}:${r.rule_type}`, r]));
  assert.equal(by['id:unique'].last_failed, 2);
  assert.equal(by['email:not_null'].last_failed, 2, "'' and NULL");
  assert.equal(by['email:format'].last_failed, 1, 'only present values are judged');
  assert.equal(by['email:format'].last_samples[0].value, 'b•••l', 'personal data is masked');
  assert.equal(by['region_id:references'].last_failed, 1, 'region 9 is orphaned');
  assert.equal(by['state:allowed_values'].last_failed, 1, "S.A. fails; 'N/A' is left to not_null");
  assert.match(by['nope:not_null'].last_error, /no longer exists/);
  assert.equal(by['id:unique'].last_total, 4);
  const [summary] = await dqstore.summary('lakebase', `${MASTER}.`);
  assert.equal(summary.rules, 6);
  assert.equal(summary.failing, 5);
});

test('write-back: propose from rules, approve with stale check, outbox and acknowledgement', { skip: !enabled }, async () => {
  const writeback = await import('./writeback.js');
  const dqstore = await import('./dqstore.js');
  const dq = await import('./dq.js');
  await lakebase.query(`CREATE TABLE ${MASTER}.billing (cust_no text, state text, bsb text, email text);
    INSERT INTO ${MASTER}.billing VALUES
      ('C1', 'S.A.', '545124', 'a@x.com '), ('C2', 'sa', '545-124', 'b@x.com'),
      ('C3', 'SA', '123456', 'c.x.com'), ('C4', 'NSW', '111-222', 'd@x.com'),
      ('C5', 'SA', '999-888', 'e@x.com'), ('C5', 'SA', '999-888', 'e@x.com');`);
  const name = `${MASTER}.billing`;
  const ctx = {
    system: 'lakebase',
    name,
    dialect: 'pg',
    ref: dq.tableRef('pg', [MASTER, 'billing']),
    columns: ['cust_no', 'state', 'bsb', 'email'].map((n) => ({ name: n })),
    primaryKey: [],
    exec: async (sql) => (await lakebase.query(sql)).rows,
  };
  writeback.configure({ tableContext: async () => ctx });
  await dqstore.addRules('lakebase', name, [
    { column: 'state', rule_type: 'allowed_values', params: { values: ['SA'] }, description: 'state' },
    { column: 'bsb', rule_type: 'format', params: { regex: '^[0-9]{3}[-][0-9]{3}$', pattern: '999-999', piiType: 'financial' }, description: 'bsb' },
    { column: 'email', rule_type: 'format', params: { regex: '^[^@ ]+@[^@ ]+[.][A-Za-z]{2,}$', piiType: 'email' }, description: 'email' },
  ], 'a@x.com');

  const p = await writeback.proposals(ctx, { keyColumns: ['cust_no'] });
  const ids = p.groups.map((g) => g.id).sort();
  assert.ok(ids.includes('state|standardise_code|safe') && ids.includes('bsb|reformat|safe') && ids.includes('email|trim|safe'), ids.join());
  assert.ok(p.groups.find((g) => g.id === 'state|unknown_code|manual'), 'NSW is manual');
  assert.ok(p.groups.find((g) => g.id === 'email|invalid_email|manual'));

  const target = { system: 'lakebase', schema: MASTER, table: 'billing' };
  await assert.rejects(
    refdata.proposeChange({ kind: 'writeback', action: 'create', target, payload: { keyColumns: ['cust_no'], groupIds: ['state|unknown_code|manual'], pathTemplate: '/c/{cust_no}' } }, 'a@x.com'),
    /None of the selected corrections/,
    'manual groups can never be sent',
  );
  const cr = await refdata.proposeChange(
    { kind: 'writeback', action: 'create', target, payload: { keyColumns: ['cust_no'], groupIds: ['state|standardise_code|safe', 'bsb|reformat|safe', 'email|trim|safe'], method: 'PATCH', pathTemplate: '/customers/{cust_no}' } },
    'analyst@x.com',
  );
  assert.equal(cr.payload.changes.length, 5, 'C1 state+bsb+email, C2 state, C3 bsb');
  assert.match(cr.summary, /5 corrections to 3 records/);

  // The source changes C2's state before approval: that change is dropped.
  await lakebase.query(`UPDATE ${MASTER}.billing SET state = 'SA' WHERE cust_no = 'C2'`);
  const done = await refdata.reviewChange(cr.id, { decision: 'approve' }, 'steward@x.com');
  assert.equal(done.status, 'applied');
  const [audit] = (await refdata.auditLog()).filter((a) => a.change_request_id === cr.id);
  assert.deepEqual(audit.after, { outboxEntries: 2, changes: 4, staleChangesDropped: 1 });

  const outbox = await writeback.listOutbox({ table: name });
  assert.deepEqual(outbox.map((e) => e.path), ['/customers/C1', '/customers/C3']);
  assert.deepEqual(outbox[1].body.set, { bsb: '123-456' });
  assert.deepEqual(outbox[0].body.set, { state: 'SA', bsb: '545-124', email: 'a@x.com' });
  assert.deepEqual(outbox[0].body.expect, { state: 'S.A.', bsb: '545124', email: 'a@x.com ' });

  const { rows: source } = await lakebase.query(`SELECT state FROM ${MASTER}.billing WHERE cust_no = 'C1'`);
  assert.equal(source[0].state, 'S.A.', 'the app never edits the source itself');

  await writeback.acknowledge([outbox[0].id], { status: 'failed', response: '409 changed' }, 'integration');
  await writeback.acknowledge([outbox[0].id], { status: 'sent', response: '200' }, 'integration');
  const after = (await writeback.listOutbox({ table: name }))[0];
  assert.equal(after.status, 'sent');
  assert.equal(after.attempts, 2);
  assert.deepEqual(await writeback.acknowledge([outbox[0].id], { status: 'cancelled' }, 'x'), [], 'sent entries stay sent');
});
