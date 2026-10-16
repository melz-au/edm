import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake Databricks workspace: OAuth token endpoint + paginated UC tables API.
let server;
let tokenRequests = 0;
const seenAuth = [];

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
      return res.end(JSON.stringify({
        tables: [{
          name: 'customers', full_name: 'main.sales.customers', catalog_name: 'main', schema_name: 'sales',
          columns: [{ name: 'customer_id', type_text: 'bigint', position: 0 }],
          table_constraints: [{ primary_key_constraint: { name: 'pk_c', child_columns: ['customer_id'] } }],
        }],
      }));
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
    'main.sales.orders', 'main.sales.customers', 'main.ref.regions',
  ]);
  const orders = model.tables[0];
  assert.deepEqual(orders.columns.map((c) => c.name), ['order_id', 'customer_id', 'region_id']);
  assert.equal(orders.columns[0].pk, true);
  assert.equal(orders.columns[1].fk, true);
  assert.equal(orders.columns[1].nullable, false);
  assert.equal(model.tables[2].external, true);
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
