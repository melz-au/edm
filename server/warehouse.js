// Runs SQL on a Databricks SQL warehouse through the Statement Execution API.
// Used to profile Unity Catalog tables.
//
// Which warehouse:
//   1. DATABRICKS_WAREHOUSE_ID, if set (e.g. valueFrom a "sql-warehouse" app resource).
//   2. Otherwise the app finds one its service principal can use. Attaching a
//      SQL warehouse resource to the app (permission: Can use) is enough. Set
//      ERD_WAREHOUSE_NAME to pick one by name when several are available.
import { apiGet, apiPost, isConfigured as databricksConfigured } from './databricks.js';

const DISCOVERY_TTL_MS = 10 * 60_000;
let discovered = null; // { warehouse, at }

/** Prefers the named warehouse, then running, then serverless, then "Starter". */
export function pickWarehouse(warehouses, preferredName) {
  const usable = warehouses.filter((w) => w.id && w.state !== 'DELETED' && w.state !== 'DELETING');
  if (preferredName) {
    const named = usable.find((w) => w.name?.toLowerCase() === preferredName.toLowerCase());
    if (named) return named;
  }
  const score = (w) =>
    (w.state === 'RUNNING' ? 4 : 0) + (w.enable_serverless_compute ? 2 : 0) + (/starter/i.test(w.name ?? '') ? 1 : 0);
  return [...usable].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The warehouse to use, or null. Never throws; discovery failures mean "none". */
export async function resolveWarehouse() {
  if (process.env.DATABRICKS_WAREHOUSE_ID) {
    return { id: process.env.DATABRICKS_WAREHOUSE_ID, name: null, source: 'env' };
  }
  if (!databricksConfigured()) return null;
  if (discovered && Date.now() - discovered.at < DISCOVERY_TTL_MS) return discovered.warehouse;
  try {
    const { warehouses = [] } = await apiGet('/api/2.0/sql/warehouses');
    const w = pickWarehouse(warehouses, process.env.ERD_WAREHOUSE_NAME);
    discovered = { warehouse: w && { id: w.id, name: w.name, source: 'discovered' }, at: Date.now() };
  } catch (err) {
    console.warn(`SQL warehouse discovery failed: ${err.message}`);
    discovered = { warehouse: null, at: Date.now() - DISCOVERY_TTL_MS + 30_000 }; // retry in 30s
  }
  return discovered.warehouse;
}

export function resetDiscovery() {
  discovered = null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Executes `statement` and returns rows as objects keyed by column name. */
export async function runSql(statement, { userToken = null, timeoutMs = 120_000 } = {}) {
  const wh = await resolveWarehouse();
  if (!wh) {
    throw Object.assign(
      new Error(
        "Profiling Unity Catalog tables needs a SQL warehouse: add one to the app's resources (Edit → App resources → SQL warehouse, permission Can use).",
      ),
      { status: 400 },
    );
  }
  let res = await apiPost(
    '/api/2.0/sql/statements',
    {
      statement,
      warehouse_id: wh.id,
      wait_timeout: '30s',
      on_wait_timeout: 'CONTINUE',
      format: 'JSON_ARRAY',
      disposition: 'INLINE',
    },
    userToken,
  );
  const deadline = Date.now() + timeoutMs;
  while (['PENDING', 'RUNNING'].includes(res.status?.state)) {
    if (Date.now() > deadline) throw Object.assign(new Error('SQL warehouse query timed out'), { status: 504 });
    await sleep(1000);
    res = await apiGet(`/api/2.0/sql/statements/${res.statement_id}`, {}, userToken);
  }
  if (res.status?.state !== 'SUCCEEDED') {
    const msg = res.status?.error?.message ?? res.status?.state ?? 'unknown error';
    throw Object.assign(new Error(`SQL warehouse query failed: ${msg}`), { status: 502 });
  }
  const names = (res.manifest?.schema?.columns ?? []).map((c) => c.name);
  return (res.result?.data_array ?? []).map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
}
