// Saved data models: proposed entities and diagram positions for one schema,
// stored in the Lakebase refdata schema (created on first use):
//   data_model          one row per model, with the current content and version
//   data_model_version  every saved version, for history
//
// Saving needs the version the editor started from, so two people editing the
// same model can't silently overwrite each other's work.
import * as lakebase from './lakebase.js';
import * as refdata from './refdata.js';
import { validateProposal } from '../src/lib/proposals.js';

const S = lakebase.ident(refdata.SCHEMA);
const SOURCES = new Set(['uc', 'lakebase', 'demo']);

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

let ready = null;
function ensure() {
  if (!ready) {
    ready = refdata
      .ensureSchema()
      .then(() =>
        lakebase.query(`
          CREATE TABLE IF NOT EXISTS ${S}.data_model (
            id            serial PRIMARY KEY,
            name          text NOT NULL,
            description   text,
            source_system text NOT NULL,
            scope         text NOT NULL,
            content       jsonb NOT NULL,
            version       int NOT NULL DEFAULT 1,
            created_by    text NOT NULL,
            created_at    timestamptz NOT NULL DEFAULT now(),
            updated_by    text NOT NULL,
            updated_at    timestamptz NOT NULL DEFAULT now()
          );
          CREATE UNIQUE INDEX IF NOT EXISTS data_model_name_uq ON ${S}.data_model (source_system, scope, lower(name));
          CREATE TABLE IF NOT EXISTS ${S}.data_model_version (
            model_id    int NOT NULL REFERENCES ${S}.data_model(id) ON DELETE CASCADE,
            version     int NOT NULL,
            name        text NOT NULL,
            description text,
            content     jsonb NOT NULL,
            saved_by    text NOT NULL,
            saved_at    timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (model_id, version)
          )`),
      )
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}

function checkName(name) {
  const n = String(name ?? '').trim();
  if (!n) throw fail('Give the model a name');
  if (n.length > 200) throw fail('Model names can be at most 200 characters');
  return n;
}

const description = (d) => String(d ?? '').trim().slice(0, 2000) || null;

const duplicateName = (err, name) =>
  err.code === '23505' ? fail(`A model called "${name}" already exists for this schema`, 409) : err;

const SUMMARY = `id, name, description, source_system, scope, version, created_by, created_at, updated_by, updated_at,
  jsonb_array_length(content->'tables') AS entity_count`;

export async function listModels(source, scope) {
  await ensure();
  const { rows } = await lakebase.query(
    `SELECT ${SUMMARY} FROM ${S}.data_model WHERE source_system = $1 AND scope = $2 ORDER BY lower(name)`,
    [source, scope],
  );
  return rows;
}

export async function getModel(id) {
  await ensure();
  const { rows } = await lakebase.query(`SELECT * FROM ${S}.data_model WHERE id = $1`, [id]);
  if (!rows.length) throw fail('Model not found', 404);
  return rows[0];
}

export async function createModel({ name, description: desc, source, scope, content }, user) {
  await ensure();
  if (!SOURCES.has(source)) throw fail('Unknown source');
  if (!scope || typeof scope !== 'string') throw fail('Choose a schema before saving a model');
  const n = checkName(name);
  const c = validateProposal(content);
  return lakebase.transaction(async (db) => {
    let row;
    try {
      ({ rows: [row] } = await db.query(
        `INSERT INTO ${S}.data_model (name, description, source_system, scope, content, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
        [n, description(desc), source, scope, c, user],
      ));
    } catch (err) {
      throw duplicateName(err, n);
    }
    await saveVersion(db, row, user);
    return row;
  });
}

/** Saves a new version. `version` must be the one the editor loaded. */
export async function saveModel(id, { name, description: desc, content, version }, user) {
  await ensure();
  const n = checkName(name);
  const c = validateProposal(content);
  return lakebase.transaction(async (db) => {
    const { rows: [current] } = await db.query(`SELECT * FROM ${S}.data_model WHERE id = $1 FOR UPDATE`, [id]);
    if (!current) throw fail('Model not found', 404);
    if (Number(version) !== current.version) {
      throw fail(
        `${current.updated_by} saved this model (version ${current.version}) after you opened it. Reopen it to see their changes, or save yours as a new model.`,
        409,
      );
    }
    let row;
    try {
      ({ rows: [row] } = await db.query(
        `UPDATE ${S}.data_model SET name = $2, description = $3, content = $4, version = version + 1,
                updated_by = $5, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, n, description(desc), c, user],
      ));
    } catch (err) {
      throw duplicateName(err, n);
    }
    await saveVersion(db, row, user);
    return row;
  });
}

function saveVersion(db, row, user) {
  return db.query(
    `INSERT INTO ${S}.data_model_version (model_id, version, name, description, content, saved_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.id, row.version, row.name, row.description, row.content, user],
  );
}

/** Only the model's creator or a data steward can delete it. */
export async function deleteModel(id, user) {
  const model = await getModel(id);
  if (model.created_by.toLowerCase() !== String(user).toLowerCase() && !refdata.isSteward(user)) {
    throw fail(`Only ${model.created_by} or a data steward can delete this model`, 403);
  }
  await lakebase.query(`DELETE FROM ${S}.data_model WHERE id = $1`, [id]);
}

export async function listVersions(id) {
  await ensure();
  const { rows } = await lakebase.query(
    `SELECT version, name, saved_by, saved_at, jsonb_array_length(content->'tables') AS entity_count
     FROM ${S}.data_model_version WHERE model_id = $1 ORDER BY version DESC`,
    [id],
  );
  return rows;
}

export async function getVersion(id, version) {
  await ensure();
  const { rows } = await lakebase.query(`SELECT * FROM ${S}.data_model_version WHERE model_id = $1 AND version = $2`, [id, version]);
  if (!rows.length) throw fail('Version not found', 404);
  return rows[0];
}
