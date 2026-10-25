import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake Databricks workspace: OAuth token endpoint + paginated UC tables API.
let server;
let tokenRequests = 0;
const seenAuth = [];
const statements = [];
const tableGets = [];

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/oidc/v1/token') {
      tokenRequests++;
      return res.end(JSON.stringify({ access_token: 'sp-token', expires_in: 3600 }));
    }
    seenAuth.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer unscoped-token') {
      res.statusCode = 403;
      return res.end(JSON.stringify({ message: 'Invalid scope' }));
    }
    if (url.pathname === '/api/2.0/sql/warehouses') {
      return res.end(JSON.stringify({ warehouses: [
        { id: 'w-classic', name: 'Shared Classic', state: 'STOPPED', enable_serverless_compute: false },
        { id: 'w-starter', name: 'Serverless Starter Warehouse', state: 'STOPPED', enable_serverless_compute: true },
      ] }));
    }
    if (url.pathname === '/api/2.0/sql/statements' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        statements.push(JSON.parse(body));
        res.end(JSON.stringify({ statement_id: 'st1', status: { state: 'RUNNING' } }));
      });
      return;
    }
    if (url.pathname === '/api/2.0/sql/statements/st1') {
      return res.end(JSON.stringify({
        statement_id: 'st1',
        status: { state: 'SUCCEEDED' },
        manifest: { schema: { columns: [{ name: 'v' }, { name: 'n' }] } },
        result: { data_array: [['OPEN', '3'], ['CLOSED', '1']] },
      }));
    }
    if (url.pathname === '/api/2.1/unity-catalog/tables') {
      const page = url.searchParams.get('page_token');
      if (!page) {
        return res.end(JSON.stringify({
          next_page_token: 'p2',
          tables: [{
            name: 'orders', full_name: 'main.sales.orders', catalog_name: 'main', schema_name: 'sales',
            table_type: 'MANAGED',
            columns: [
              { name: 'customer_id', type_text: 'bigint', position: 1, nullable: false },
              { name: 'order_id', type_text: 'bigint', position: 0, nullable: false },
              { name: 'region_id', type_text: 'int', position: 2 },
            ],
            table_constraints: [
              { primary_key_constraint: { name: 'pk_orders', child_columns: ['order_id'] } },
              { foreign_key_constraint: { name: 'fk_cust', child_columns: ['customer_id'], parent_table: 'main.sales.customers', parent_columns: ['customer_id'] } },
              { foreign_key_constraint: { name: 'fk_region', child_columns: ['region_id'], parent_table: 'main.ref.regions', parent_columns: ['id'] } },
            ],
          }],
        }));
      }
      // Like the real List Tables API, the second page has no table_constraints.
      return res.end(JSON.stringify({
        tables: [{
          name: 'customers', full_name: 'main.sales.customers', catalog_name: 'main', schema_name: 'sales',
          columns: [{ name: 'customer_id', type_text: 'bigint', position: 0 }],
        }, {
          name: 'v_orders', full_name: 'main.sales.v_orders', catalog_name: 'main', schema_name: 'sales', table_type: 'VIEW',
          columns: [{ name: 'order_id', type_text: 'bigint', position: 0 }],
        }],
      }));
    }
    if (url.pathname.startsWith('/api/2.1/unity-catalog/tables/')) {
      tableGets.push(decodeURIComponent(url.pathname.split('/').pop()));
      if (url.pathname.endsWith('main.sales.customers')) {
        return res.end(JSON.stringify({
          name: 'customers', full_name: 'main.sales.customers', catalog_name: 'main', schema_name: 'sales',
          columns: [{ name: 'customer_id', type_text: 'bigint', position: 0 }],
          table_constraints: [{ primary_key_constraint: { name: 'pk_c', child_columns: ['customer_id'] } }],
        }));
      }
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'nope' }));
  });
  await new Promise((r) => server.listen(0, r));
  process.env.DATABRICKS_HOST = `http://localhost:${server.address().port}`;
  process.env.DATABRICKS_CLIENT_ID = 'id';
  process.env.DATABRICKS_CLIENT_SECRET = 'secret';
});

after(() => server.close());

test('getErd paginates, maps keys and adds external parents', async () => {
  const { getErd } = await import('./unityCatalog.js');
  const model = await getErd('main', 'sales');

  assert.deepEqual(model.tables.map((t) => t.id), [
    'main.sales.orders', 'main.sales.customers', 'main.sales.v_orders', 'main.ref.regions',
  ]);
  assert.deepEqual(tableGets, ['main.sales.customers'], 'only tables listed without constraints are fetched, never views');
  assert.equal(model.tables[1].columns[0].pk, true, 'primary key from the table fetch');
  const orders = model.tables[0];
  assert.deepEqual(orders.columns.map((c) => c.name), ['order_id', 'customer_id', 'region_id']);
  assert.equal(orders.columns[0].pk, true);
  assert.equal(orders.columns[1].fk, true);
  assert.equal(orders.columns[1].nullable, false);
  assert.equal(model.tables[3].external, true);
  assert.equal(model.relationships.length, 2);
  assert.equal(tokenRequests, 1, 'service principal token is cached');
  assert.ok(seenAuth.every((h) => h === 'Bearer sp-token'));
});

test('forwarded user token takes precedence', async () => {
  const { getErd } = await import('./unityCatalog.js');
  seenAuth.length = 0;
  await getErd('main', 'sales', 'user-token');
  assert.ok(seenAuth.every((h) => h === 'Bearer user-token'));
});

test('API errors surface the Databricks message and status', async () => {
  const { apiGet } = await import('./databricks.js');
  await assert.rejects(apiGet('/api/2.1/unknown'), (err) => err.status === 404 && /nope/.test(err.message));
});

test('invalid scope on a user token explains how to fix it', async () => {
  const { listCatalogs } = await import('./unityCatalog.js');
  await assert.rejects(listCatalogs('unscoped-token'), (err) =>
    err.status === 403 && /catalog\.catalogs:read/.test(err.message) && /ERD_USE_USER_TOKEN/.test(err.message));
});

test('warehouse is discovered when DATABRICKS_WAREHOUSE_ID is not set', async () => {
  delete process.env.DATABRICKS_WAREHOUSE_ID;
  const { resolveWarehouse, runSql, resetDiscovery } = await import('./warehouse.js');
  resetDiscovery();
  assert.deepEqual(await resolveWarehouse(), { id: 'w-starter', name: 'Serverless Starter Warehouse', source: 'discovered' });
  await runSql('SELECT 2');
  assert.equal(statements.at(-1).warehouse_id, 'w-starter');
});

test('pickWarehouse honours a preferred name, then running, serverless and starter', async () => {
  const { pickWarehouse } = await import('./warehouse.js');
  const list = [
    { id: 'a', name: 'BI', state: 'RUNNING' },
    { id: 'b', name: 'Serverless Starter Warehouse', state: 'STOPPED', enable_serverless_compute: true },
    { id: 'c', name: 'Old', state: 'DELETED' },
  ];
  assert.equal(pickWarehouse(list).id, 'a');
  assert.equal(pickWarehouse(list, 'serverless starter warehouse').id, 'b');
  assert.equal(pickWarehouse([list[2]]), null);
});

test('warehouse.runSql polls a running statement and maps rows', async () => {
  process.env.DATABRICKS_WAREHOUSE_ID = 'wh1';
  const { runSql } = await import('./warehouse.js');
  const rows = await runSql('SELECT 1');
  assert.deepEqual(rows, [{ v: 'OPEN', n: '3' }, { v: 'CLOSED', n: '1' }]);
  assert.equal(statements.at(-1).warehouse_id, 'wh1');
  assert.equal(statements.at(-1).statement, 'SELECT 1');
});
