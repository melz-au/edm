// Star schema modelling: table roles (fact, dimension, bridge), surrogate and
// business keys, slowly changing dimension type, fact grain, and checks for
// the common patterns.
//
// Annotations live in the data model content as `star`, keyed by table id, so
// existing tables can be classified as well as proposed ones:
//   star[tableId] = { role, scd, surrogate, business: [cols], grain, identity }
//     role       'fact' | 'dimension' | 'bridge'
//     scd        1 | 2 (dimensions)
//     surrogate  the dimension's surrogate key column
//     business   the natural key column(s) from the source system
//     grain      what one fact row represents ("one row per order line")
//     identity   generate the surrogate key (default true; false for smart
//                keys such as a date dimension's yyyymmdd)
//
// Used by both the browser and the server, so no browser or Node APIs here.

import { proposedTableId, upsertEntity } from './proposals.js';

export const ROLES = ['fact', 'dimension', 'bridge'];
export const ROLE_LABELS = { fact: 'Fact', dimension: 'Dimension', bridge: 'Bridge' };
export const ROLE_BADGES = { fact: 'fact', dimension: 'dim', bridge: 'bridge' };

/** Role suggested by a table's name: dim_customer, fact_sales, fct_orders, bridge_account_customer. */
export function suggestRole(name) {
  const n = String(name).toLowerCase();
  if (/^(dim|d|dimension)_|_dim$/.test(n)) return 'dimension';
  if (/^(fact|fct|f)_|_fact$/.test(n)) return 'fact';
  if (/^(bridge|brg|br)_|_bridge$/.test(n)) return 'bridge';
  return null;
}

export const isIntegerType = (type = '') => /^(tiny|small|big)?int(eger)?$|^(int[248]|serial|bigserial|long|short)$/i.test(type.trim());
const isNumericType = (type = '') => isIntegerType(type) || /^(decimal|numeric|double|float|real|money)/i.test(type.trim());
const baseType = (type = '') => {
  const t = type.trim().toLowerCase().replace(/\(.*$/, '');
  return { integer: 'int', int4: 'int', int8: 'bigint', long: 'bigint', int2: 'smallint', short: 'smallint' }[t] ?? t;
};

// SCD type 2 history columns, by the names people usually give them.
const SCD2 = {
  from: /^(effective|valid|eff|row)_?(from|start)(_(date|ts|at))?$|^start_date$/i,
  to: /^(effective|valid|eff|row)_?(to|end)(_(date|ts|at))?$|^end_date$/i,
  current: /^(is_current|current_flag|is_active|current_ind|is_latest)$/i,
};

/** The SCD2 columns a table has, by role ({ from, to, current } column names or null). */
export function scd2Columns(table) {
  const find = (re) => table.columns.find((c) => re.test(c.name))?.name ?? null;
  return { from: find(SCD2.from), to: find(SCD2.to), current: find(SCD2.current) };
}

/**
 * The dimension's surrogate key: the annotated column, or (when not
 * annotated) a single-column integer primary key, marked as assumed.
 */
export function surrogateOf(table, ann) {
  if (ann?.surrogate) {
    const col = table.columns.find((c) => c.name === ann.surrogate);
    return col ? { column: col, assumed: false } : null;
  }
  const pk = table.columns.filter((c) => c.pk);
  if (pk.length === 1 && isIntegerType(pk[0].type)) return { column: pk[0], assumed: true };
  return null;
}

const label = (t) => t.name;

/**
 * Checks a merged model (see applyProposals) against common star schema
 * patterns. Returns issues { id, severity, rule, table, column, message, fix }
 * ordered errors first; `fix` is set where the app can repair a proposed table.
 */
export function checkStarSchema(model, star = {}) {
  const issues = [];
  if (!model) return issues;
  const tables = model.tables.filter((t) => !t.external);
  const byId = new Map(model.tables.map((t) => [t.id, t]));
  const role = (id) => star[id]?.role ?? null;
  const add = (severity, rule, table, message, { column = null, fix = null } = {}) =>
    issues.push({ id: `${rule}:${table.id}:${column ?? ''}`, severity, rule, table: table.id, column, message, fix });
  const outgoing = (id) => model.relationships.filter((r) => r.from.table === id && r.to.table !== id);
  const incoming = (id) => model.relationships.filter((r) => r.to.table === id && r.from.table !== id);

  for (const t of tables) {
    const ann = star[t.id];
    const r = ann?.role;
    if (!r) continue;
    const suggested = suggestRole(t.name);
    if (suggested && suggested !== r) {
      add('warning', 'role-name-mismatch', t, `${label(t)} is classified as a ${r} but its name suggests a ${suggested}.`);
    }

    if (r === 'dimension') {
      const sk = surrogateOf(t, ann);
      if (!sk) {
        add('error', 'dim-no-surrogate', t, ann?.surrogate
          ? `The surrogate key column ${ann.surrogate} no longer exists in ${label(t)}.`
          : `${label(t)} has no surrogate key. Dimensions need a meaningless integer key so history and source changes don't break the facts.`,
        { fix: t.proposed ? { type: 'add-surrogate', table: t.id } : null });
      } else {
        const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
        if (pk.length !== 1 || pk[0] !== sk.column.name) {
          add('warning', 'dim-surrogate-not-pk', t, `${label(t)}'s surrogate key ${sk.column.name} should be its only primary key column.`, { column: sk.column.name });
        }
        if (!isIntegerType(sk.column.type)) {
          add('warning', 'dim-surrogate-type', t, `${label(t)}'s surrogate key ${sk.column.name} is ${sk.column.type || 'untyped'}; use an integer (BIGINT) key.`, { column: sk.column.name });
        }
      }
      const business = (ann?.business ?? []).filter((b) => t.columns.some((c) => c.name === b));
      if (!business.length) {
        add('warning', 'dim-no-business-key', t, `${label(t)} has no business key. Mark the source system's natural key so loads can look up surrogate keys.`);
      }
      for (const b of business) {
        const col = t.columns.find((c) => c.name === b);
        if (col.nullable) add('warning', 'dim-business-nullable', t, `Business key ${b} in ${label(t)} should be required (NOT NULL).`, { column: b, fix: t.proposed ? { type: 'not-null', table: t.id, column: b } : null });
      }
      if (ann?.scd === 2) {
        const h = scd2Columns(t);
        const missing = Object.entries(h).filter(([, v]) => !v).map(([k]) => ({ from: 'effective from', to: 'effective to', current: 'current flag' })[k]);
        if (missing.length) {
          add('error', 'scd2-missing-columns', t, `${label(t)} is SCD type 2 but has no ${missing.join(', ')} column${missing.length > 1 ? 's' : ''}.`,
            { fix: t.proposed ? { type: 'add-scd2', table: t.id } : null });
        }
      }
      for (const rel of outgoing(t.id)) {
        const target = byId.get(rel.to.table);
        if (role(rel.to.table) === 'fact') {
          add('error', 'dim-references-fact', t, `${label(t)} references the fact ${label(target)}. Facts reference dimensions, not the other way round.`);
        } else if (role(rel.to.table) === 'dimension') {
          add('info', 'snowflake', t, `${label(t)} references the dimension ${label(target)} (snowflaking). Consider flattening its attributes into ${label(t)}.`);
        }
      }
      const usedBy = incoming(t.id).filter((rel) => ['fact', 'bridge'].includes(role(rel.from.table)));
      if (!usedBy.length) add('info', 'dim-unused', t, `No fact or bridge references ${label(t)} yet.`);
    }

    if (r === 'fact') {
      const toDims = outgoing(t.id).filter((rel) => role(rel.to.table) === 'dimension');
      if (!toDims.length) add('error', 'fact-no-dimensions', t, `${label(t)} doesn't reference any dimension.`);
      const keyCols = new Set();
      for (const rel of outgoing(t.id)) {
        const target = byId.get(rel.to.table);
        if (!target) continue;
        const targetRole = role(rel.to.table);
        if (targetRole === 'fact') {
          add('warning', 'fact-to-fact', t, `${label(t)} joins directly to the fact ${label(target)}. Share conformed dimensions instead.`);
          continue;
        }
        if (targetRole !== 'dimension') continue;
        const col = rel.from.columns.length === 1 ? t.columns.find((c) => c.name === rel.from.columns[0]) : null;
        if (!col) {
          add('info', 'fact-fk-unspecified', t, `The relationship from ${label(t)} to ${label(target)} doesn't name a key column.`);
          continue;
        }
        keyCols.add(col.name);
        const sk = surrogateOf(target, star[target.id]);
        if (sk && rel.to.columns[0] !== sk.column.name) {
          add('error', 'fact-fk-not-surrogate', t, `${label(t)}.${col.name} joins ${label(target)} on ${rel.to.columns[0]}, not its surrogate key ${sk.column.name}.`, { column: col.name });
        }
        if (col.nullable) {
          add('warning', 'fact-fk-nullable', t, `${label(t)}.${col.name} allows NULL. Point missing values at an "unknown" member row (e.g. key -1) and make it required.`,
            { column: col.name, fix: t.proposed ? { type: 'not-null', table: t.id, column: col.name } : null });
        }
        if (sk && baseType(col.type) !== baseType(sk.column.type)) {
          add('warning', 'fact-fk-type', t, `${label(t)}.${col.name} is ${col.type} but ${label(target)}.${sk.column.name} is ${sk.column.type}.`, { column: col.name });
        }
      }
      const measures = t.columns.filter((c) => !c.pk && !keyCols.has(c.name) && !c.fk && isNumericType(c.type));
      if (!measures.length) add('info', 'fact-no-measures', t, `${label(t)} has no numeric measures. That's fine for a factless fact that records events or coverage.`);
      if (!ann?.grain) add('warning', 'fact-no-grain', t, `Declare ${label(t)}'s grain: what one row represents.`);
    }

    if (r === 'bridge') {
      const linked = new Set(outgoing(t.id).map((rel) => rel.to.table));
      if (linked.size < 2) add('warning', 'bridge-few-links', t, `${label(t)} is a bridge but links ${linked.size} table${linked.size === 1 ? '' : 's'}; a bridge resolves many-to-many between two.`);
    }
  }

  const rank = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Tables with no role whose names suggest one: [{ table, role }]. */
export function roleSuggestions(model, star = {}) {
  return (model?.tables ?? [])
    .filter((t) => !t.external && !star[t.id]?.role)
    .map((t) => ({ table: t.id, role: suggestRole(t.name) }))
    .filter((s) => s.role);
}

// --- templates and fixes for proposed tables ----------------------------------

const TYPE_NAMES = {
  uc: { bigint: 'BIGINT', int: 'INT', text: 'STRING', date: 'DATE', timestamp: 'TIMESTAMP', boolean: 'BOOLEAN', money: 'DECIMAL(18,2)' },
  lakebase: { bigint: 'bigint', int: 'integer', text: 'text', date: 'date', timestamp: 'timestamptz', boolean: 'boolean', money: 'numeric(18,2)' },
};
TYPE_NAMES.demo = TYPE_NAMES.uc;
const typeFor = (source, kind) => (TYPE_NAMES[source] ?? TYPE_NAMES.uc)[kind];
const col = (name, type, extra = {}) => ({ name, type, pk: false, nullable: true, comment: null, ...extra });

function uniqueName(model, base) {
  const taken = new Set((model?.tables ?? []).map((t) => t.name.toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

/**
 * A starter entity and its star annotation for 'dimension', 'fact' or 'date'.
 * A new fact references the date dimension's surrogate key when there is one.
 */
export function starTemplate(kind, { source, scope, model, star = {} }) {
  const T = (k) => typeFor(source, k);
  if (kind === 'dimension') {
    const name = uniqueName(model, 'dim_new');
    const base = name.replace(/^dim_/, '');
    return {
      entity: {
        name,
        comment: null,
        columns: [
          col(`${base}_sk`, T('bigint'), { pk: true, nullable: false, comment: 'Surrogate key' }),
          col(`${base}_bk`, T('text'), { nullable: false, comment: 'Business key from the source system' }),
          col('name', T('text')),
        ],
      },
      star: { role: 'dimension', scd: 1, surrogate: `${base}_sk`, business: [`${base}_bk`], grain: null, identity: true },
    };
  }
  if (kind === 'date') {
    const name = uniqueName(model, 'dim_date');
    return {
      entity: {
        name,
        comment: 'One row per calendar day',
        columns: [
          col('date_sk', T('int'), { pk: true, nullable: false, comment: 'Smart key: yyyymmdd' }),
          col('full_date', T('date'), { nullable: false }),
          col('year', T('int'), { nullable: false }),
          col('quarter', T('int'), { nullable: false }),
          col('month', T('int'), { nullable: false }),
          col('month_name', T('text'), { nullable: false }),
          col('day_of_month', T('int'), { nullable: false }),
          col('day_of_week', T('int'), { nullable: false }),
          col('day_name', T('text'), { nullable: false }),
          col('is_weekend', T('boolean'), { nullable: false }),
        ],
      },
      star: { role: 'dimension', scd: 1, surrogate: 'date_sk', business: ['full_date'], grain: null, identity: false },
    };
  }
  // fact
  const name = uniqueName(model, 'fact_new');
  const columns = [];
  const dateDim = (model?.tables ?? []).find((t) => star[t.id]?.role === 'dimension' && /date/i.test(t.name) && surrogateOf(t, star[t.id]));
  if (dateDim) {
    const sk = surrogateOf(dateDim, star[dateDim.id]).column;
    columns.push(col(sk.name, sk.type, { nullable: false, references: { table: dateDim.id, column: sk.name } }));
  }
  columns.push(col('quantity', T('int')), col('amount', T('money')));
  return {
    entity: { name, comment: null, columns },
    star: { role: 'fact', scd: null, surrogate: null, business: [], grain: null, identity: true },
  };
}

/** Applies an issue's fix to a proposed table; returns the new proposal. */
export function applyStarFix(proposal, scope, fix, { source }) {
  const entity = proposal.tables.find((t) => proposedTableId(scope, t.name) === fix.table);
  if (!entity) return proposal;
  const T = (k) => typeFor(source, k);
  const ann = proposal.star?.[fix.table] ?? {};
  let columns = entity.columns;
  let nextAnn = ann;
  if (fix.type === 'not-null') {
    columns = columns.map((c) => (c.name === fix.column ? { ...c, nullable: false } : c));
  } else if (fix.type === 'add-scd2') {
    const h = scd2Columns(entity);
    columns = [
      ...columns,
      ...(h.from ? [] : [col('effective_from', T('timestamp'), { nullable: false })]),
      ...(h.to ? [] : [col('effective_to', T('timestamp'))]),
      ...(h.current ? [] : [col('is_current', T('boolean'), { nullable: false })]),
    ];
  } else if (fix.type === 'add-surrogate') {
    // The old primary key becomes the business key.
    const base = `${entity.name.replace(/^(dim|d|dimension)_/i, '').slice(0, 55)}_sk`;
    let sk = base;
    for (let i = 2; columns.some((c) => c.name === sk); i++) sk = `${base}${i}`;
    const oldPk = columns.filter((c) => c.pk).map((c) => c.name);
    columns = [
      col(sk, T('bigint'), { pk: true, nullable: false, comment: 'Surrogate key' }),
      ...columns.map((c) => (c.pk ? { ...c, pk: false, nullable: false } : c)),
    ];
    nextAnn = { ...ann, surrogate: sk, business: ann.business?.length ? ann.business : oldPk, identity: true };
  }
  const next = upsertEntity(proposal, scope, { ...entity, columns }, entity.name);
  return { ...next, star: { ...(proposal.star ?? {}), [fix.table]: nextAnn } };
}

export const FIX_LABELS = { 'add-surrogate': 'Add surrogate key', 'add-scd2': 'Add SCD2 columns', 'not-null': 'Make required' };
