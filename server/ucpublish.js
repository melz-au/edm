// Publishes approved reference data from Lakebase to Unity Catalog as Delta
// tables, so notebooks, jobs and pipelines can join it like any other table:
//
//   <target>.code_set      one row per code set
//   <target>.code_value    codes with labels, order and active flag
//   <target>.code_mapping  raw source values → code (or maps_to_missing)
//
// Each table is rewritten with one CREATE OR REPLACE TABLE ... AS SELECT
// statement, so readers never see a half-written table and Delta keeps every
// published version (DESCRIBE HISTORY / VERSION AS OF). Statements run on the
// app's SQL warehouse (see warehouse.js). The service principal needs USE
// CATALOG, USE SCHEMA, CREATE TABLE and MODIFY on the target schema.
import * as refdata from './refdata.js';
import * as warehouse from './warehouse.js';

export const TABLES = {
  code_set: [
    ['id', 'INT'],
    ['name', 'STRING'],
    ['description', 'STRING'],
    ['source_system', 'STRING'],
    ['source_table', 'STRING'],
    ['source_column', 'STRING'],
    ['updated_at', 'TIMESTAMP'],
    ['updated_by', 'STRING'],
  ],
  code_value: [
    ['id', 'INT'],
    ['code_set_id', 'INT'],
    ['code_set', 'STRING'],
    ['code', 'STRING'],
    ['label', 'STRING'],
    ['description', 'STRING'],
    ['sort_order', 'INT'],
    ['active', 'BOOLEAN'],
    ['updated_at', 'TIMESTAMP'],
    ['updated_by', 'STRING'],
  ],
  code_mapping: [
    ['id', 'INT'],
    ['code_set_id', 'INT'],
    ['code_set', 'STRING'],
    ['source_system', 'STRING'],
    ['source_table', 'STRING'],
    ['source_column', 'STRING'],
    ['source_value', 'STRING'],
    ['code_value_id', 'INT'],
    ['code', 'STRING'],
    ['label', 'STRING'],
    ['maps_to_missing', 'BOOLEAN'],
    ['updated_at', 'TIMESTAMP'],
    ['updated_by', 'STRING'],
  ],
};

const TARGET_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function validTarget(target) {
  return typeof target === 'string' && TARGET_RE.test(target.trim());
}

const q = (name) => `\`${String(name).replace(/`/g, '``')}\``;

/** A Databricks SQL literal. Strings escape backslashes and quotes. */
export function literal(value, type) {
  if (value === null || value === undefined) return 'NULL';
  if (type === 'BOOLEAN') return value ? 'true' : 'false';
  if (type === 'INT') {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new Error(`Not an integer: ${value}`);
    return String(n);
  }
  if (type === 'TIMESTAMP') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? 'NULL' : `'${d.toISOString()}'`;
  }
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** CREATE OR REPLACE TABLE ... AS SELECT typed columns FROM VALUES rows. */
export function replaceTableSql(target, table, rows, publishedAt) {
  const cols = TABLES[table];
  const aliases = cols.map((_, i) => `c${i}`);
  const select = cols.map(([name, type], i) => `CAST(c${i} AS ${type}) AS ${q(name)}`).join(',\n  ');
  const values = rows.length
    ? rows.map((r) => `(${cols.map(([name, type]) => literal(r[name], type)).join(', ')})`).join(',\n  ')
    : `(${cols.map(() => 'NULL').join(', ')})`;
  const [catalog, schema] = target.trim().split('.');
  const comment = `Published from ERD Explorer reference data (Lakebase) at ${publishedAt}. Do not edit here: changes go through the app's approval workflow.`;
  return `CREATE OR REPLACE TABLE ${q(catalog)}.${q(schema)}.${q(table)}
USING DELTA
COMMENT ${literal(comment, 'STRING')}
AS SELECT
  ${select}
FROM VALUES
  ${values}
AS v(${aliases.join(', ')})${rows.length ? '' : '\nWHERE false'}`;
}

export function buildStatements(target, snapshot, publishedAt = new Date().toISOString()) {
  return Object.keys(TABLES).map((table) => ({
    table,
    rows: snapshot[table].length,
    sql: replaceTableSql(target, table, snapshot[table], publishedAt),
  }));
}

// --- running ----------------------------------------------------------------

let running = null;
let rerunRequested = false;

/**
 * Publishes the current snapshot. Runs are serialised: a request that arrives
 * during a run schedules exactly one more run afterwards, so the last approval
 * is always included.
 */
export function publish({ trigger = 'manual', user = 'system', run = warehouse.runSql } = {}) {
  if (running) {
    rerunRequested = true;
    return running;
  }
  running = (async () => {
    try {
      return await publishOnce({ trigger, user, run });
    } finally {
      running = null;
      if (rerunRequested) {
        rerunRequested = false;
        publish({ trigger: 'auto (queued)', user, run }).catch(() => {});
      }
    }
  })();
  return running;
}

async function publishOnce({ trigger, user, run }) {
  const settings = await refdata.getPublishSettings();
  if (!validTarget(settings.target)) {
    throw Object.assign(new Error('Set a Unity Catalog target (catalog.schema) before publishing.'), { status: 400 });
  }
  const log = await refdata.startPublishRun(settings.target, trigger, user);
  try {
    const snapshot = await refdata.exportSnapshot();
    const statements = buildStatements(settings.target, snapshot);
    for (const s of statements) await run(s.sql);
    const counts = Object.fromEntries(statements.map((s) => [s.table, s.rows]));
    return await refdata.finishPublishRun(log.id, { status: 'succeeded', counts });
  } catch (err) {
    await refdata.finishPublishRun(log.id, { status: 'failed', error: err.message });
    throw err;
  }
}

export const isRunning = () => Boolean(running);
