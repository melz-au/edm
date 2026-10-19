// Stores data quality rules and their latest results in the Lakebase refdata
// schema, and runs them. Table: <refdata>.dq_rule (created on first use).
import * as lakebase from './lakebase.js';
import * as refdata from './refdata.js';
import * as pii from './pii.js';
import { RULE_TYPES, ruleSql } from './dq.js';

const S = lakebase.ident(refdata.SCHEMA);

// bigint columns arrive as strings from node-postgres.
const asRule = (r) =>
  r && { ...r, last_total: r.last_total === null ? null : Number(r.last_total), last_failed: r.last_failed === null ? null : Number(r.last_failed) };

let ready = null;
function ensure() {
  if (!ready) {
    ready = refdata
      .ensureSchema()
      .then(() =>
        lakebase.query(`
          CREATE TABLE IF NOT EXISTS ${S}.dq_rule (
            id            serial PRIMARY KEY,
            source_system text NOT NULL,
            source_table  text NOT NULL,
            column_name   text NOT NULL,
            rule_type     text NOT NULL,
            params        jsonb NOT NULL DEFAULT '{}',
            severity      text NOT NULL DEFAULT 'warning' CHECK (severity IN ('error', 'warning')),
            description   text NOT NULL,
            reason        text,
            created_by    text NOT NULL,
            created_at    timestamptz NOT NULL DEFAULT now(),
            last_run_at   timestamptz,
            last_total    bigint,
            last_failed   bigint,
            last_samples  jsonb,
            last_error    text,
            UNIQUE (source_system, source_table, column_name, rule_type)
          )`),
      )
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}

export async function listRules(system, table) {
  await ensure();
  const { rows } = await lakebase.query(
    `SELECT * FROM ${S}.dq_rule WHERE source_system = $1 AND source_table = $2 ORDER BY severity, column_name, rule_type`,
    [system, table],
  );
  return rows.map(asRule);
}

/** Per-table score for every table of a schema prefix ("maximo." or "main.sales."). */
export async function summary(system, prefix) {
  await ensure();
  const { rows } = await lakebase.query(
    `SELECT source_table,
            count(*)::int AS rules,
            count(last_run_at)::int AS run,
            count(*) FILTER (WHERE last_failed > 0)::int AS failing,
            avg(CASE WHEN last_total > 0 THEN 1 - last_failed::float / last_total END) AS score,
            max(last_run_at) AS last_run_at
     FROM ${S}.dq_rule WHERE source_system = $1 AND source_table LIKE $2 || '%'
     GROUP BY source_table`,
    [system, prefix],
  );
  return rows;
}

export async function addRules(system, table, rules, user) {
  await ensure();
  const added = [];
  for (const r of rules) {
    if (!RULE_TYPES[r.rule_type]) throw Object.assign(new Error(`Unknown rule type ${r.rule_type}`), { status: 400 });
    const { rows } = await lakebase.query(
      `INSERT INTO ${S}.dq_rule (source_system, source_table, column_name, rule_type, params, severity, description, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (source_system, source_table, column_name, rule_type)
       DO UPDATE SET params = EXCLUDED.params, severity = EXCLUDED.severity, description = EXCLUDED.description,
                     reason = EXCLUDED.reason, last_run_at = NULL, last_total = NULL, last_failed = NULL,
                     last_samples = NULL, last_error = NULL
       RETURNING *`,
      [system, table, r.column, r.rule_type, r.params ?? {}, r.severity === 'error' ? 'error' : 'warning', r.description, r.reason ?? null, user],
    );
    added.push(asRule(rows[0]));
  }
  return added;
}

export async function deleteRule(id) {
  await ensure();
  await lakebase.query(`DELETE FROM ${S}.dq_rule WHERE id = $1`, [id]);
}

/**
 * Runs every rule of a table.
 *   exec(sql)         → rows (Postgres or SQL warehouse)
 *   dialect, ref      quoted table reference for that dialect
 *   columns           the table's real columns (identifiers are checked against them)
 *   parentRef(name)   quoted reference for a parent table (references rules)
 */
export async function runRules({ system, table, exec, dialect, ref, columns, parentRef }) {
  const rules = await listRules(system, table);
  const known = new Set(columns.map((c) => c.name));
  const results = [];
  for (const rule of rules) {
    let result;
    try {
      for (const c of rule.column_name.split(',')) {
        if (!known.has(c)) throw new Error(`Column ${c} no longer exists`);
      }
      const ctx = {};
      if (rule.rule_type === 'allowed_values' && rule.params.codeSetId) ctx.values = await allowedValues(rule, system, table);
      if (rule.rule_type === 'references') ctx.parentRef = await parentRef(rule.params.parentTable);
      const { countSql, sampleSql } = ruleSql(dialect, ref, { ...rule, column: rule.column_name }, ctx);
      const [counts] = await exec(countSql);
      const failed = Number(counts?.failed ?? 0);
      let samples = [];
      if (failed > 0) {
        const piiType = rule.params.piiType ?? pii.detectByName(rule.column_name);
        samples = (await exec(sampleSql)).map((r) => ({
          value: piiType && r.v !== null ? pii.mask(r.v, piiType) : r.v,
          count: Number(r.n),
        }));
      }
      result = { total: Number(counts?.total ?? 0), failed, samples, error: null };
    } catch (err) {
      result = { total: null, failed: null, samples: null, error: err.message };
    }
    const { rows } = await lakebase.query(
      `UPDATE ${S}.dq_rule SET last_run_at = now(), last_total = $2, last_failed = $3, last_samples = $4, last_error = $5
       WHERE id = $1 RETURNING *`,
      // JSON.stringify: node-postgres would send a JS array as a Postgres array, not jsonb.
      [rule.id, result.total, result.failed, result.samples && JSON.stringify(result.samples), result.error],
    );
    results.push(asRule(rows[0]));
  }
  return results;
}

/** Values allowed by a code set rule: the set's active codes, or the values mapped to it. */
async function allowedValues(rule, system, table) {
  if (rule.params.from === 'mapping') {
    const mappings = await refdata.mappingsForSource(system, table, rule.column_name);
    return mappings.filter((m) => m.code_set_id === rule.params.codeSetId).map((m) => m.source_value);
  }
  const set = await refdata.getCodeSet(rule.params.codeSetId);
  return set.values.filter((v) => v.active).map((v) => v.code);
}
