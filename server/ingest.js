// Loads an uploaded CSV file into a bronze Unity Catalog table.
//
// 1. The browser sends the raw file; it is stored unchanged in a landing UC
//    volume (ERD_UPLOAD_VOLUME, or <catalog>.<schema>.landing, created on first
//    use) under uploads/<date>/<load id>_<file name>.
// 2. A SQL warehouse reads it with read_files() and writes a Delta table. Every
//    column is kept as STRING, as in the file: bronze is the raw copy, and typing
//    and cleaning belong in silver. Columns are read by position (the header
//    row is skipped, not matched), so the names the user chose replace the
//    file's header. Lineage columns record where each row came from.
import crypto from 'node:crypto';
import { DatabricksError, apiPutFile } from './databricks.js';
import { quoteIdent, tableRef } from './profile.js';

export const MAX_UPLOAD_MB = Number(process.env.ERD_UPLOAD_MAX_MB || 100);
export const DELIMITERS = [',', ';', '\t', '|'];
export const LINEAGE_COLUMNS = ['_source_file', '_ingested_at', '_ingested_by', '_load_id'];
export const MODES = ['create', 'replace', 'append'];

const NAME_RE = /^[a-z_][a-z0-9_]{0,254}$/;
const LOAD_ID_RE = /^[0-9a-f-]{36}$/;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** Spark SQL string literal. */
export const sqlString = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The landing volume as [catalog, schema, volume], and whether the app may create it. */
export function landingVolume(catalog, schema) {
  const configured = process.env.ERD_UPLOAD_VOLUME;
  if (configured) {
    const parts = configured.replace(/^\/Volumes\//, '').split(/[./]/).filter(Boolean);
    if (parts.length !== 3) throw new Error('ERD_UPLOAD_VOLUME must be catalog.schema.volume');
    return { parts, managed: false };
  }
  return { parts: [catalog, schema, 'landing'], managed: true };
}

const volumePath = (parts) => `/Volumes/${parts.join('/')}`;

/** A file name safe to use in a volume path. */
export const safeFileName = (name) =>
  String(name || 'upload.csv')
    .split(/[\\/]/)
    .pop()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-120) || 'upload.csv';

/** Whether people may create new schemas from the upload page (ERD_UPLOAD_CREATE_SCHEMA, default true). */
export const canCreateSchema = () => process.env.ERD_UPLOAD_CREATE_SCHEMA !== 'false';

/** Creates catalog.schema for uploads if it doesn't exist yet. */
export async function createSchema({ catalog, schema, user, runSql }) {
  if (!canCreateSchema()) throw Object.assign(new Error('Creating schemas from the upload page is turned off.'), { status: 403 });
  if (!catalog) throw badRequest('Choose a catalog.');
  if (!NAME_RE.test(schema ?? '')) {
    throw badRequest('Schema names may only use lower-case letters, numbers and underscores, and must not start with a number.');
  }
  try {
    await runSql(
      `CREATE SCHEMA IF NOT EXISTS ${tableRef('spark', [catalog, schema])} COMMENT ${sqlString(`Created by ${user} from the EDM app upload page`)}`,
    );
  } catch (err) {
    if (/PERMISSION_DENIED|privilege|not authorized/i.test(err.message)) {
      throw Object.assign(
        new Error(`The app isn't allowed to create schemas in ${catalog}. Choose an existing schema, or ask an admin to grant the app CREATE SCHEMA on this catalog.`),
        { status: 403 },
      );
    }
    throw err;
  }
  return { catalog, schema };
}

/** Stores the raw file in the landing volume and returns where it went. */
export async function storeUpload({ catalog, schema, fileName, body, runSql, userToken }) {
  if (!catalog || !schema) throw badRequest('Choose a catalog and schema first.');
  if (!body?.length) throw badRequest('The file is empty.');
  const { parts, managed } = landingVolume(catalog, schema);
  if (managed) {
    await runSql(`CREATE VOLUME IF NOT EXISTS ${tableRef('spark', parts)} COMMENT 'Raw files uploaded through the EDM app'`);
  }
  const loadId = crypto.randomUUID();
  const date = new Date().toISOString().slice(0, 10);
  const path = `${volumePath(parts)}/uploads/${date}/${loadId}_${safeFileName(fileName)}`;
  await apiPutFile(path, body, userToken);
  return { loadId, path, bytes: body.length };
}

/** Checks a load request and returns it normalised; throws a 400 explaining the first problem. */
export function validateLoad(req) {
  const { catalog, schema, table, path, loadId, columns, delimiter = ',', header = true, mode = 'create' } = req ?? {};
  if (!catalog || !schema) throw badRequest('Choose a catalog and schema.');
  if (!NAME_RE.test(table ?? '')) {
    throw badRequest('Table names may only use lower-case letters, numbers and underscores, and must not start with a number.');
  }
  if (!MODES.includes(mode)) throw badRequest(`Unknown mode "${mode}".`);
  if (!DELIMITERS.includes(delimiter)) throw badRequest('Unsupported separator.');
  if (!LOAD_ID_RE.test(loadId ?? '')) throw badRequest('Missing upload id.');
  // Only files this app uploaded into the landing volume may be loaded.
  const prefix = `${volumePath(landingVolume(catalog, schema).parts)}/uploads/`;
  if (typeof path !== 'string' || !path.startsWith(prefix) || path.includes('..') || !path.includes(`/${loadId}_`)) {
    throw badRequest('That file is not in the upload area.');
  }
  if (!Array.isArray(columns) || !columns.length) throw badRequest('The file has no columns.');
  const seen = new Set();
  for (const c of columns) {
    if (!NAME_RE.test(c ?? '')) {
      throw badRequest(`Column name "${c}" is not allowed: use lower-case letters, numbers and underscores.`);
    }
    if (LINEAGE_COLUMNS.includes(c)) throw badRequest(`Column name "${c}" is reserved for load tracking.`);
    if (seen.has(c)) throw badRequest(`Column name "${c}" is used twice.`);
    seen.add(c);
  }
  return { catalog, schema, table, path, loadId, columns, delimiter, header: header !== false, mode };
}

/** The SQL that writes the file into the bronze table. */
export function loadSql({ catalog, schema, table, path, loadId, columns, delimiter, header, mode, user, fileName }) {
  const target = tableRef('spark', [catalog, schema, table]);
  const q = (n) => quoteIdent('spark', n);
  const source = `read_files(
  ${sqlString(path)},
  format => 'csv',
  header => false,
  skipRows => ${header ? 1 : 0},
  sep => ${sqlString(delimiter)},
  schema => ${sqlString(columns.map((c) => `${q(c)} STRING`).join(', '))},
  multiLine => true,
  mode => 'PERMISSIVE',
  encoding => 'UTF-8'
)`;
  const select = `SELECT
  ${[
    ...columns.map(q),
    '_metadata.file_name AS _source_file',
    'current_timestamp() AS _ingested_at',
    `${sqlString(user)} AS _ingested_by`,
    `${sqlString(loadId)} AS _load_id`,
  ].join(',\n  ')}
FROM ${source}`;
  if (mode === 'append') return `INSERT INTO ${target} BY NAME\n${select}`;
  const comment = `Bronze: raw copy of ${fileName || path.split('/').pop()}, uploaded by ${user}`;
  return `${mode === 'replace' ? 'CREATE OR REPLACE TABLE' : 'CREATE TABLE'} ${target}
COMMENT ${sqlString(comment)}
TBLPROPERTIES ('quality' = 'bronze', 'edm.loaded_by' = 'erd-app-upload')
AS ${select}`;
}

/** How many rows one load wrote. */
export const loadStatsSql = ({ catalog, schema, table, loadId }) =>
  `SELECT count(*) AS row_count
FROM ${tableRef('spark', [catalog, schema, table])}
WHERE _load_id = ${sqlString(loadId)}`;

/** Loads a stored upload into the target table. `existing` is the table's metadata, or null. */
export async function loadUpload(request, { user, existing, runSql }) {
  const load = validateLoad(request);
  if (existing && load.mode === 'create') {
    throw Object.assign(new Error(`${load.catalog}.${load.schema}.${load.table} already exists. Choose to replace it or add rows to it.`), { status: 409 });
  }
  if (!existing && load.mode === 'append') {
    throw Object.assign(new Error(`${load.catalog}.${load.schema}.${load.table} does not exist yet.`), { status: 404 });
  }
  if (existing && load.mode === 'append') {
    const have = new Set(existing.columns.map((c) => c.name.toLowerCase()));
    const missing = [...load.columns, ...LINEAGE_COLUMNS].filter((c) => !have.has(c));
    if (missing.length) {
      throw badRequest(`The existing table has no column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}. Rename the columns to match it, or replace the table.`);
    }
  }
  await runSql(loadSql({ ...load, user, fileName: request.fileName }));
  const [stats] = await runSql(loadStatsSql(load));
  return {
    table: `${load.catalog}.${load.schema}.${load.table}`,
    mode: load.mode,
    rows: Number(stats?.row_count ?? 0),
    path: load.path,
    loadId: load.loadId,
  };
}

/** True when a Databricks error means "no such table". */
export const isNotFound = (err) =>
  err instanceof DatabricksError && (err.status === 404 || /TABLE_DOES_NOT_EXIST|does not exist/i.test(err.message));
