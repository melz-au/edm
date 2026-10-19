// Data quality rules: suggested from a table's profile, stored in Lakebase,
// and run on demand against Lakebase (Postgres) or Unity Catalog (Databricks SQL).
//
// Rule types (params):
//   not_null        —                         value missing, blank or a missing token (N/A, NULL, -, ...)
//   unique          { columns: [..] }         value (or combination) appears more than once
//   allowed_values  { values } | { codeSetId, from: 'code_set' | 'mapping' }
//                                             value outside the list (code set codes or mapped values)
//   format          { regex, pattern }        value doesn't match the expected format
//   not_future      —                         date later than today
//   references      { parentTable, parentColumn }  value has no matching parent row
//
// Only failing-row counts and the most common failing values leave the
// database; failing values of personal-data columns are masked.

export const RULE_TYPES = {
  not_null: 'Not null',
  unique: 'Unique',
  allowed_values: 'Allowed values',
  format: 'Format',
  not_future: 'Not in the future',
  references: 'References',
};

const MISSING_TOKENS = ['', 'NULL', 'N/A', 'NA', '-', 'UNKNOWN', 'NONE', 'NIL'];

// --- format shapes ----------------------------------------------------------

/** "WC-2514886" → "AA-9999999": letters A/a, digits 9, everything else as is. */
export function shapeOf(value) {
  return String(value).replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '9');
}

const CLASS = { A: '[A-Z]', a: '[a-z]', 9: '[0-9]' };

/** A regex for a shape without backslashes, so it reads the same in Postgres and Spark. */
export function shapeRegex(shape) {
  let out = '^';
  for (let i = 0; i < shape.length; ) {
    const ch = shape[i];
    let j = i;
    while (j < shape.length && shape[j] === ch) j++;
    const n = j - i;
    if (CLASS[ch]) out += CLASS[ch] + (n > 1 ? `{${n}}` : '');
    else if (/[\]\\^]/.test(ch)) return null;
    else if (/[ ,/:;_@#&=%'"!<>~`]/.test(ch)) out += ch.repeat(n); // never special in a regex
    else out += `[${ch}]` + (n > 1 ? `{${n}}` : ''); // . - + ( ) $ etc. inside a bracket
    i = j;
  }
  return `${out}$`;
}

/** The most common shape among sampled values, if it covers at least `minShare`. */
export function dominantShape(values, minShare = 0.5) {
  const vals = values.map((v) => String(v)).filter((v) => v.trim() !== '');
  if (vals.length < 10) return null;
  const counts = new Map();
  for (const v of vals) counts.set(shapeOf(v), (counts.get(shapeOf(v)) ?? 0) + 1);
  const [pattern, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
  const share = n / vals.length;
  // Free text and long values don't have a meaningful single format.
  if (share < minShare || pattern.length > 24 || /\s\S+\s/.test(pattern)) return null;
  const regex = shapeRegex(pattern);
  if (!regex) return null;
  return { pattern, regex, share: Math.round(share * 1000) / 1000, shapes: counts.size };
}

// Semantic formats for detected personal data; more forgiving than a shape.
export const KNOWN_FORMATS = {
  email: { regex: '^[^@ ]+@[^@ ]+[.][A-Za-z]{2,}$', pattern: 'name@domain.tld' },
  phone: {
    regex: '^([+]61 ?|0)[2-478]( ?[0-9]){8}$|^[(]0[2-478][)] ?[0-9]{4} ?[0-9]{4}$',
    pattern: 'Australian phone number',
  },
};

// --- suggestions ------------------------------------------------------------

const UNIQUE_NAME = /(^|_)(no|num|number|id|key|guid|uuid)$|^e_?mail(_?addr(ess)?)?$|(no|num|id)$/i;
const normalise = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isMissingToken = (v) => MISSING_TOKENS.includes(String(v ?? '').trim().toUpperCase());
const NOT_FUTURE_NAME = /(birth|dob|created|install|connect|joined|registered|start|opened|signed|read_?date|last_)/i;
const DATE_TYPE = /date|timestamp/i;

/**
 * @param table          { id, name, columns: [{ name, type, pk, fk }] }
 * @param profile        profileTable() output (stats, topValues, pii, shape, filled)
 * @param relationships  model relationships where from.table === table.id
 * @param codeSets       [{ column, codeSetId, name, from: 'code_set' | 'mapping' }]
 * @returns [{ column, rule_type, params, severity, description, reason }]
 */
export function suggestRules({ table, profile, relationships = [], codeSets = [] }) {
  const out = [];
  const byName = new Map((profile?.columns ?? []).map((c) => [c.name, c]));
  const add = (column, rule_type, params, severity, description, reason) => {
    // Remember personal-data columns so failing values are masked when the rule runs.
    const piiType = byName.get(column)?.pii?.type;
    out.push({ column, rule_type, params: piiType ? { ...params, piiType } : params, severity, description, reason });
  };
  const pk = table.columns.filter((c) => c.pk).map((c) => c.name);
  const sampled = profile?.sampled ?? 0;

  if (pk.length) {
    add(pk.join(','), 'unique', { columns: pk }, 'error', `${pk.join(' + ')} is unique`, 'primary key');
  }

  for (const col of table.columns) {
    const p = byName.get(col.name) ?? {};
    const filled = p.filled ?? p.nonNull;
    const fillRate = sampled ? (filled ?? 0) / sampled : 0;

    if (col.pk || (sampled && fillRate >= 0.95)) {
      add(col.name, 'not_null', {}, col.pk ? 'error' : 'warning', `${col.name} is always filled in`,
        col.pk ? 'primary key' : `${Math.round(fillRate * 1000) / 10}% filled in the sample`);
    }

    // Identifier-like names that are (almost) unique: a few repeats are the duplicates to catch.
    if (!col.pk && UNIQUE_NAME.test(col.name) && p.distinct && p.nonNull >= 20 && p.distinct / p.nonNull >= 0.9) {
      const dupes = p.nonNull - p.distinct;
      add(col.name, 'unique', { columns: [col.name] }, 'warning', `${col.name} is unique`,
        dupes ? `identifier-like name; ${dupes} repeated value${dupes === 1 ? '' : 's'} in the sample` : 'identifier-like name; every sampled value differs');
    }

    const set = codeSets.find((s) => s.column === col.name);
    if (set && !p.pii) {
      add(col.name, 'allowed_values', { codeSetId: set.codeSetId, from: set.from }, 'error',
        set.from === 'mapping' ? `${col.name} uses only values mapped to ${set.name}` : `${col.name} uses only ${set.name} codes`,
        set.from === 'mapping' ? 'approved code mapping' : 'linked code set');
    } else if (p.categorical && !p.pii && p.topValues?.length && p.nonNull) {
      // Group spelling variants ("SA", "S.A.", "sa"); each group's most common
      // spelling is the canonical value. Groups under 5% of rows aren't allowed.
      const groups = new Map();
      for (const v of p.topValues) {
        if (isMissingToken(v.value)) continue;
        const key = normalise(v.value);
        const g = groups.get(key) ?? { canonical: v.value, top: v.count, total: 0 };
        if (v.count > g.top) Object.assign(g, { canonical: v.value, top: v.count });
        g.total += v.count;
        groups.set(key, g);
      }
      // A clean code list (no spelling variants, no value under 0.5% of rows) keeps
      // every value; a dirty one keeps only the groups with at least 5% of rows.
      const all = [...groups.values()];
      const clean = all.every((g) => g.top === g.total) && all.every((g) => g.total / p.nonNull >= 0.005);
      const main = all.filter((g) => clean || g.total / p.nonNull >= 0.05).sort((a, b) => b.total - a.total);
      const covered = main.reduce((n, g) => n + g.total, 0) / p.nonNull;
      if (main.length && covered >= 0.8) {
        const values = main.map((g) => g.canonical);
        const failing = p.topValues.filter((v) => !values.includes(v.value)).reduce((n, v) => n + v.count, 0);
        add(col.name, 'allowed_values', { values }, 'warning', `${col.name} is one of ${values.join(', ')}`,
          `the main values${failing ? `; ${Math.round((failing / p.nonNull) * 100)}% of sampled rows use other spellings or rare values` : ''}`);
      }
    }

    const known = p.pii && KNOWN_FORMATS[p.pii.type];
    if (known) {
      add(col.name, 'format', { ...known }, 'warning', `${col.name} is a valid ${known.pattern.toLowerCase()}`, `detected as ${p.pii.label.toLowerCase()}`);
    } else if (p.shape && !p.categorical && p.shape.pattern.includes('9') && p.pii?.type !== 'free_text') {
      add(col.name, 'format', { regex: p.shape.regex, pattern: p.shape.pattern }, 'warning', `${col.name} looks like ${p.shape.pattern}`,
        `${Math.round(p.shape.share * 100)}% of sampled values have this format${p.shape.shapes > 1 ? ` (${p.shape.shapes} formats seen)` : ''}`);
    }

    if (DATE_TYPE.test(col.type ?? '') && NOT_FUTURE_NAME.test(col.name)) {
      add(col.name, 'not_future', {}, 'warning', `${col.name} is not in the future`, 'a past-event date');
    }
  }

  for (const r of relationships) {
    if (r.inferred || r.from.columns.length !== 1 || r.to.columns.length !== 1) continue;
    add(r.from.columns[0], 'references', { parentTable: r.to.table, parentColumn: r.to.columns[0] }, 'error',
      `${r.from.columns[0]} exists in ${r.to.table}.${r.to.columns[0]}`, `foreign key ${r.name}`);
  }
  return out;
}

// --- SQL --------------------------------------------------------------------

export const quote = (dialect, name) =>
  dialect === 'spark' ? `\`${String(name).replace(/`/g, '``')}\`` : `"${String(name).replace(/"/g, '""')}"`;

export const tableRef = (dialect, parts) => parts.map((p) => quote(dialect, p)).join('.');

export function literal(dialect, value) {
  if (value === null || value === undefined) return 'NULL';
  const s = String(value);
  return dialect === 'spark' ? `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : `'${s.replace(/'/g, "''")}'`;
}

const text = (dialect, expr) => `CAST(${expr} AS ${dialect === 'spark' ? 'STRING' : 'TEXT'})`;

/**
 * Builds { countSql, sampleSql } for a rule. `ref` is the quoted table,
 * `ctx.values` the resolved allowed values, `ctx.parentRef` the quoted parent.
 */
export function ruleSql(dialect, ref, rule, ctx = {}) {
  const q = (n) => quote(dialect, n);
  const col = rule.column?.includes(',') ? null : `t.${q(rule.column)}`;
  let from = `${ref} t`;
  let fail;
  let sampleExpr = col && text(dialect, col);
  // Missing values are the not_null rule's concern; other rules judge present values only.
  const missing = col && `${col} IS NULL OR upper(trim(${text(dialect, col)})) IN (${MISSING_TOKENS.map((v) => literal(dialect, v)).join(', ')})`;
  const present = col && `NOT (${missing})`;

  switch (rule.rule_type) {
    case 'not_null':
      fail = missing;
      break;
    case 'allowed_values': {
      const values = ctx.values ?? rule.params.values ?? [];
      fail = values.length
        ? `${present} AND ${text(dialect, col)} NOT IN (${values.map((v) => literal(dialect, v)).join(', ')})`
        : present;
      break;
    }
    case 'format':
      fail = `${present} AND NOT (${text(dialect, col)} ${dialect === 'spark' ? 'RLIKE' : '~'} ${literal(dialect, rule.params.regex)})`;
      break;
    case 'not_future':
      fail = `${col} > CURRENT_DATE`;
      break;
    case 'references':
      from = `${ref} t LEFT JOIN (SELECT DISTINCT ${q(rule.params.parentColumn)} AS k FROM ${ctx.parentRef}) p ON p.k = ${col}`;
      fail = `${present} AND p.k IS NULL`;
      break;
    case 'unique': {
      const cols = rule.params.columns.map(q);
      const key = cols.length === 1 ? text(dialect, `t.${cols[0]}`) : `concat_ws(' | ', ${cols.map((c) => text(dialect, `t.${c}`)).join(', ')})`;
      from = `(SELECT t.*, count(*) OVER (PARTITION BY ${cols.map((c) => `t.${c}`).join(', ')}) AS dq_cnt FROM ${ref} t) t`;
      fail = `${cols.map((c) => `t.${c} IS NOT NULL`).join(' AND ')} AND t.dq_cnt > 1`;
      sampleExpr = key;
      break;
    }
    default:
      throw new Error(`Unknown rule type ${rule.rule_type}`);
  }
  return {
    countSql: `SELECT count(*) AS total, COALESCE(sum(CASE WHEN ${fail} THEN 1 ELSE 0 END), 0) AS failed FROM ${from}`,
    sampleSql: `SELECT ${sampleExpr} AS v, count(*) AS n FROM ${from} WHERE ${fail} GROUP BY ${sampleExpr} ORDER BY count(*) DESC LIMIT 5`,
  };
}
