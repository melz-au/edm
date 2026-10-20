import dagre from '@dagrejs/dagre';

export const NODE_WIDTH = 280;
export const CONCEPT_WIDTH = 180;
export const CONCEPT_HEIGHT = 60;
export const HEADER_HEIGHT = 40;
export const ROW_HEIGHT = 26;
export const FOOTER_HEIGHT = 8;
export const MORE_HEIGHT = 20;

export const TABLE_HANDLE_IN = '__table-in';
export const TABLE_HANDLE_OUT = '__table-out';
export const TABLE_HANDLE_TOP = '__table-top';
export const TABLE_HANDLE_BOTTOM = '__table-bottom';

// Space between separately laid-out groups of tables.
const GROUP_GAP = 60;
const DEFAULT_VIEWPORT = { width: 1200, height: 800 };

export function visibleColumns(table, columnMode) {
  if (columnMode === 'keys') return table.columns.filter((c) => c.pk || c.fk);
  if (columnMode === 'none') return [];
  return table.columns;
}

export function nodeHeight(columnCount, hasMore = false) {
  return HEADER_HEIGHT + columnCount * ROW_HEIGHT + (hasMore ? MORE_HEIGHT : 0) + FOOTER_HEIGHT;
}

/** Groups of tables connected by relationships (direction ignored). */
export function connectedComponents(ids, relationships) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  for (const r of relationships) parent.set(find(r.from.table), find(r.to.table));

  const groups = new Map();
  for (const id of ids) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return [...groups.values()];
}

/** Lays out one connected group with dagre; positions are top-left, relative to the group. */
function layoutGroup(ids, sizes, relationships, dir, compact) {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({
    rankdir: dir,
    nodesep: compact ? 50 : 40,
    ranksep: dir === 'TB' ? 90 : compact ? 140 : 120,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) g.setNode(id, { ...sizes.get(id) });
  for (const r of relationships) {
    if (r.from.table !== r.to.table) g.setEdge(r.from.table, r.to.table, {}, r.id);
  }
  dagre.layout(g);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const raw = new Map();
  for (const id of ids) {
    const { x, y, width, height } = g.node(id);
    const left = x - width / 2;
    const top = y - height / 2;
    raw.set(id, { x: left, y: top });
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, left + width);
    maxY = Math.max(maxY, top + height);
  }
  const positions = new Map([...raw].map(([id, p]) => [id, { x: p.x - minX, y: p.y - minY }]));
  return { dir, positions, width: maxX - minX, height: maxY - minY };
}

/** Zoom at which a width × height drawing fits the viewport (capped at 1). */
function fitZoom(width, height, viewport) {
  return Math.min(1, viewport.width / width, viewport.height / height);
}

/**
 * Shelf-packs groups into rows no wider than `maxWidth`, tallest first.
 * Returns each group's offset and the overall bounds.
 */
export function shelfPack(items, maxWidth, gap = GROUP_GAP) {
  const order = [...items.keys()].sort(
    (a, b) => items[b].height - items[a].height || items[b].width - items[a].width,
  );
  const offsets = new Array(items.length);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const i of order) {
    const item = items[i];
    if (x > 0 && x + item.width > maxWidth) {
      y += rowHeight + gap;
      x = 0;
      rowHeight = 0;
    }
    offsets[i] = { x, y };
    x += item.width + gap;
    rowHeight = Math.max(rowHeight, item.height);
    width = Math.max(width, x - gap);
  }
  return { offsets, width, height: y + rowHeight };
}

/**
 * Packs the groups at the row width that lets the whole diagram fit the
 * viewport at the largest zoom. Candidate widths run from the widest group
 * up to everything on a single row.
 */
export function packToViewport(items, viewport) {
  const minWidth = Math.max(...items.map((i) => i.width));
  const maxWidth = items.reduce((sum, i) => sum + i.width + GROUP_GAP, -GROUP_GAP);
  const steps = 24;
  let best = null;
  for (let s = 0; s <= steps; s++) {
    const target = minWidth + ((maxWidth - minWidth) * s) / steps;
    const packed = shelfPack(items, target);
    const zoom = fitZoom(packed.width, packed.height, viewport);
    const area = packed.width * packed.height;
    if (!best || zoom > best.zoom + 1e-6 || (Math.abs(zoom - best.zoom) <= 1e-6 && area < best.area)) {
      best = { ...packed, zoom, area };
    }
  }
  return best;
}

/**
 * Converts the ERD model into React Flow nodes/edges and positions them to
 * make the best use of the viewport:
 *
 *   1. Tables are split into connected groups, so unrelated tables no longer
 *      pile up in one long column.
 *   2. Each group is laid out with dagre left-to-right (referencing tables sit
 *      left of the tables they reference). When only entity names are shown,
 *      a top-to-bottom layout is also tried, which suits long chains.
 *   3. Groups are shelf-packed into rows at whichever width lets the whole
 *      diagram fit the viewport at the largest zoom.
 */
export function buildGraph(
  model,
  { columnMode = 'all', showInferred = true, viewport = DEFAULT_VIEWPORT } = {},
) {
  const conceptual = model.level === 'conceptual';
  if (conceptual) columnMode = 'none';
  const vp = viewport?.width > 0 && viewport?.height > 0 ? viewport : DEFAULT_VIEWPORT;

  const tableIds = new Set(model.tables.map((t) => t.id));
  const visibleCols = new Map();
  const sizes = new Map();

  for (const table of model.tables) {
    const cols = visibleColumns(table, columnMode);
    visibleCols.set(table.id, new Set(cols.map((c) => c.name)));
    const hasMore = columnMode !== 'none' && cols.length < table.columns.length;
    sizes.set(
      table.id,
      conceptual
        ? { width: CONCEPT_WIDTH, height: CONCEPT_HEIGHT }
        : { width: NODE_WIDTH, height: nodeHeight(cols.length, hasMore) },
    );
  }

  const relationships = model.relationships.filter(
    (r) => tableIds.has(r.from.table) && tableIds.has(r.to.table) && (showInferred || !r.inferred),
  );

  // Column-level handles sit on the left/right of each row, so top-to-bottom
  // only reads well when columns are hidden.
  const allowVertical = columnMode === 'none';
  const groups = connectedComponents([...tableIds], relationships).map((ids) => {
    const members = new Set(ids);
    const rels = relationships.filter((r) => members.has(r.from.table));
    const options = [layoutGroup(ids, sizes, rels, 'LR', conceptual)];
    if (allowVertical && rels.some((r) => r.from.table !== r.to.table)) {
      options.push(layoutGroup(ids, sizes, rels, 'TB', conceptual));
    }
    return options;
  });

  // Try every group horizontal, every group vertical, and each group in
  // whichever direction best matches the viewport's shape.
  const aspect = vp.width / vp.height;
  const closestToViewport = (opts) =>
    opts.reduce((a, b) =>
      Math.abs(Math.log(a.width / a.height / aspect)) <= Math.abs(Math.log(b.width / b.height / aspect)) ? a : b,
    );
  const candidates = [groups.map((opts) => opts[0])];
  if (groups.some((opts) => opts.length > 1)) {
    candidates.push(groups.map((opts) => opts.at(-1)));
    candidates.push(groups.map(closestToViewport));
  }

  let chosen = null;
  for (const layouts of candidates) {
    const packed = packToViewport(layouts, vp);
    if (!chosen || packed.zoom > chosen.packed.zoom + 1e-6) chosen = { layouts, packed };
  }

  const placement = new Map();
  chosen.layouts.forEach((layout, i) => {
    const offset = chosen.packed.offsets[i];
    for (const [id, p] of layout.positions) {
      placement.set(id, { x: offset.x + p.x, y: offset.y + p.y, dir: layout.dir });
    }
  });

  const nodes = model.tables.map((table) => {
    const { x, y } = placement.get(table.id);
    return {
      id: table.id,
      type: 'table',
      position: { x, y },
      data: { table, columnMode, level: model.level ?? 'physical' },
    };
  });

  const edges = relationships.map((r) => {
    const vertical = placement.get(r.from.table).dir === 'TB' && r.from.table !== r.to.table;
    const fromCol = r.from.columns[0];
    const toCol = r.to.columns[0];
    let sourceHandle;
    let targetHandle;
    if (vertical) {
      sourceHandle = TABLE_HANDLE_BOTTOM;
      targetHandle = TABLE_HANDLE_TOP;
    } else {
      sourceHandle =
        r.from.columns.length === 1 && visibleCols.get(r.from.table).has(fromCol)
          ? `${fromCol}-out`
          : TABLE_HANDLE_OUT;
      targetHandle =
        r.to.columns.length === 1 && visibleCols.get(r.to.table).has(toCol)
          ? `${toCol}-in`
          : TABLE_HANDLE_IN;
    }
    return {
      id: r.id,
      source: r.from.table,
      target: r.to.table,
      sourceHandle,
      targetHandle,
      type: 'smoothstep',
      markerStart: `erd-${r.childEnd ?? 'many'}`,
      markerEnd: `erd-${r.parentEnd ?? 'one'}`,
      className: ['erd-edge', r.inferred && 'inferred', r.proposed && 'proposed'].filter(Boolean).join(' '),
      data: { relationship: r },
    };
  });

  return { nodes, edges };
}
