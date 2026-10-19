// Runs SQL on a Databricks SQL warehouse through the Statement Execution API.
// Used to profile Unity Catalog tables. Attach a "SQL warehouse" resource to
// the app (permission: Can use) and expose its id as DATABRICKS_WAREHOUSE_ID
// in app.yaml.
import { apiGet, apiPost } from './databricks.js';

export function isConfigured() {
  return Boolean(process.env.DATABRICKS_WAREHOUSE_ID);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Executes `statement` and returns rows as objects keyed by column name. */
export async function runSql(statement, { userToken = null, timeoutMs = 120_000 } = {}) {
  if (!isConfigured()) {
    throw Object.assign(
      new Error(
        'Profiling Unity Catalog tables needs a SQL warehouse: add a SQL warehouse resource to the app and set DATABRICKS_WAREHOUSE_ID.',
      ),
      { status: 400 },
    );
  }
  let res = await apiPost(
    '/api/2.0/sql/statements',
    {
      statement,
      warehouse_id: process.env.DATABRICKS_WAREHOUSE_ID,
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
