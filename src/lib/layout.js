import dagre from '@dagrejs/dagre';

export const NODE_WIDTH = 280;
export const HEADER_HEIGHT = 40;
export const ROW_HEIGHT = 26;
export const FOOTER_HEIGHT = 8;
export const MORE_HEIGHT = 20;

export const TABLE_HANDLE_IN = '__table-in';
export const TABLE_HANDLE_OUT = '__table-out';

export function visibleColumns(table, columnMode) {
  if (columnMode === 'keys') return table.columns.filter((c) => c.pk || c.fk);
  if (columnMode === 'none') return [];
  return table.columns;
}

export function nodeHeight(columnCount, hasMore = false) {
  return HEADER_HEIGHT + columnCount * ROW_HEIGHT + (hasMore ? MORE_HEIGHT : 0) + FOOTER_HEIGHT;
}

/**
 * Converts the ERD model into React Flow nodes/edges and positions them with
 * dagre, left-to-right: referencing (child) tables sit left of the tables
 * they reference.
 */
export function buildGraph(model, { columnMode = 'all', showInferred = true } = {}) {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 120, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  const tableIds = new Set(model.tables.map((t) => t.id));
  const visibleCols = new Map();

  for (const table of model.tables) {
    const cols = visibleColumns(table, columnMode);
    visibleCols.set(table.id, new Set(cols.map((c) => c.name)));
    const hasMore = columnMode !== 'none' && cols.length < table.columns.length;
    g.setNode(table.id, { width: NODE_WIDTH, height: nodeHeight(cols.length, hasMore) });
  }

  const relationships = model.relationships.filter(
    (r) => tableIds.has(r.from.table) && tableIds.has(r.to.table) && (showInferred || !r.inferred),
  );
  for (const r of relationships) {
    if (r.from.table !== r.to.table) g.setEdge(r.from.table, r.to.table, {}, r.id);
  }

  dagre.layout(g);

  const nodes = model.tables.map((table) => {
    const { x, y, width, height } = g.node(table.id);
    return {
      id: table.id,
      type: 'table',
      position: { x: x - width / 2, y: y - height / 2 },
      data: { table, columnMode },
    };
  });

  const edges = relationships.map((r) => {
    const fromCol = r.from.columns[0];
    const toCol = r.to.columns[0];
    const sourceHandle =
      r.from.columns.length === 1 && visibleCols.get(r.from.table).has(fromCol)
        ? `${fromCol}-out`
        : TABLE_HANDLE_OUT;
    const targetHandle =
      r.to.columns.length === 1 && visibleCols.get(r.to.table).has(toCol)
        ? `${toCol}-in`
        : TABLE_HANDLE_IN;
    return {
      id: r.id,
      source: r.from.table,
      target: r.to.table,
      sourceHandle,
      targetHandle,
      type: 'smoothstep',
      markerStart: 'erd-many',
      markerEnd: 'erd-one',
      className: r.inferred ? 'erd-edge inferred' : 'erd-edge',
      data: { relationship: r },
    };
  });

  return { nodes, edges };
}
