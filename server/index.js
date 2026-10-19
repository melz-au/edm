import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as databricks from './databricks.js';
import * as uc from './unityCatalog.js';
import * as lakebase from './lakebase.js';
import { demoModel, inferRelationships } from './model.js';
import * as profile from './profile.js';
import * as pii from './pii.js';
import { suggestMappings } from './mapping.js';
import * as refdata from './refdata.js';
import * as warehouse from './warehouse.js';
import * as ingest from './ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');
const port = Number(process.env.DATABRICKS_APP_PORT || process.env.PORT || 8000);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Databricks Apps sets these headers for the signed-in user. Outside Databricks
// (local development) ERD_DEV_USER stands in.
const currentUser = (req) =>
  req.get('x-forwarded-email') || req.get('x-forwarded-preferred-username') || process.env.ERD_DEV_USER || 'local-user';

// By default Unity Catalog is queried as the app's service principal. Set
// ERD_USE_USER_TOKEN=true to query as the signed-in user instead; this needs
// user authorization on the app with the catalog.*:read scopes; otherwise the
// forwarded token only carries identity scopes and UC calls fail with
// "invalid scope".
const userToken = (req) =>
  process.env.ERD_USE_USER_TOKEN === 'true' ? req.get('x-forwarded-access-token') || null : null;

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[${req.method} ${req.originalUrl}]`, err);
    res.status(err.status && err.status >= 400 ? err.status : 500).json({ error: err.message });
  });

const required = (req, ...names) => {
  for (const n of names) {
    if (!req.query[n]) throw Object.assign(new Error(`Missing query parameter "${n}"`), { status: 400 });
  }
};

const withInference = (req, model) => (req.query.infer === 'true' ? inferRelationships(model) : model);

// Which identity Unity Catalog calls run as, shown in the UI and /api/health
// so a deployment can be checked without reading logs.
const ucIdentity = (req) => {
  if (userToken(req)) return 'signed-in user';
  if (process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET) return 'app service principal';
  if (process.env.DATABRICKS_TOKEN) return 'personal access token';
  return 'none';
};

app.get('/api/health', (req, res) =>
  res.json({ ok: true, ucIdentity: ucIdentity(req), useUserToken: process.env.ERD_USE_USER_TOKEN === 'true' }),
);

app.get('/api/config', wrap(async (req, res) => {
  const wh = await warehouse.resolveWarehouse();
  res.json({
    defaultSource: process.env.ERD_DEFAULT_SOURCE || (databricks.isConfigured() ? 'uc' : 'demo'),
    defaultCatalog: process.env.ERD_DEFAULT_CATALOG || null,
    defaultSchema: process.env.ERD_DEFAULT_SCHEMA || null,
    user: req.get('x-forwarded-email') || req.get('x-forwarded-preferred-username') || null,
    sources: {
      uc: {
        available: databricks.isConfigured() || Boolean(userToken(req) && databricks.getHost()),
        identity: ucIdentity(req),
      },
      lakebase: { available: lakebase.isConfigured(), ...lakebase.getConnectionInfo() },
      warehouse: { available: Boolean(wh), name: wh?.name ?? null, source: wh?.source ?? null },
      refdata: { available: lakebase.isConfigured(), schema: refdata.SCHEMA },
      ingest: {
        available: Boolean(wh) && (databricks.isConfigured() || Boolean(userToken(req) && databricks.getHost())),
        defaultCatalog: process.env.ERD_BRONZE_CATALOG || process.env.ERD_DEFAULT_CATALOG || null,
        defaultSchema: process.env.ERD_BRONZE_SCHEMA || 'bronze',
        volume: process.env.ERD_UPLOAD_VOLUME || null,
        maxMb: ingest.MAX_UPLOAD_MB,
      },
      demo: { available: true },
    },
  });
}));

// Unity Catalog
app.get('/api/uc/catalogs', wrap(async (req, res) => {
  res.json(await uc.listCatalogs(userToken(req)));
}));

app.get('/api/uc/schemas', wrap(async (req, res) => {
  required(req, 'catalog');
  res.json(await uc.listSchemas(req.query.catalog, userToken(req)));
}));

app.get('/api/uc/erd', wrap(async (req, res) => {
  required(req, 'catalog', 'schema');
  const model = await uc.getErd(req.query.catalog, req.query.schema, userToken(req));
  res.json(withInference(req, model));
}));

// Lakebase (Postgres)
app.get('/api/lakebase/schemas', wrap(async (_req, res) => {
  res.json(await lakebase.listSchemas());
}));

app.get('/api/lakebase/erd', wrap(async (req, res) => {
  required(req, 'schema');
  res.json(withInference(req, await lakebase.getErd(req.query.schema)));
}));

// Profiling: categorical column detection
const pgRun = async (sql) => (await lakebase.query(sql)).rows;

app.get('/api/lakebase/profile', wrap(async (req, res) => {
  required(req, 'schema', 'table');
  const meta = await lakebase.tableMeta(req.query.schema, req.query.table);
  res.json(await profile.profileTable({
    dialect: 'pg',
    ref: profile.tableRef('pg', [meta.schema, meta.table]),
    columns: meta.columns,
    primaryKey: meta.primaryKey,
    run: pgRun,
  }));
}));

app.get('/api/uc/profile', wrap(async (req, res) => {
  required(req, 'catalog', 'schema', 'table');
  const { catalog, schema, table } = req.query;
  const meta = await uc.getTable(catalog, schema, table, userToken(req));
  res.json(await profile.profileTable({
    dialect: 'spark',
    ref: profile.tableRef('spark', [catalog, schema, table]),
    columns: meta.columns,
    primaryKey: meta.primaryKey,
    run: (sql) => warehouse.runSql(sql, { userToken: userToken(req) }),
  }));
}));

// Distinct values of a column, masked if the column holds personal data.
const maskedValues = (column, rows) => {
  const found = pii.assess(column, rows.slice(0, pii.VALUE_SAMPLE_PER_COLUMN).map((r) => r.v));
  return rows.map((r) => ({ value: found ? pii.mask(r.v, found.type) : r.v, count: Number(r.n), masked: Boolean(found) }));
};

const assertColumn = (meta, column) => {
  if (!meta.columns.some((c) => c.name === column)) {
    throw Object.assign(new Error(`Column ${column} not found`), { status: 404 });
  }
};

app.get('/api/lakebase/values', wrap(async (req, res) => {
  required(req, 'schema', 'table', 'column');
  const meta = await lakebase.tableMeta(req.query.schema, req.query.table);
  assertColumn(meta, req.query.column);
  const rows = await pgRun(
    profile.distinctValuesSql('pg', profile.tableRef('pg', [meta.schema, meta.table]), req.query.column),
  );
  res.json(maskedValues(req.query.column, rows));
}));

app.get('/api/uc/values', wrap(async (req, res) => {
  required(req, 'catalog', 'schema', 'table', 'column');
  const { catalog, schema, table, column } = req.query;
  const meta = await uc.getTable(catalog, schema, table, userToken(req));
  assertColumn(meta, column);
  const rows = await warehouse.runSql(
    profile.distinctValuesSql('spark', profile.tableRef('spark', [catalog, schema, table]), column),
    { userToken: userToken(req) },
  );
  res.json(maskedValues(column, rows));
}));

// Master data rows (Lakebase only)
app.get('/api/lakebase/rows', wrap(async (req, res) => {
  required(req, 'schema', 'table');
  const { schema, table, limit, offset, search } = req.query;
  res.json(await lakebase.listRows(schema, table, { limit, offset, search }));
}));

// Reference data and change requests
app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  res.json({
    user,
    isSteward: refdata.isSteward(user),
    stewardsConfigured: refdata.stewards().length > 0,
    selfApproval: process.env.ERD_ALLOW_SELF_APPROVAL === 'true',
  });
});

app.get('/api/refdata/code-sets', wrap(async (_req, res) => res.json(await refdata.listCodeSets())));

app.get('/api/refdata/code-sets/:id', wrap(async (req, res) => {
  res.json(await refdata.getCodeSet(Number(req.params.id)));
}));

app.get('/api/refdata/code-sets/:id/mappings', wrap(async (req, res) => {
  res.json(await refdata.listMappings(Number(req.params.id)));
}));

// Suggested target codes for raw source values: body { values: [string] }.
app.post('/api/refdata/code-sets/:id/suggest', wrap(async (req, res) => {
  const set = await refdata.getCodeSet(Number(req.params.id));
  const values = (req.body?.values ?? []).map(String).slice(0, 5000);
  const known = await refdata.listMappings(set.id);
  res.json(suggestMappings(values, set.values, known));
}));

app.get('/api/refdata/mappings', wrap(async (req, res) => {
  required(req, 'system', 'table');
  res.json(await refdata.mappingsForSource(req.query.system, req.query.table, req.query.column));
}));

app.get('/api/refdata/linked', wrap(async (req, res) => {
  required(req, 'system', 'table');
  res.json(await refdata.codeSetsForSource(req.query.system, req.query.table));
}));

app.get('/api/refdata/changes', wrap(async (req, res) => {
  res.json(await refdata.listChanges({ status: req.query.status, kind: req.query.kind, limit: req.query.limit }));
}));

app.get('/api/refdata/pending-count', wrap(async (_req, res) => res.json({ pending: await refdata.pendingCount() })));

app.post('/api/refdata/changes', wrap(async (req, res) => {
  res.status(201).json(await refdata.proposeChange(req.body ?? {}, currentUser(req)));
}));

app.post('/api/refdata/changes/:id/review', wrap(async (req, res) => {
  res.json(await refdata.reviewChange(Number(req.params.id), req.body ?? {}, currentUser(req)));
}));

app.post('/api/refdata/changes/:id/cancel', wrap(async (req, res) => {
  res.json(await refdata.cancelChange(Number(req.params.id), currentUser(req)));
}));

app.get('/api/refdata/audit', wrap(async (req, res) => res.json(await refdata.auditLog({ limit: req.query.limit }))));

// CSV upload into bronze Unity Catalog tables
const ucSql = (req) => (sql) => warehouse.runSql(sql, { userToken: userToken(req) });

const existingTable = async (req, catalog, schema, table) => {
  try {
    return await uc.getTable(catalog, schema, table, userToken(req));
  } catch (err) {
    if (ingest.isNotFound(err)) return null;
    throw err;
  }
};

app.get('/api/ingest/table', wrap(async (req, res) => {
  required(req, 'catalog', 'schema', 'table');
  const t = await existingTable(req, req.query.catalog, req.query.schema, req.query.table);
  res.json(t ? { exists: true, columns: t.columns.map((c) => c.name) } : { exists: false });
}));

app.put(
  '/api/ingest/upload',
  express.raw({ type: () => true, limit: `${ingest.MAX_UPLOAD_MB}mb` }),
  wrap(async (req, res) => {
    required(req, 'catalog', 'schema', 'fileName');
    res.status(201).json(await ingest.storeUpload({
      catalog: req.query.catalog,
      schema: req.query.schema,
      fileName: req.query.fileName,
      body: Buffer.isBuffer(req.body) ? req.body : null,
      runSql: ucSql(req),
      userToken: userToken(req),
    }));
  }),
);

app.post('/api/ingest/load', wrap(async (req, res) => {
  const { catalog, schema, table } = req.body ?? {};
  ingest.validateLoad(req.body);
  const existing = await existingTable(req, catalog, schema, table);
  res.json(await ingest.loadUpload(req.body, { user: currentUser(req), existing, runSql: ucSql(req) }));
}));

// Demo
app.get('/api/demo/erd', (req, res) => res.json(withInference(req, demoModel())));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Body parser failures (e.g. an upload over the size limit) as JSON.
app.use('/api', (err, _req, res, _next) => {
  const tooLarge = err.type === 'entity.too.large';
  res.status(err.status || 500).json({
    error: tooLarge ? `The file is larger than the ${ingest.MAX_UPLOAD_MB} MB upload limit.` : err.message,
  });
});

// Frontend
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res.type('text').send('Frontend not built. Run `npm run build`, or `npm run dev` for development.'),
  );
}

const server = app.listen(port, () => {
  console.log(`ERD app listening on http://localhost:${port}`);
  console.log(
    `Unity Catalog auth: ${process.env.ERD_USE_USER_TOKEN === 'true' ? 'signed-in user token (ERD_USE_USER_TOKEN=true)' : 'app service principal'}`,
  );
});

const shutdown = async () => {
  server.close();
  await lakebase.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
