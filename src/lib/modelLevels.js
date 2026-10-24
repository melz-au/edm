// Derives physical, logical and conceptual views from the raw ERD model.
//
//   physical   — tables, columns and database types exactly as stored
//   logical    — business names ("order_items" → "Order Item"), generic
//                data types, keys and cardinality; no physical detail
//   conceptual — entities and relationships only; pure junction tables are
//                collapsed into many-to-many relationships
//
// Every level annotates relationships with cardinality derived from keys:
//   parentEnd: 'one' | 'zero-one'   (FK columns NOT NULL → mandatory)
//   childEnd:  'many' | 'zero-one'  (FK columns == child PK → one-to-one)

import { cardinalityText } from './proposals.js';

export const LEVELS = [
  { id: 'physical', label: 'Physical' },
  { id: 'logical', label: 'Logical' },
  { id: 'conceptual', label: 'Conceptual' },
];

const ACRONYMS = new Set(['id', 'uuid', 'url', 'sku', 'ip', 'api', 'sla', 'kpi', 'gl', 'po']);

function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

function titleWord(w) {
  const lower = w.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function singularize(word) {
  const w = word.toLowerCase();
  if (/(ss|us|is)$/.test(w) || w.length <= 3) return word;
  if (/ies$/.test(w)) return word.slice(0, -3) + (word.at(-3) === 'I' ? 'Y' : 'y');
  if (/(xes|ches|shes|sses)$/.test(w) || (/uses$/.test(w) && !/ouses$/.test(w))) return word.slice(0, -2);
  if (/s$/.test(w)) return word.slice(0, -1);
  return word;
}

/** "order_items" → "Order Item", "dim_customer" → "Customer". */
export function entityName(tableName) {
  const parts = words(tableName);
  // Drop common warehouse/physical prefixes and suffixes.
  while (parts.length > 1 && /^(tbl|tb|t|dim|fact|fct|stg|raw|vw|v|ref|lkp)$/i.test(parts[0])) parts.shift();
  while (parts.length > 1 && /^(tbl|table|tab|view|vw)$/i.test(parts.at(-1))) parts.pop();
  if (parts.length) parts[parts.length - 1] = singularize(parts.at(-1));
  return parts.map(titleWord).join(' ');
}

/** "customer_id" → "Customer ID", "createdAt" → "Created At". */
export function attributeName(columnName) {
  return words(columnName).map(titleWord).join(' ');
}

/** "asset" + "assettype" → "Asset Type"; "asset" + "status" → "Asset Status". */
export function codeSetName(tableName, column) {
  const entity = entityName(tableName);
  const flatEntity = entity.replace(/\s+/g, '').toLowerCase();
  const col = String(column);
  if (col.toLowerCase().startsWith(flatEntity) && col.length > flatEntity.length) {
    const rest = col.slice(flatEntity.length).replace(/^[_\s-]+/, '');
    return `${entity} ${attributeName(rest)}`;
  }
  return `${entity} ${attributeName(col)}`;
}

/** Maps Spark/Delta and Postgres types onto a small set of logical types. */
export function logicalType(physical = '') {
  const t = physical.toLowerCase();
  if (!t) return '';
  if (/^(array|struct|map|variant|object)|json|\[\]/.test(t)) return 'Structured';
  if (/uuid/.test(t)) return 'Identifier';
  if (/bool/.test(t)) return 'Boolean';
  if (/timestamp|datetime/.test(t)) return 'Timestamp';
  if (/^date/.test(t)) return 'Date';
  if (/^time|interval/.test(t)) return 'Time';
  if (/int|serial|long|short|byte/.test(t)) return 'Integer';
  if (/decimal|numeric|double|float|real|money/.test(t)) return 'Number';
  if (/char|text|string|citext|name|enum/.test(t)) return 'Text';
  if (/binary|bytea|blob/.test(t)) return 'Binary';
  if (/geo|point|polygon/.test(t)) return 'Spatial';
  return attributeName(t.replace(/\(.*$/, ''));
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

function withCardinality(rel, tablesById) {
  // Cardinality drawn or set on the diagram wins over what the keys imply.
  if (rel.override) {
    const { fromEnd, toEnd } = rel.override;
    return { ...rel, childEnd: fromEnd, parentEnd: toEnd, cardinality: cardinalityText(fromEnd, toEnd) };
  }
  const child = tablesById.get(rel.from.table);
  const cols = new Map((child?.columns ?? []).map((c) => [c.name, c]));
  const fkCols = rel.from.columns.map((n) => cols.get(n)).filter(Boolean);
  const optional = fkCols.some((c) => c.nullable);
  const childPk = new Set((child?.columns ?? []).filter((c) => c.pk).map((c) => c.name));
  const oneToOne = childPk.size > 0 && sameSet(childPk, new Set(rel.from.columns));
  return {
    ...rel,
    parentEnd: optional ? 'zero-one' : 'one',
    childEnd: oneToOne ? 'zero-one' : 'many',
    cardinality: oneToOne ? '1:1' : 'N:1',
  };
}

/**
 * A junction table only exists to link two entities: its primary key is made
 * up entirely of foreign key columns, it references exactly two other tables
 * and nothing references it.
 */
function findJunctions(model) {
  const junctions = new Map();
  for (const t of model.tables) {
    if (t.external) continue;
    const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
    if (pk.length < 2) continue;
    const outgoing = model.relationships.filter((r) => r.from.table === t.id);
    const parents = new Set(outgoing.map((r) => r.to.table));
    const fkCols = new Set(outgoing.flatMap((r) => r.from.columns));
    const referenced = model.relationships.some((r) => r.to.table === t.id && r.from.table !== t.id);
    if (parents.size === 2 && !parents.has(t.id) && !referenced && pk.every((c) => fkCols.has(c))) {
      junctions.set(t.id, { table: t, parents: [...parents], outgoing });
    }
  }
  return junctions;
}

export function deriveView(model, level = 'physical') {
  if (!model) return null;
  const tablesById = new Map(model.tables.map((t) => [t.id, t]));

  const tables = model.tables.map((t) => ({
    ...t,
    label: level === 'physical' ? t.name : entityName(t.name),
    columns: t.columns.map((c) => ({
      ...c,
      label: level === 'physical' ? c.name : attributeName(c.name),
      displayType: level === 'physical' ? c.type : logicalType(c.type),
    })),
  }));
  const labels = new Map(tables.map((t) => [t.id, t.label]));

  let relationships = model.relationships.map((r) => {
    const rel = withCardinality(r, tablesById);
    const fromLabel = labels.get(r.from.table) ?? r.from.table;
    const toLabel = labels.get(r.to.table) ?? r.to.table;
    if (r.phrase) {
      rel.label = `${fromLabel} ${r.phrase} ${toLabel} (${rel.cardinality})`;
    } else if (level !== 'physical') {
      rel.label = `${fromLabel} ${rel.cardinality} ${toLabel}`;
    } else {
      rel.label = r.name;
    }
    return rel;
  });

  if (level !== 'conceptual') return { ...model, level, tables, relationships };

  // Conceptual: collapse junction tables into many-to-many relationships.
  const junctions = findJunctions(model);
  const kept = tables.filter((t) => !junctions.has(t.id));
  relationships = relationships.filter((r) => !junctions.has(r.from.table));
  for (const [id, j] of junctions) {
    const [a, b] = j.parents;
    const label = labels.get(id);
    relationships.push({
      id: `${id}:m2m`,
      name: j.table.name,
      label: `${labels.get(a)} M:N ${labels.get(b)} (via ${label})`,
      from: { table: a, columns: [] },
      to: { table: b, columns: [] },
      via: { table: id, label },
      inferred: j.outgoing.some((r) => r.inferred),
      parentEnd: 'many',
      childEnd: 'many',
      cardinality: 'M:N',
    });
  }
  return { ...model, level, tables: kept, relationships };
}
