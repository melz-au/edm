// Detects categorical columns by profiling a sample of each table.
//
// A column is categorical when its sample has few distinct values relative to
// its non-null rows, e.g. STATUS (OPERATING, DECOMMISSIONED, ...) or
// ASSETTYPE. Name hints (status, type, code, ...) loosen the ratio a little.
// Keys, free text that is mostly unique, measures and dates are excluded.
//
// The SQL is generated for two dialects:
//   'pg'    Lakebase / Postgres (run directly)
//   'spark' Unity Catalog via a Databricks SQL warehouse

import * as pii from './pii.js';
import { dominantShape } from './dq.js';

export const SAMPLE_ROWS = 10_000;
export const TOP_VALUES = 15;
export const MAX_DISTINCT = Number(process.env.ERD_CATEGORICAL_MAX_DISTINCT || 50);

const EXCLUDED_TYPE =
  /json|bytea|binary|array|struct|map<|variant|geo|xml|float|double|real|timestamp|^date|time|interval|tsvector|uuid|\[\]/i;
// Decimals with a fractional part (amounts, coordinates) and unscaled numerics.
const MEASURE_TYPE = /^(numeric|decimal)\s*(\(\s*\d+\s*,\s*[1-9]\d*\s*\))?$/i;
const NAME_HINT =
  /(status|type|code|categor|class|kind|level|flag|state|priority|condition|grade|tier|uom|unit|currency|country|region|site|org|gender|method|channel|source|mode|group|reason|^is_?|^has_?|yn$)/i;

export const quoteIdent = (dialect, name) =>
  dialect === 'spark' ? `\`${String(name).replace(/`/g, '``')}\`` : `"${String(name).replace(/"/g, '""')}"`;

export const tableRef = (dialect, parts) => parts.map((p) => quoteIdent(dialect, p)).join('.');

const textType = (dialect) => (dialect === 'spark' ? 'STRING' : 'TEXT');
const MISSING_TOKENS_SQL = ["''", "'NULL'", "'N/A'", "'NA'", "'-'", "'UNKNOWN'", "'NONE'", "'NIL'"].join(', ');

/** Columns worth profiling: not the table's single-column key, not a FK, not a measure/date/blob. */
export function candidateColumns(columns, primaryKey = []) {
  return columns.filter((c) => {
    if (c.pk && primaryKey.length <= 1) return false;
    if (c.fk) return false;
    const type = String(c.type ?? '').trim();
    if (EXCLUDED_TYPE.test(type) || MEASURE_TYPE.test(type)) return false;
    return true;
  });
}

/** One row: n, then d<i> (distinct) and nn<i> (non-null) for each column. */
export function profileSql(dialect, ref, columns, sample = SAMPLE_ROWS, allColumns = []) {
  const q = (n) => quoteIdent(dialect, n);
  const stats = [
    ...columns.flatMap((c, i) => [`count(DISTINCT ${q(c.name)}) AS d${i}`, `count(${q(c.name)}) AS nn${i}`]),
    // Filled count of every column (f<i> by position in allColumns): not null, not
    // blank and not a missing-value token, for completeness.
    ...allColumns.map(
      (c, i) =>
        `count(CASE WHEN ${q(c.name)} IS NOT NULL AND upper(trim(CAST(${q(c.name)} AS ${textType(dialect)}))) NOT IN (${MISSING_TOKENS_SQL}) THEN 1 END) AS f${i}`,
    ),
  ];
  return `WITH s AS (SELECT * FROM ${ref} LIMIT ${sample})
SELECT count(*) AS n${stats.length ? `, ${stats.join(', ')}` : ''} FROM s`;
}

/** Top values per column index: rows of (i, v, n). */
export function topValuesSql(dialect, ref, columns, sample = SAMPLE_ROWS, top = TOP_VALUES) {
  const q = (n) => quoteIdent(dialect, n);
  const branches = columns.map(
    ({ name, index }) =>
      `SELECT ${index} AS i, CAST(${q(name)} AS ${textType(dialect)}) AS v, count(*) AS n FROM s WHERE ${q(name)} IS NOT NULL GROUP BY 2`,
  );
  return `WITH s AS (SELECT * FROM ${ref} LIMIT ${sample}),
v AS (${branches.join('\nUNION ALL ')}),
r AS (SELECT i, v, n, row_number() OVER (PARTITION BY i ORDER BY n DESC, v) AS rn FROM v)
SELECT i, v, n FROM r WHERE rn <= ${top} ORDER BY i, n DESC, v`;
}

/** All distinct values of one column across the whole table (for seeding a code set). */
export function distinctValuesSql(dialect, ref, column, limit = 1000) {
  const c = quoteIdent(dialect, column);
  return `SELECT CAST(${c} AS ${textType(dialect)}) AS v, count(*) AS n FROM ${ref}
WHERE ${c} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${limit}`;
}

export function classify({ name, distinct, nonNull }) {
  const hint = NAME_HINT.test(name);
  if (!nonNull || !distinct) return { categorical: false, reason: 'no values in sample' };
  if (distinct >= nonNull) return { categorical: false, reason: 'every value is unique' };
  if (distinct > MAX_DISTINCT) return { categorical: false, reason: `more than ${MAX_DISTINCT} distinct values` };
  const ratio = distinct / nonNull;
  const limit = hint ? 0.5 : 0.2;
  if (ratio > limit) return { categorical: false, reason: 'values too varied for the number of rows' };
  const high = hint || (distinct <= 20 && ratio <= 0.05);
  return {
    categorical: true,
    confidence: high ? 'high' : 'medium',
    reason: `${distinct} distinct value${distinct === 1 ? '' : 's'} in ${nonNull} rows${hint ? ', name suggests a code' : ''}`,
  };
}

/**
 * Profiles one table. `run(sql)` executes a statement and resolves to an array
 * of row objects (Postgres client or SQL warehouse).
 */
export async function profileTable({ dialect, ref, columns, primaryKey, run }) {
  const candidates = candidateColumns(columns, primaryKey);
  const [stats] = await run(profileSql(dialect, ref, candidates, SAMPLE_ROWS, columns));
  const sampled = Number(stats?.n ?? 0);

  const results = candidates.map((c, i) => {
    const distinct = Number(stats[`d${i}`] ?? 0);
    const nonNull = Number(stats[`nn${i}`] ?? 0);
    return { name: c.name, type: c.type, distinct, nonNull, ...classify({ name: c.name, distinct, nonNull }), topValues: [] };
  });

  const categorical = results.map((r, index) => ({ ...r, index })).filter((r) => r.categorical);
  if (categorical.length) {
    const rows = await run(topValuesSql(dialect, ref, categorical));
    for (const row of rows) {
      results[Number(row.i)].topValues.push({ value: row.v, count: Number(row.n) });
    }
  }

  const skipped = columns
    .filter((c) => !candidates.includes(c))
    .map((c) => ({ name: c.name, type: c.type, categorical: false, reason: c.pk ? 'primary key' : c.fk ? 'foreign key' : 'measure, date or complex type', topValues: [] }));

  const order = new Map(columns.map((c, i) => [c.name, i]));
  const all = [...results, ...skipped].sort((a, b) => order.get(a.name) - order.get(b.name));

  // PII: sample values of text-like columns, then combine with name evidence.
  const sampleCols = pii.valueColumns(columns).map((c) => ({ name: c.name, index: order.get(c.name) }));
  const samples = new Map();
  if (sampleCols.length) {
    for (const row of await run(pii.samplesSql(dialect, ref, sampleCols, SAMPLE_ROWS))) {
      const name = columns[Number(row.i)].name;
      if (!samples.has(name)) samples.set(name, []);
      samples.get(name).push(row.v);
    }
  }
  for (const col of all) {
    col.pii = pii.assess(col.name, samples.get(col.name) ?? []);
    col.filled = Number(stats?.[`f${order.get(col.name)}`] ?? 0);
    // Dominant value format (e.g. AA9999999), for data quality rule suggestions.
    col.shape = samples.has(col.name) ? dominantShape(samples.get(col.name)) : null;
  }
  // Coordinates and postcodes only identify people when the table is about
  // people (e.g. a customer's address), not assets or sites.
  const aboutPeople = all.some((c) => c.pii && pii.DIRECT_IDENTIFIERS.has(c.pii.type));
  for (const col of all) {
    if (col.pii && !aboutPeople && pii.QUASI_IDENTIFIERS.has(col.pii.type)) col.pii = null;
    if (col.pii) {
      // Never send raw personal data to the browser.
      col.topValues = col.topValues.map((v) => ({ ...v, value: pii.mask(v.value, col.pii.type) }));
    }
  }

  return { sampled, sampleLimit: SAMPLE_ROWS, columns: all };
}
