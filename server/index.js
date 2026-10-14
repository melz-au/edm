import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as databricks from './databricks.js';
import * as uc from './unityCatalog.js';
import * as lakebase from './lakebase.js';
import { demoModel, inferRelationships } from './model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');
const port = Number(process.env.DATABRICKS_APP_PORT || process.env.PORT || 8000);

const app = express();
app.disable('x-powered-by');

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

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({
    defaultSource: process.env.ERD_DEFAULT_SOURCE || (databricks.isConfigured() ? 'uc' : 'demo'),
    defaultCatalog: process.env.ERD_DEFAULT_CATALOG || null,
    defaultSchema: process.env.ERD_DEFAULT_SCHEMA || null,
    user: req.get('x-forwarded-email') || req.get('x-forwarded-preferred-username') || null,
    sources: {
      uc: { available: databricks.isConfigured() || Boolean(userToken(req) && databricks.getHost()) },
      lakebase: { available: lakebase.isConfigured(), ...lakebase.getConnectionInfo() },
      demo: { available: true },
    },
  });
});

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

// Demo
app.get('/api/demo/erd', (req, res) => res.json(withInference(req, demoModel())));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

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
});

const shutdown = async () => {
  server.close();
  await lakebase.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
