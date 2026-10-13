import pg from 'pg';
import { getServicePrincipalToken } from './databricks.js';

// Lakebase is Postgres. When a Database resource is attached to the app,
// Databricks injects PGHOST, PGPORT, PGDATABASE, PGUSER and PGSSLMODE.
// The service principal's OAuth token is used as the password unless an
// explicit PGPASSWORD is provided (e.g. for local development).

let pool = null;

export function isConfigured() {
  return Boolean(process.env.PGHOST && process.env.PGUSER);
}

function getPool() {
  if (!isConfigured()) {
    throw Object.assign(
      new Error('Lakebase is not configured. Attach a Database resource to the app or set PGHOST/PGUSER.'),
      { status: 400 },
    );
  }
  if (!pool) {
    const sslmode = process.env.PGSSLMODE ?? 'require';
    pool = new pg.Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? 5432),
      database: process.env.PGDATABASE ?? 'databricks_postgres',
      user: process.env.PGUSER,
      // Evaluated per new connection, so refreshed OAuth tokens are picked up.
      password: async () => process.env.PGPASSWORD || (await getServicePrincipalToken()) || '',
      ssl: sslmode === 'disable' ? false : { rejectUnauthorized: sslmode === 'verify-full' },
      application_name: process.env.PGAPPNAME ?? 'edm-erd',
      max: 4,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export function getConnectionInfo() {
  return {
    host: process.env.PGHOST ?? null,
    database: process.env.PGDATABASE ?? 'databricks_postgres',
    user: process.env.PGUSER ?? null,
  };
}

export async function listSchemas() {
  const { rows } = await getPool().query(`
    SELECT n.nspname AS name, obj_description(n.oid, 'pg_namespace') AS comment
    FROM pg_namespace n
    WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp_%'
      AND n.nspname NOT LIKE 'pg_toast_temp_%'
    ORDER BY n.nspname`);
  return rows;
}

const COLUMNS_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         c.relkind,
         obj_description(c.oid, 'pg_class') AS table_comment,
         a.attname::text AS column_name,
         format_type(a.atttypid, a.atttypmod) AS data_type,
         NOT a.attnotnull AS nullable,
         col_description(c.oid, a.attnum) AS column_comment
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  ORDER BY c.relname, a.attnum`;

const CONSTRAINTS_SQL = `
  SELECT con.conname AS name,
         con.contype AS type,
         c.relname AS table_name,
         ARRAY(SELECT a.attname::text
               FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
               ORDER BY k.ord) AS columns,
         fn.nspname AS ref_schema,
         fc.relname AS ref_table,
         ARRAY(SELECT a.attname::text
               FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
               ORDER BY k.ord) AS ref_columns
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_class fc ON fc.oid = con.confrelid
  LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
  WHERE n.nspname = $1 AND con.contype IN ('p', 'f')`;

const RELKIND = { r: 'TABLE', p: 'TABLE', v: 'VIEW', m: 'MATERIALIZED_VIEW', f: 'FOREIGN' };

export async function getErd(schema) {
  const db = getPool();
  const [{ rows: columns }, { rows: constraints }] = await Promise.all([
    db.query(COLUMNS_SQL, [schema]),
    db.query(CONSTRAINTS_SQL, [schema]),
  ]);
  return buildModelFromPgRows(schema, columns, constraints);
}

export function buildModelFromPgRows(schema, columns, constraints) {
  const tables = new Map();
  for (const r of columns) {
    const id = `${r.schema_name}.${r.table_name}`;
    if (!tables.has(id)) {
      tables.set(id, {
        id,
        name: r.table_name,
        schema: r.schema_name,
        type: RELKIND[r.relkind] ?? 'TABLE',
        comment: r.table_comment,
        columns: [],
      });
    }
    tables.get(id).columns.push({
      name: r.column_name,
      type: r.data_type,
      nullable: r.nullable,
      comment: r.column_comment,
      pk: false,
      fk: false,
    });
  }

  const relationships = [];
  for (const con of constraints) {
    const id = `${schema}.${con.table_name}`;
    const table = tables.get(id);
    if (!table) continue;
    if (con.type === 'p') {
      for (const col of table.columns) if (con.columns.includes(col.name)) col.pk = true;
      continue;
    }
    for (const col of table.columns) if (con.columns.includes(col.name)) col.fk = true;
    const refId = `${con.ref_schema}.${con.ref_table}`;
    relationships.push({
      id: `${id}:${con.name}`,
      name: con.name,
      from: { table: id, columns: con.columns },
      to: { table: refId, columns: con.ref_columns },
      inferred: false,
    });
    if (!tables.has(refId)) {
      tables.set(refId, {
        id: refId,
        name: con.ref_table,
        schema: con.ref_schema,
        type: 'EXTERNAL_REFERENCE',
        comment: 'Referenced table outside the selected schema',
        external: true,
        columns: con.ref_columns.map((n) => ({
          name: n,
          type: '',
          nullable: false,
          comment: null,
          pk: true,
          fk: false,
        })),
      });
    }
  }

  return { tables: [...tables.values()], relationships };
}

export async function close() {
  if (pool) await pool.end();
  pool = null;
}
