// CREATE TABLE statements for proposed entities, in the dialect of the source
// they will be built in: Postgres for Lakebase, Databricks SQL for Unity
// Catalog (and the demo schema).
//
// Tables are created first, with their primary keys; foreign keys follow as
// ALTER TABLE statements, so entities can reference each other in any order
// (including cycles). A reference whose target column isn't that table's
// single-column primary key can't be declared as a foreign key in either
// dialect, so it is written out commented, with the reason.

import { END_LABELS } from './proposals.js';
import { isIntegerType, scd2Columns } from './star.js';

const DIALECT = {
  pg: {
    name: 'Postgres (Lakebase)',
    quote: (s) => `"${String(s).replace(/"/g, '""')}"`,
    string: (s) => `'${String(s).replace(/'/g, "''")}'`,
    // Postgres truncates identifiers at 63 bytes.
    constraint: (s) => s.slice(0, 63),
  },
  spark: {
    name: 'Databricks SQL (Unity Catalog)',
    quote: (s) => `\`${String(s).replace(/`/g, '``')}\``,
    string: (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
    constraint: (s) => s,
  },
};

export const dialectFor = (source) => (source === 'lakebase' ? 'pg' : 'spark');
export const dialectName = (dialect) => DIALECT[dialect].name;

function qualified(d, table) {
  const parts = d === DIALECT.pg ? [table.schema, table.name] : [table.catalog, table.schema, table.name];
  return parts.filter(Boolean).map(d.quote).join('.');
}

/**
 * DDL for the proposed entities of a merged model (see applyProposals).
 *   only           limit to these proposed table ids (default: every proposed entity);
 *                  references to proposed tables left out are written as comments
 *   ifNotExists    CREATE TABLE IF NOT EXISTS (default true)
 *   header         lines for the opening comment (model name, version, …)
 *   star           star schema annotations (star.js): a dimension's surrogate key
 *                  becomes an identity column, its business key a unique
 *                  constraint (Postgres; Unity Catalog has none), and a fact's
 *                  grain goes into the table comment
 */
export function generateDdl(model, { source, only = null, ifNotExists = true, header = [], star = {} } = {}) {
  const dialect = dialectFor(source);
  const d = DIALECT[dialect];
  const byId = new Map((model?.tables ?? []).map((t) => [t.id, t]));
  const wanted = (model?.tables ?? []).filter((t) => t.proposed && (!only || only.includes(t.id)));

  const out = [
    ...header.map((h) => `-- ${h}`),
    `-- Dialect: ${d.name}. Review before running: proposals are not checked against the live schema.`,
    '',
  ];
  if (!wanted.length) return `${out.join('\n')}-- No proposed entities.\n`;

  const foreignKeys = [];
  for (const t of wanted) {
    const name = qualified(d, t);
    const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
    const ann = star[t.id];
    // A generated surrogate key. Postgres takes any integer type; Databricks
    // identity columns must be BIGINT.
    const skCol = ann?.role === 'dimension' && ann.identity !== false && ann.surrogate
      ? t.columns.find((c) => c.name === ann.surrogate)
      : null;
    const identityOk = skCol && (dialect === 'pg' ? isIntegerType(skCol.type) : /^bigint$/i.test(skCol.type.trim()));
    const identity = identityOk ? skCol.name : null;
    if (skCol && !identityOk) {
      out.push(`-- Surrogate key ${skCol.name} is ${skCol.type}; make it ${dialect === 'pg' ? 'an integer type' : 'BIGINT'} to generate it as an identity column.`);
    }
    const lines = t.columns.map((c) => {
      let line = `  ${d.quote(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}`;
      if (c.name === identity) line += ' GENERATED ALWAYS AS IDENTITY';
      if (dialect === 'spark' && c.comment) line += ` COMMENT ${d.string(c.comment)}`;
      return line;
    });
    if (pk.length) {
      lines.push(`  CONSTRAINT ${d.quote(d.constraint(`pk_${t.name}`))} PRIMARY KEY (${pk.map(d.quote).join(', ')})`);
    }
    // Business key: unique per row (with the version start for SCD type 2).
    const business = ann?.role === 'dimension' ? (ann.business ?? []).filter((b) => t.columns.some((c) => c.name === b)) : [];
    const versioned = ann?.scd === 2 ? scd2Columns(t).from : null;
    const uniqueCols = business.length ? [...business, ...(versioned ? [versioned] : [])] : [];
    if (uniqueCols.length && dialect === 'pg') {
      lines.push(`  CONSTRAINT ${d.quote(d.constraint(`uq_${t.name}_business_key`))} UNIQUE (${uniqueCols.map(d.quote).join(', ')})`);
    }
    const role = ann?.role ? `${ann.role[0].toUpperCase()}${ann.role.slice(1)}${ann.role === 'dimension' ? ` (SCD type ${ann.scd ?? 1})` : ''}` : null;
    const comment = [t.comment, ann?.role === 'fact' && ann.grain ? `Grain: ${ann.grain}` : null].filter(Boolean).join('. ') || null;
    let stmt = `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (\n${lines.join(',\n')}\n)`;
    if (dialect === 'spark' && comment) stmt += `\nCOMMENT ${d.string(comment)}`;
    if (role) out.push(`-- ${role}`);
    if (uniqueCols.length && dialect === 'spark') {
      out.push(`-- Business key (keep unique in the load; Unity Catalog doesn't enforce it): ${uniqueCols.join(', ')}`);
    }
    out.push(`${stmt};`);

    if (dialect === 'pg') {
      if (comment) out.push(`COMMENT ON TABLE ${name} IS ${d.string(comment)};`);
      for (const c of t.columns.filter((c) => c.comment)) {
        out.push(`COMMENT ON COLUMN ${name}.${d.quote(c.name)} IS ${d.string(c.comment)};`);
      }
    }
    out.push('');

    for (const c of t.columns.filter((c) => c.references)) {
      const target = byId.get(c.references.table);
      foreignKeys.push(
        target?.proposed && only && !only.includes(target.id)
          ? `-- ${t.name}.${c.name} → ${target.name}.${c.references.column}: create the proposed ${target.name} first, then:\n-- ${foreignKeySql(d, t, c, target)}`
          : foreignKey(d, t, c, target),
      );
    }
  }

  if (foreignKeys.length) out.push('-- Relationships', ...foreignKeys, '');

  // Relationships drawn on the diagram document the design; they aren't keys.
  const wantedIds = new Set(wanted.map((t) => t.id));
  const name = (id) => byId.get(id)?.name ?? id;
  const drawn = (model?.relationships ?? []).filter(
    (r) => r.drawn && (wantedIds.has(r.from.table) || wantedIds.has(r.to.table)),
  );
  if (drawn.length) {
    out.push('-- Relationships drawn in the data model (documentation, not declared as keys):');
    for (const r of drawn) {
      const cols = r.from.columns.length && r.to.columns.length ? ` [${r.from.columns[0]} → ${r.to.columns[0]}]` : '';
      out.push(
        `--   ${name(r.from.table)} (${END_LABELS[r.override.fromEnd]}) → ${name(r.to.table)} (${END_LABELS[r.override.toEnd]})${r.phrase ? `: ${r.phrase}` : ''}${cols}`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

function foreignKey(d, table, column, target) {
  const { table: targetId, column: targetColumn } = column.references;
  if (!target) return `-- ${table.name}.${column.name}: ${targetId} is no longer in the schema, so no foreign key is declared.`;
  const stmt = foreignKeySql(d, table, column, target);
  const pk = target.columns.filter((c) => c.pk).map((c) => c.name);
  if (pk.length !== 1 || pk[0] !== targetColumn) {
    const why = pk.length
      ? `${target.name}.${targetColumn} isn't ${target.name}'s single-column primary key`
      : `${target.name} has no primary key`;
    return `-- ${why}; declare one first, or keep this as a documented relationship:\n-- ${stmt}`;
  }
  return stmt;
}

function foreignKeySql(d, table, column, target) {
  const constraint = d.quote(d.constraint(`fk_${table.name}_${column.name}`));
  return `ALTER TABLE ${qualified(d, table)} ADD CONSTRAINT ${constraint} FOREIGN KEY (${d.quote(column.name)}) REFERENCES ${qualified(d, target)} (${d.quote(column.references.column)});`;
}
