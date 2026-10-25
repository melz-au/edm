import { apiGet, apiGetAll } from './databricks.js';

const UC = '/api/2.1/unity-catalog';

export async function listCatalogs(userToken) {
  const catalogs = await apiGetAll(`${UC}/catalogs`, 'catalogs', {}, userToken);
  return catalogs
    .map((c) => ({ name: c.name, comment: c.comment ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listSchemas(catalog, userToken) {
  const schemas = await apiGetAll(`${UC}/schemas`, 'schemas', { catalog_name: catalog }, userToken);
  return schemas
    .filter((s) => s.name !== 'information_schema')
    .map((s) => ({ name: s.name, comment: s.comment ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Builds the ERD model for every table in catalog.schema. Primary and foreign
 * keys come from Unity Catalog table constraints. Tables referenced from other
 * schemas are added as "external" nodes so the relationship is still drawn.
 */
export async function getErd(catalog, schema, userToken) {
  const ucTables = await apiGetAll(
    `${UC}/tables`,
    'tables',
    { catalog_name: catalog, schema_name: schema, max_results: 50 },
    userToken,
  );
  return buildModelFromUcTables(await withConstraints(ucTables, userToken));
}

const NO_CONSTRAINTS = new Set(['VIEW', 'MATERIALIZED_VIEW', 'METRIC_VIEW']);

/**
 * The List Tables API doesn't return table constraints, so primary and foreign
 * keys would be missing. Fetch each table that could have them, a few at a
 * time; a table that can't be fetched keeps what the list gave.
 */
async function withConstraints(ucTables, userToken, concurrency = 8) {
  const out = [...ucTables];
  const todo = out
    .map((t, i) => [t, i])
    .filter(([t]) => t.table_constraints === undefined && !NO_CONSTRAINTS.has(t.table_type));
  const worker = async () => {
    for (let item = todo.shift(); item; item = todo.shift()) {
      const [t, i] = item;
      try {
        const full = await apiGet(`${UC}/tables/${encodeURIComponent(t.full_name)}`, {}, userToken);
        out[i] = { ...t, ...full };
      } catch {
        // Keep the listed table: columns without keys beat no table.
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

/** One table's columns and keys (used to validate names before profiling). */
export async function getTable(catalog, schema, table, userToken) {
  const t = await apiGet(`${UC}/tables/${encodeURIComponent(`${catalog}.${schema}.${table}`)}`, {}, userToken);
  const model = buildModelFromUcTables([t]);
  const found = model.tables.find((x) => x.id === t.full_name);
  return { ...found, primaryKey: found.columns.filter((c) => c.pk).map((c) => c.name) };
}

export function buildModelFromUcTables(ucTables) {
  const tables = new Map();
  const relationships = [];

  for (const t of ucTables) {
    const pkCols = new Set();
    for (const c of t.table_constraints ?? []) {
      for (const col of c.primary_key_constraint?.child_columns ?? []) pkCols.add(col);
    }

    tables.set(t.full_name, {
      id: t.full_name,
      name: t.name,
      catalog: t.catalog_name,
      schema: t.schema_name,
      type: t.table_type ?? 'TABLE',
      comment: t.comment ?? null,
      columns: [...(t.columns ?? [])]
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((c) => ({
          name: c.name,
          type: c.type_text ?? c.type_name ?? '',
          nullable: c.nullable !== false,
          comment: c.comment ?? null,
          pk: pkCols.has(c.name),
          fk: false,
        })),
    });

    for (const c of t.table_constraints ?? []) {
      const fk = c.foreign_key_constraint;
      if (!fk) continue;
      relationships.push({
        id: `${t.full_name}:${fk.name}`,
        name: fk.name,
        from: { table: t.full_name, columns: fk.child_columns ?? [] },
        to: { table: fk.parent_table, columns: fk.parent_columns ?? [] },
        inferred: false,
      });
    }
  }

  // Mark FK columns and add stub nodes for parents outside this schema.
  for (const rel of relationships) {
    const child = tables.get(rel.from.table);
    for (const col of child.columns) {
      if (rel.from.columns.includes(col.name)) col.fk = true;
    }
    if (!tables.has(rel.to.table)) {
      const [cat, sch, name] = rel.to.table.split('.');
      tables.set(rel.to.table, {
        id: rel.to.table,
        name,
        catalog: cat,
        schema: sch,
        type: 'EXTERNAL_REFERENCE',
        comment: 'Referenced table outside the selected schema',
        external: true,
        columns: rel.to.columns.map((n) => ({
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
