// Proposed entities: tables designed in the app that don't exist in the source
// yet. They are kept apart from the loaded ERD and merged into it for display,
// and saved with the data model (see server/datamodels.js).
//
// Content shape (what gets saved):
//   {
//     tables: [{ name, comment, columns: [{ name, type, nullable, pk, comment,
//                                           references?: { table, column } }] }],
//     positions: { [tableId]: { x, y } }
//   }
// `references.table` is a table id from the merged model (existing or
// proposed); each reference becomes a relationship.
//
// Used by both the browser and the server, so no browser or Node APIs here.

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const TYPE = /^[A-Za-z][A-Za-z0-9_ ]*(\([0-9, ]+\))?(\[\])?$/;
export const LIMITS = { tables: 200, columns: 300, comment: 1000, type: 64 };

export const emptyProposal = () => ({ tables: [], positions: {} });

/** The part of the source a data model belongs to: "main.sales", "maximo" or "demo.retail". */
export function scopeName(source, catalog, schema) {
  if (source === 'uc') return catalog && schema ? `${catalog}.${schema}` : null;
  if (source === 'lakebase') return schema || null;
  if (source === 'demo') return 'demo.retail';
  return null;
}

/** Table id for a proposed table, matching how the source names its tables. */
export function proposedTableId(scope, name) {
  return `${scope}.${name}`;
}

function scopeParts(source, scope) {
  if (source === 'lakebase') return { schema: scope };
  const [catalog, ...rest] = scope.split('.');
  return { catalog, schema: rest.join('.') };
}

class ProposalError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

/**
 * Checks and normalises proposal content. Throws (status 400) on the first
 * problem, with a message that names the entity and column.
 */
export function validateProposal(content) {
  if (!content || typeof content !== 'object') throw new ProposalError('Model content is missing');
  const tables = Array.isArray(content.tables) ? content.tables : [];
  if (tables.length > LIMITS.tables) throw new ProposalError(`A model can hold at most ${LIMITS.tables} proposed entities`);

  const seenTables = new Set();
  const out = [];
  for (const t of tables) {
    const name = str(t?.name);
    if (!IDENT.test(name)) {
      throw new ProposalError(`"${name}" isn't a valid entity name: use letters, digits and underscores, starting with a letter`);
    }
    if (seenTables.has(name.toLowerCase())) throw new ProposalError(`There is more than one proposed entity called ${name}`);
    seenTables.add(name.toLowerCase());

    const cols = Array.isArray(t.columns) ? t.columns : [];
    if (!cols.length) throw new ProposalError(`${name} needs at least one column`);
    if (cols.length > LIMITS.columns) throw new ProposalError(`${name} has more than ${LIMITS.columns} columns`);
    const seenCols = new Set();
    const columns = cols.map((c) => {
      const cname = str(c?.name);
      if (!IDENT.test(cname)) throw new ProposalError(`${name}: "${cname}" isn't a valid column name`);
      if (seenCols.has(cname.toLowerCase())) throw new ProposalError(`${name} has more than one column called ${cname}`);
      seenCols.add(cname.toLowerCase());
      const type = str(c.type);
      if (!type || type.length > LIMITS.type || !TYPE.test(type)) {
        throw new ProposalError(`${name}.${cname}: "${type}" isn't a valid data type`);
      }
      const pk = Boolean(c.pk);
      const col = {
        name: cname,
        type,
        nullable: pk ? false : c.nullable !== false,
        pk,
        comment: str(c.comment).slice(0, LIMITS.comment) || null,
      };
      if (c.references) {
        const table = str(c.references.table);
        const column = str(c.references.column);
        if (!table || !IDENT.test(column)) throw new ProposalError(`${name}.${cname} has an incomplete reference`);
        col.references = { table, column };
      }
      return col;
    });
    out.push({ name, comment: str(t.comment).slice(0, LIMITS.comment) || null, columns });
  }

  const positions = {};
  for (const [id, p] of Object.entries(content.positions ?? {})) {
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) positions[id] = { x: Math.round(p.x), y: Math.round(p.y) };
  }
  return { tables: out, positions };
}

/**
 * Merges proposed entities into a loaded ERD model.
 * Returns { model, built, broken }:
 *   built   names of proposed entities that now exist in the source (not drawn
 *           twice; the real table is shown instead)
 *   broken  "table.column → target" references whose target no longer exists
 */
export function applyProposals(model, { source, scope, proposal }) {
  if (!model || !scope || !proposal?.tables?.length) return { model, built: [], broken: [] };
  const existing = new Set(model.tables.filter((t) => !t.external).map((t) => t.id));
  const built = [];
  const added = [];
  for (const t of proposal.tables) {
    const id = proposedTableId(scope, t.name);
    if (existing.has(id)) {
      built.push(t.name);
      continue;
    }
    added.push({
      id,
      name: t.name,
      ...scopeParts(source, scope),
      type: 'PROPOSED',
      comment: t.comment,
      proposed: true,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        comment: c.comment ?? null,
        pk: c.pk,
        fk: Boolean(c.references),
        references: c.references,
      })),
    });
  }

  // Drop external stubs that a proposed entity now stands in for.
  const addedIds = new Set(added.map((t) => t.id));
  const tables = [...model.tables.filter((t) => !addedIds.has(t.id)), ...added];
  const columnsOf = new Map(tables.map((t) => [t.id, new Set(t.columns.map((c) => c.name))]));

  const broken = [];
  const relationships = [...model.relationships];
  for (const t of added) {
    for (const c of t.columns) {
      if (!c.references) continue;
      const { table, column } = c.references;
      if (!columnsOf.get(table)?.has(column)) {
        broken.push(`${t.name}.${c.name} → ${table}.${column}`);
        continue;
      }
      relationships.push({
        id: `${t.id}:proposed:${c.name}`,
        name: `fk_${t.name}_${c.name}`,
        from: { table: t.id, columns: [c.name] },
        to: { table, columns: [column] },
        inferred: false,
        proposed: true,
      });
    }
  }
  return { model: { ...model, tables, relationships }, built, broken };
}

/** Columns another entity can reference: primary keys, or every column when a table has none. */
export function referenceTargets(model, excludeId) {
  const out = [];
  for (const t of model?.tables ?? []) {
    if (t.id === excludeId) continue;
    const pk = t.columns.filter((c) => c.pk);
    for (const c of pk.length ? pk : t.columns) {
      out.push({ table: t.id, tableName: t.name, column: c.name, type: c.type, proposed: Boolean(t.proposed) });
    }
  }
  return out;
}

/**
 * Removes a proposed entity and every reference to it from other proposed
 * entities. `keepReferences` is for an entity that has since been built: the
 * real table now answers those references.
 */
export function removeEntity(proposal, scope, name, { keepReferences = false } = {}) {
  const id = proposedTableId(scope, name);
  const tables = proposal.tables
    .filter((t) => t.name !== name)
    .map((t) =>
      keepReferences
        ? t
        : { ...t, columns: t.columns.map((c) => (c.references?.table === id ? { ...c, references: undefined } : c)) },
    );
  const positions = { ...proposal.positions };
  delete positions[id];
  return { ...proposal, tables, positions };
}

/** Adds or replaces (by its previous name) a proposed entity, renaming references to it. */
export function upsertEntity(proposal, scope, entity, previousName = null) {
  const oldId = previousName && proposedTableId(scope, previousName);
  const newId = proposedTableId(scope, entity.name);
  const renamed = oldId && oldId !== newId;
  const retarget = (t) =>
    renamed
      ? { ...t, columns: t.columns.map((c) => (c.references?.table === oldId ? { ...c, references: { ...c.references, table: newId } } : c)) }
      : t;
  const tables = proposal.tables.map(retarget);
  const i = previousName ? tables.findIndex((t) => t.name === previousName) : -1;
  const next = retarget(entity);
  if (i >= 0) tables[i] = next;
  else tables.push(next);
  const positions = { ...proposal.positions };
  if (renamed && positions[oldId]) {
    positions[newId] = positions[oldId];
    delete positions[oldId];
  }
  return { ...proposal, tables, positions };
}

/**
 * Applies saved or current positions to freshly laid-out nodes. Nodes without
 * a known position keep their auto-layout spot, shifted below the positioned
 * ones so they don't overlap them.
 */
export function placeNodes(nodes, known) {
  const has = (n) => known && known[n.id];
  const placed = nodes.filter(has);
  if (!placed.length) return nodes;
  const bottom = Math.max(...placed.map((n) => known[n.id].y)) + 400;
  const left = Math.min(...placed.map((n) => known[n.id].x));
  const rest = nodes.filter((n) => !has(n));
  const restTop = rest.length ? Math.min(...rest.map((n) => n.position.y)) : 0;
  const restLeft = rest.length ? Math.min(...rest.map((n) => n.position.x)) : 0;
  return nodes.map((n) =>
    has(n)
      ? { ...n, position: { x: known[n.id].x, y: known[n.id].y } }
      : { ...n, position: { x: left + n.position.x - restLeft, y: bottom + n.position.y - restTop } },
  );
}

/**
 * The free spot nearest `preferred` (a top-left corner) for a box of `size`,
 * clear of `rects` ({ x, y, width, height }) by `gap`. Searches a grid
 * outwards from the preferred spot, then falls back to the right of everything.
 */
export function freeSpot(rects, preferred, size, { gap = 40, step = 40, radius = 4000 } = {}) {
  const clear = (x, y) =>
    rects.every(
      (r) =>
        x + size.width + gap <= r.x || r.x + r.width + gap <= x || y + size.height + gap <= r.y || r.y + r.height + gap <= y,
    );
  const candidates = [];
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dy = -radius; dy <= radius; dy += step) candidates.push([dx, dy, dx * dx + dy * dy]);
  }
  candidates.sort((a, b) => a[2] - b[2]);
  for (const [dx, dy] of candidates) {
    if (clear(preferred.x + dx, preferred.y + dy)) return { x: preferred.x + dx, y: preferred.y + dy };
  }
  const right = Math.max(...rects.map((r) => r.x + r.width), preferred.x);
  return { x: right + gap, y: preferred.y };
}
