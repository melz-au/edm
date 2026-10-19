// Reference and master data management, stored in Lakebase.
//
// Everything lives in one schema (ERD_REFDATA_SCHEMA, default "refdata"),
// created on first use:
//   code_set        named lists of codes, optionally linked to a source column
//   code_value      the codes in each set (code, label, description, order, active)
//   change_request  every proposed edit: code sets, code values, master data rows
//   audit_log       one row per applied change, with before/after images
//   code_mapping    raw source values (system/table/column/value) mapped to a
//                   code value, or to NULL meaning "treat as missing"
//   code_mapping_v  the same, joined to set name, code and label, for pipelines
//
// Workflow: any user proposes a change → it waits as "pending" → a data
// steward approves (it is applied in the same transaction and audited) or
// rejects it. Stewards can't approve their own requests unless
// ERD_ALLOW_SELF_APPROVAL=true. ERD_STEWARDS is a comma-separated list of
// steward emails; when unset every user may review others' requests.
import * as lakebase from './lakebase.js';

const { ident } = lakebase;
export const SCHEMA = process.env.ERD_REFDATA_SCHEMA || 'refdata';
const S = ident(SCHEMA);

export class RefdataError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// --- identity ----------------------------------------------------------------

export function stewards() {
  return (process.env.ERD_STEWARDS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isSteward(user) {
  const list = stewards();
  return !list.length || list.includes(String(user).toLowerCase());
}

const selfApprovalAllowed = () => process.env.ERD_ALLOW_SELF_APPROVAL === 'true';

// --- schema -----------------------------------------------------------------

const DDL = `
CREATE SCHEMA IF NOT EXISTS ${S};
CREATE TABLE IF NOT EXISTS ${S}.code_set (
  id            serial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  description   text,
  source_system text,
  source_table  text,
  source_column text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL
);
CREATE TABLE IF NOT EXISTS ${S}.code_value (
  id          serial PRIMARY KEY,
  code_set_id int NOT NULL REFERENCES ${S}.code_set(id),
  code        text NOT NULL,
  label       text,
  description text,
  sort_order  int,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL,
  UNIQUE (code_set_id, code)
);
CREATE TABLE IF NOT EXISTS ${S}.change_request (
  id              serial PRIMARY KEY,
  kind            text NOT NULL,
  action          text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  target          jsonb NOT NULL DEFAULT '{}',
  payload         jsonb NOT NULL DEFAULT '{}',
  previous        jsonb,
  summary         text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'failed', 'cancelled')),
  requested_by    text NOT NULL,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  request_comment text,
  reviewed_by     text,
  reviewed_at     timestamptz,
  review_comment  text,
  error           text
);
-- Kinds are (re)declared here so stores created by earlier versions accept new ones.
ALTER TABLE ${S}.change_request DROP CONSTRAINT IF EXISTS change_request_kind_check;
ALTER TABLE ${S}.change_request ADD CONSTRAINT change_request_kind_check
  CHECK (kind IN ('code_set', 'code_value', 'master_row', 'code_mapping'));
CREATE INDEX IF NOT EXISTS change_request_status_idx ON ${S}.change_request (status, requested_at DESC);
CREATE TABLE IF NOT EXISTS ${S}.code_mapping (
  id            serial PRIMARY KEY,
  code_set_id   int NOT NULL REFERENCES ${S}.code_set(id),
  source_system text NOT NULL,
  source_table  text NOT NULL,
  source_column text NOT NULL,
  source_value  text NOT NULL,
  code_value_id int REFERENCES ${S}.code_value(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL,
  UNIQUE (code_set_id, source_system, source_table, source_column, source_value)
);
CREATE OR REPLACE VIEW ${S}.code_mapping_v AS
  SELECT m.source_system, m.source_table, m.source_column, m.source_value,
         s.name AS code_set, v.code, v.label, v.active, (m.code_value_id IS NULL) AS maps_to_missing
  FROM ${S}.code_mapping m
  JOIN ${S}.code_set s ON s.id = m.code_set_id
  LEFT JOIN ${S}.code_value v ON v.id = m.code_value_id;
CREATE TABLE IF NOT EXISTS ${S}.audit_log (
  id                bigserial PRIMARY KEY,
  change_request_id int REFERENCES ${S}.change_request(id),
  kind              text NOT NULL,
  action            text NOT NULL,
  target            jsonb NOT NULL,
  summary           text NOT NULL,
  before            jsonb,
  after             jsonb,
  requested_by      text NOT NULL,
  approved_by       text NOT NULL,
  applied_at        timestamptz NOT NULL DEFAULT now()
);`;

let ready = null;
export function ensureSchema() {
  if (!ready) {
    ready = lakebase.query(DDL).catch((err) => {
      ready = null;
      throw new RefdataError(
        `Could not create the ${SCHEMA} schema in Lakebase (${err.message}). The app's service principal needs CREATE on the database — attach the Lakebase resource with "Can connect and create".`,
        500,
      );
    });
  }
  return ready;
}

// --- reads ------------------------------------------------------------------

export async function listCodeSets() {
  await ensureSchema();
  const { rows } = await lakebase.query(`
    SELECT s.*,
           (SELECT count(*)::int FROM ${S}.code_value v WHERE v.code_set_id = s.id) AS value_count,
           (SELECT count(*)::int FROM ${S}.code_value v WHERE v.code_set_id = s.id AND v.active) AS active_count,
           (SELECT count(*)::int FROM ${S}.change_request c
             WHERE c.status = 'pending' AND c.kind IN ('code_set', 'code_value', 'code_mapping')
               AND (c.target->>'codeSetId')::int = s.id) AS pending_count
    FROM ${S}.code_set s ORDER BY s.name`);
  return rows;
}

export async function getCodeSet(id) {
  await ensureSchema();
  const { rows } = await lakebase.query(`SELECT * FROM ${S}.code_set WHERE id = $1`, [id]);
  if (!rows.length) throw new RefdataError(`Code set ${id} not found`, 404);
  const { rows: values } = await lakebase.query(
    `SELECT * FROM ${S}.code_value WHERE code_set_id = $1 ORDER BY sort_order NULLS LAST, code`,
    [id],
  );
  return { ...rows[0], values };
}

/** Code sets created from a given source table, keyed by column (for the ERD). */
export async function codeSetsForSource(system, table) {
  await ensureSchema();
  const { rows } = await lakebase.query(
    `SELECT id, name, source_column FROM ${S}.code_set WHERE source_system = $1 AND source_table = $2`,
    [system, table],
  );
  return rows;
}

/** All mappings of a code set, with the code they map to. */
export async function listMappings(codeSetId) {
  await ensureSchema();
  const { rows } = await lakebase.query(
    `SELECT m.*, v.code, v.label FROM ${S}.code_mapping m
     LEFT JOIN ${S}.code_value v ON v.id = m.code_value_id
     WHERE m.code_set_id = $1
     ORDER BY m.source_system, m.source_table, m.source_column, m.source_value`,
    [codeSetId],
  );
  return rows;
}

/** Mappings defined for columns of one source table (optionally one column). */
export async function mappingsForSource(system, table, column) {
  await ensureSchema();
  const params = [system, table];
  let where = 'm.source_system = $1 AND m.source_table = $2';
  if (column) {
    params.push(column);
    where += ' AND m.source_column = $3';
  }
  const { rows } = await lakebase.query(
    `SELECT m.*, s.name AS code_set_name, v.code, v.label FROM ${S}.code_mapping m
     JOIN ${S}.code_set s ON s.id = m.code_set_id
     LEFT JOIN ${S}.code_value v ON v.id = m.code_value_id
     WHERE ${where} ORDER BY m.source_column, m.source_value`,
    params,
  );
  return rows;
}

/** Existing mappings for these values: { value: { codeValueId } | null (unmapped) }. */
async function mappingSnapshot(db, codeSetId, source, values, lock = false) {
  const { rows } = await db.query(
    `SELECT source_value, code_value_id FROM ${S}.code_mapping
     WHERE code_set_id = $1 AND source_system = $2 AND source_table = $3 AND source_column = $4
       AND source_value = ANY($5::text[])${lock ? ' FOR UPDATE' : ''}`,
    [codeSetId, source.system, source.table, source.column, values],
  );
  const found = new Map(rows.map((r) => [r.source_value, { codeValueId: r.code_value_id }]));
  return Object.fromEntries(values.map((v) => [v, found.get(v) ?? null]));
}

export async function listChanges({ status, kind, limit = 200 } = {}) {
  await ensureSchema();
  const where = [];
  const params = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (kind) {
    params.push(kind);
    where.push(`kind = $${params.length}`);
  }
  const { rows } = await lakebase.query(
    `SELECT * FROM ${S}.change_request ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY requested_at DESC, id DESC LIMIT ${Math.min(Number(limit) || 200, 1000)}`,
    params,
  );
  return rows;
}

export async function pendingCount() {
  await ensureSchema();
  const { rows } = await lakebase.query(`SELECT count(*)::int AS n FROM ${S}.change_request WHERE status = 'pending'`);
  return rows[0].n;
}

export async function auditLog({ limit = 200 } = {}) {
  await ensureSchema();
  const { rows } = await lakebase.query(
    `SELECT * FROM ${S}.audit_log ORDER BY applied_at DESC, id DESC LIMIT ${Math.min(Number(limit) || 200, 1000)}`,
  );
  return rows;
}

// --- proposing changes ------------------------------------------------------

const CODE_SET_FIELDS = ['name', 'description'];
const CODE_VALUE_FIELDS = ['code', 'label', 'description', 'sort_order', 'active'];

const pick = (obj, fields) =>
  Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => fields.includes(k)));

const norm = (v) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

const required = (value, what) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new RefdataError(`${what} is required`);
  }
  return String(value).trim();
};

function editableSchemas() {
  return (process.env.ERD_EDITABLE_SCHEMAS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function masterTableMeta(schema, table) {
  if (schema === SCHEMA) {
    throw new RefdataError(`Tables in ${SCHEMA} are managed through code sets, not edited directly`, 403);
  }
  const allowed = editableSchemas();
  if (allowed.length && !allowed.includes(schema)) {
    throw new RefdataError(`Schema ${schema} is not editable (ERD_EDITABLE_SCHEMAS)`, 403);
  }
  const meta = await lakebase.tableMeta(schema, table);
  if (!meta.primaryKey.length) {
    throw new RefdataError(`${schema}.${table} has no primary key, so its rows can't be edited safely`);
  }
  return meta;
}

function keyClause(meta, key, startAt = 1) {
  const missing = meta.primaryKey.filter((k) => key?.[k] === undefined || key[k] === null);
  if (missing.length) throw new RefdataError(`Row key is missing ${missing.join(', ')}`);
  return {
    sql: meta.primaryKey.map((k, i) => `${ident(k)} = $${startAt + i}`).join(' AND '),
    params: meta.primaryKey.map((k) => key[k]),
  };
}

async function currentRow(db, meta, key, lock = false) {
  const where = keyClause(meta, key);
  const { rows } = await db.query(
    `SELECT * FROM ${ident(meta.schema)}.${ident(meta.table)} WHERE ${where.sql}${lock ? ' FOR UPDATE' : ''}`,
    where.params,
  );
  return rows[0] ?? null;
}

const describeKey = (key) => Object.values(key ?? {}).join('/');

/**
 * Validates a proposed change, snapshots what it will overwrite and stores it
 * as a pending change request.
 */
export async function proposeChange({ kind, action, target = {}, payload = {}, comment }, user) {
  await ensureSchema();
  let previous = null;
  let summary;
  let cleanPayload;

  if (kind === 'code_set' && action === 'create') {
    const name = required(payload.name, 'Code set name');
    const exists = await lakebase.query(`SELECT 1 FROM ${S}.code_set WHERE lower(name) = lower($1)`, [name]);
    if (exists.rows.length) throw new RefdataError(`A code set named "${name}" already exists`, 409);
    const values = (payload.values ?? []).map((v, i) => ({
      code: required(v.code, 'Code'),
      label: v.label ?? null,
      description: v.description ?? null,
      sort_order: v.sort_order ?? i + 1,
      active: v.active ?? true,
    }));
    const dupes = values.map((v) => v.code).filter((c, i, all) => all.indexOf(c) !== i);
    if (dupes.length) throw new RefdataError(`Duplicate codes: ${[...new Set(dupes)].join(', ')}`);
    cleanPayload = {
      name,
      description: payload.description ?? null,
      source: payload.source ? pick(payload.source, ['system', 'table', 'column']) : null,
      values,
    };
    summary = `Create code set "${name}" with ${values.length} value${values.length === 1 ? '' : 's'}`;
  } else if (kind === 'code_set' && action === 'update') {
    const set = await getCodeSet(target.codeSetId);
    cleanPayload = pick(payload, CODE_SET_FIELDS);
    if (!Object.keys(cleanPayload).length) throw new RefdataError('Nothing to change');
    previous = pick(set, CODE_SET_FIELDS);
    summary = `Update code set "${set.name}"`;
  } else if (kind === 'code_value' && action === 'create') {
    const set = await getCodeSet(target.codeSetId);
    cleanPayload = pick(payload, CODE_VALUE_FIELDS);
    const code = required(cleanPayload.code, 'Code');
    if (set.values.some((v) => v.code === code)) {
      throw new RefdataError(`Code "${code}" already exists in ${set.name}`, 409);
    }
    summary = `Add code "${code}" to ${set.name}`;
  } else if (kind === 'code_value' && action === 'update') {
    const set = await getCodeSet(target.codeSetId);
    const value = set.values.find((v) => v.id === Number(target.codeValueId));
    if (!value) throw new RefdataError(`Code value ${target.codeValueId} not found in ${set.name}`, 404);
    cleanPayload = pick(payload, CODE_VALUE_FIELDS);
    if (!Object.keys(cleanPayload).length) throw new RefdataError('Nothing to change');
    previous = pick(value, CODE_VALUE_FIELDS);
    const verb =
      cleanPayload.active === false ? 'Deactivate' : cleanPayload.active === true && !value.active ? 'Reactivate' : 'Update';
    summary = `${verb} code "${value.code}" in ${set.name}`;
  } else if (kind === 'code_mapping' && (action === 'create' || action === 'delete')) {
    const set = await getCodeSet(target.codeSetId);
    const src = target.source ?? {};
    for (const k of ['system', 'table', 'column']) required(src[k], `Source ${k}`);
    const source = { system: String(src.system), table: String(src.table), column: String(src.column) };
    const codeIds = new Set(set.values.map((v) => v.id));
    let entries;
    if (action === 'create') {
      entries = (payload.mappings ?? []).map((m) => {
        if (typeof m.value !== 'string') throw new RefdataError('Each mapping needs a source value');
        const id = m.codeValueId === null || m.codeValueId === undefined ? null : Number(m.codeValueId);
        if (id !== null && !codeIds.has(id)) throw new RefdataError(`Code value ${id} is not in ${set.name}`);
        return { value: m.value, codeValueId: id };
      });
    } else {
      entries = (payload.values ?? []).map((value) => ({ value: String(value) }));
    }
    if (!entries.length) throw new RefdataError('No mappings given');
    const values = entries.map((e) => e.value);
    if (new Set(values).size !== values.length) throw new RefdataError('A source value is listed twice');
    previous = await mappingSnapshot(lakebase, set.id, source, values);
    if (action === 'create') {
      // Drop entries that wouldn't change anything.
      entries = entries.filter((e) => previous[e.value]?.codeValueId !== e.codeValueId || previous[e.value] === null);
      if (!entries.length) throw new RefdataError('All of these values are already mapped that way');
      previous = Object.fromEntries(entries.map((e) => [e.value, previous[e.value]]));
      // Code names for display in the approval screen and history.
      const codes = Object.fromEntries(set.values.map((v) => [v.id, v.code]));
      cleanPayload = { mappings: entries, codes };
      summary = `Map ${entries.length} value${entries.length === 1 ? '' : 's'} of ${source.table}.${source.column} to ${set.name}`;
    } else {
      const missing = values.filter((v) => previous[v] === null);
      if (missing.length) throw new RefdataError(`Not mapped: ${missing.map((v) => JSON.stringify(v)).join(', ')}`);
      cleanPayload = { values, codes: Object.fromEntries(set.values.map((v) => [v.id, v.code])) };
      summary = `Remove ${values.length} mapping${values.length === 1 ? '' : 's'} of ${source.table}.${source.column} from ${set.name}`;
    }
    target = { codeSetId: set.id, source };
  } else if (kind === 'master_row') {
    const meta = await masterTableMeta(target.schema, target.table);
    const names = new Set(meta.columns.map((c) => c.name));
    const unknown = Object.keys(payload).filter((k) => !names.has(k));
    if (unknown.length) throw new RefdataError(`Unknown columns: ${unknown.join(', ')}`);
    const label = `${meta.schema}.${meta.table}`;
    if (action === 'create') {
      cleanPayload = payload;
      const key = Object.fromEntries(meta.primaryKey.map((k) => [k, payload[k]]));
      summary = `Add row ${describeKey(key) || '(generated key)'} to ${label}`;
    } else if (action === 'update' || action === 'delete') {
      const row = await currentRow(lakebase, meta, target.key);
      if (!row) throw new RefdataError(`Row ${describeKey(target.key)} not found in ${label}`, 404);
      if (action === 'update') {
        // Only keep columns that actually change.
        cleanPayload = Object.fromEntries(Object.entries(payload).filter(([k, v]) => norm(v) !== norm(row[k])));
        if (!Object.keys(cleanPayload).length) throw new RefdataError('Nothing to change');
        previous = pick(row, Object.keys(cleanPayload));
        summary = `Update ${Object.keys(cleanPayload).join(', ')} on ${label} row ${describeKey(target.key)}`;
      } else {
        cleanPayload = {};
        previous = row;
        summary = `Delete ${label} row ${describeKey(target.key)}`;
      }
    } else {
      throw new RefdataError(`Unsupported action ${action}`);
    }
    target = { schema: meta.schema, table: meta.table, ...(target.key ? { key: pick(target.key, meta.primaryKey) } : {}) };
  } else {
    throw new RefdataError(`Unsupported change ${kind}/${action}`);
  }

  const { rows } = await lakebase.query(
    `INSERT INTO ${S}.change_request (kind, action, target, payload, previous, summary, requested_by, request_comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [kind, action, target, cleanPayload, previous, summary, user, comment || null],
  );
  return rows[0];
}

export async function cancelChange(id, user) {
  await ensureSchema();
  const { rows } = await lakebase.query(
    `UPDATE ${S}.change_request SET status = 'cancelled', reviewed_by = $2, reviewed_at = now()
     WHERE id = $1 AND status = 'pending' AND requested_by = $2 RETURNING *`,
    [id, user],
  );
  if (!rows.length) throw new RefdataError('Only the requester can cancel a pending change', 403);
  return rows[0];
}

// --- reviewing and applying ---------------------------------------------------

function assertUnchanged(previous, current, what) {
  const changed = Object.keys(previous ?? {}).filter((k) => norm(previous[k]) !== norm(current?.[k]));
  if (changed.length) {
    throw new RefdataError(`${what} changed since this request was made (${changed.join(', ')}); propose the change again`, 409);
  }
}

function setClause(values, startAt) {
  const cols = Object.keys(values);
  return {
    sql: cols.map((c, i) => `${ident(c)} = $${startAt + i}`).join(', '),
    params: cols.map((c) => values[c]),
  };
}

async function apply(db, cr, user) {
  const { kind, action, target, payload, previous } = cr;

  if (kind === 'code_set' && action === 'create') {
    const src = payload.source ?? {};
    const { rows } = await db.query(
      `INSERT INTO ${S}.code_set (name, description, source_system, source_table, source_column, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
      [payload.name, payload.description, src.system ?? null, src.table ?? null, src.column ?? null, user],
    );
    const set = rows[0];
    for (const v of payload.values) {
      await db.query(
        `INSERT INTO ${S}.code_value (code_set_id, code, label, description, sort_order, active, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [set.id, v.code, v.label, v.description, v.sort_order, v.active, user],
      );
    }
    return { target: { codeSetId: set.id }, before: null, after: { ...set, values: payload.values } };
  }

  if (kind === 'code_set' && action === 'update') {
    const { rows } = await db.query(`SELECT * FROM ${S}.code_set WHERE id = $1 FOR UPDATE`, [target.codeSetId]);
    if (!rows.length) throw new RefdataError('Code set no longer exists', 404);
    assertUnchanged(previous, rows[0], 'The code set');
    const set = setClause(payload, 3);
    const { rows: after } = await db.query(
      `UPDATE ${S}.code_set SET ${set.sql}, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [target.codeSetId, user, ...set.params],
    );
    return { target, before: rows[0], after: after[0] };
  }

  if (kind === 'code_value' && action === 'create') {
    const { rows } = await db.query(
      `INSERT INTO ${S}.code_value (code_set_id, code, label, description, sort_order, active, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, true), $7, $7) RETURNING *`,
      [target.codeSetId, payload.code, payload.label ?? null, payload.description ?? null, payload.sort_order ?? null, payload.active ?? null, user],
    );
    return { target: { ...target, codeValueId: rows[0].id }, before: null, after: rows[0] };
  }

  if (kind === 'code_value' && action === 'update') {
    const { rows } = await db.query(`SELECT * FROM ${S}.code_value WHERE id = $1 AND code_set_id = $2 FOR UPDATE`, [
      target.codeValueId,
      target.codeSetId,
    ]);
    if (!rows.length) throw new RefdataError('Code value no longer exists', 404);
    assertUnchanged(previous, rows[0], 'The code value');
    const set = setClause(payload, 3);
    const { rows: after } = await db.query(
      `UPDATE ${S}.code_value SET ${set.sql}, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [target.codeValueId, user, ...set.params],
    );
    return { target, before: rows[0], after: after[0] };
  }

  if (kind === 'code_mapping') {
    const { codeSetId, source } = target;
    const values = action === 'create' ? payload.mappings.map((m) => m.value) : payload.values;
    const current = await mappingSnapshot(db, codeSetId, source, values, true);
    const changed = values.filter((v) => JSON.stringify(current[v]) !== JSON.stringify(previous?.[v] ?? null));
    if (changed.length) {
      throw new RefdataError(
        `Mappings changed since this request was made (${changed.map((v) => JSON.stringify(v)).join(', ')}); propose them again`,
        409,
      );
    }
    if (action === 'create') {
      for (const m of payload.mappings) {
        await db.query(
          `INSERT INTO ${S}.code_mapping (code_set_id, source_system, source_table, source_column, source_value, code_value_id, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
           ON CONFLICT (code_set_id, source_system, source_table, source_column, source_value)
           DO UPDATE SET code_value_id = EXCLUDED.code_value_id, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [codeSetId, source.system, source.table, source.column, m.value, m.codeValueId, user],
        );
      }
      return { target, before: current, after: Object.fromEntries(payload.mappings.map((m) => [m.value, { codeValueId: m.codeValueId }])) };
    }
    await db.query(
      `DELETE FROM ${S}.code_mapping WHERE code_set_id = $1 AND source_system = $2 AND source_table = $3
         AND source_column = $4 AND source_value = ANY($5::text[])`,
      [codeSetId, source.system, source.table, source.column, values],
    );
    return { target, before: current, after: null };
  }

  if (kind === 'master_row') {
    const meta = await masterTableMeta(target.schema, target.table);
    const from = `${ident(meta.schema)}.${ident(meta.table)}`;
    if (action === 'create') {
      const cols = Object.keys(payload);
      const { rows } = await db.query(
        cols.length
          ? `INSERT INTO ${from} (${cols.map(ident).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`
          : `INSERT INTO ${from} DEFAULT VALUES RETURNING *`,
        cols.map((c) => payload[c]),
      );
      const key = Object.fromEntries(meta.primaryKey.map((k) => [k, rows[0][k]]));
      return { target: { ...target, key }, before: null, after: rows[0] };
    }
    const row = await currentRow(db, meta, target.key, true);
    if (!row) throw new RefdataError('The row no longer exists', 404);
    assertUnchanged(previous, row, 'The row');
    if (action === 'update') {
      const set = setClause(payload, 1);
      const where = keyClause(meta, target.key, set.params.length + 1);
      const { rows } = await db.query(`UPDATE ${from} SET ${set.sql} WHERE ${where.sql} RETURNING *`, [
        ...set.params,
        ...where.params,
      ]);
      return { target, before: row, after: rows[0] };
    }
    const where = keyClause(meta, target.key);
    await db.query(`DELETE FROM ${from} WHERE ${where.sql}`, where.params);
    return { target, before: row, after: null };
  }

  throw new RefdataError(`Unsupported change ${kind}/${action}`);
}

/**
 * Approves (and applies) or rejects a pending change. An approval that can't
 * be applied — e.g. the row changed meanwhile or a constraint fails — marks
 * the request "failed" with the error instead.
 */
export async function reviewChange(id, { decision, comment }, user) {
  await ensureSchema();
  if (!['approve', 'reject'].includes(decision)) throw new RefdataError('decision must be approve or reject');
  if (!isSteward(user)) throw new RefdataError('Only data stewards can review changes', 403);

  return lakebase.transaction(async (db) => {
    const { rows } = await db.query(`SELECT * FROM ${S}.change_request WHERE id = $1 FOR UPDATE`, [id]);
    const cr = rows[0];
    if (!cr) throw new RefdataError(`Change request ${id} not found`, 404);
    if (cr.status !== 'pending') throw new RefdataError(`Change request ${id} is already ${cr.status}`, 409);
    if (cr.requested_by === user && !selfApprovalAllowed()) {
      throw new RefdataError('You cannot review your own change request', 403);
    }

    if (decision === 'reject') {
      const { rows: done } = await db.query(
        `UPDATE ${S}.change_request SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_comment = $3
         WHERE id = $1 RETURNING *`,
        [id, user, comment || null],
      );
      return done[0];
    }

    await db.query('SAVEPOINT apply_change');
    try {
      const result = await apply(db, cr, user);
      await db.query(
        `INSERT INTO ${S}.audit_log (change_request_id, kind, action, target, summary, before, after, requested_by, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [cr.id, cr.kind, cr.action, result.target, cr.summary, result.before, result.after, cr.requested_by, user],
      );
      const { rows: done } = await db.query(
        `UPDATE ${S}.change_request SET status = 'applied', target = $4, reviewed_by = $2, reviewed_at = now(), review_comment = $3
         WHERE id = $1 RETURNING *`,
        [id, user, comment || null, result.target],
      );
      return done[0];
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT apply_change');
      const { rows: failed } = await db.query(
        `UPDATE ${S}.change_request SET status = 'failed', reviewed_by = $2, reviewed_at = now(), review_comment = $3, error = $4
         WHERE id = $1 RETURNING *`,
        [id, user, comment || null, err.message],
      );
      return failed[0];
    }
  });
}
