import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import TableNode from './components/TableNode.jsx';
import TableDetails from './components/TableDetails.jsx';
import ErdMarkers from './components/ErdMarkers.jsx';
import { api } from './lib/api.js';
import { buildGraph } from './lib/layout.js';
import { LEVELS, deriveView } from './lib/modelLevels.js';

const nodeTypes = { table: TableNode };

const SOURCES = [
  { id: 'uc', label: 'Unity Catalog' },
  { id: 'lakebase', label: 'Lakebase' },
  { id: 'demo', label: 'Demo' },
];

const matchesQuery = (table, query) =>
  table.name.toLowerCase().includes(query) || table.label.toLowerCase().includes(query);

export default function App() {
  const rf = useReactFlow();
  const [config, setConfig] = useState(null);
  const [source, setSource] = useState(null);
  const [catalogs, setCatalogs] = useState([]);
  const [catalog, setCatalog] = useState('');
  const [schemas, setSchemas] = useState([]);
  const [schema, setSchema] = useState('');
  const [infer, setInfer] = useState(false);
  const [columnMode, setColumnMode] = useState('all');
  const [level, setLevel] = useState('physical');
  const [model, setModel] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges] = useState([]);
  const requestId = useRef(0);
  const defaults = useRef({});

  // Runs an async loader, ignoring results from superseded requests.
  const run = useCallback(async (loader, onResult) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loader();
      if (id === requestId.current) onResult(result);
    } catch (err) {
      if (id === requestId.current) setError(err.message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    api
      .config()
      .then((cfg) => {
        setConfig(cfg);
        defaults.current = { catalog: cfg.defaultCatalog, schema: cfg.defaultSchema };
        const preferred = cfg.sources[cfg.defaultSource]?.available ? cfg.defaultSource : 'demo';
        setSource(preferred);
      })
      .catch((err) => {
        setError(`Could not reach the app server: ${err.message}`);
        setSource('demo');
      });
  }, []);

  // Source changed: reset and load the first level of choices.
  useEffect(() => {
    if (!source) return;
    setModel(null);
    setSelectedId(null);
    setCatalogs([]);
    setSchemas([]);
    setCatalog('');
    setSchema('');
    if (source === 'uc') {
      run(api.ucCatalogs, (list) => {
        setCatalogs(list);
        const def = defaults.current.catalog;
        if (def && list.some((c) => c.name === def)) setCatalog(def);
      });
    } else if (source === 'lakebase') {
      run(api.lakebaseSchemas, (list) => {
        setSchemas(list);
        const def = defaults.current.schema;
        const pick = (def && list.find((s) => s.name === def)) || list.find((s) => s.name === 'public');
        if (pick) setSchema(pick.name);
      });
    }
  }, [source, run]);

  // Unity Catalog: catalog changed -> load schemas.
  useEffect(() => {
    if (source !== 'uc' || !catalog) return;
    setSchemas([]);
    setSchema('');
    run(
      () => api.ucSchemas(catalog),
      (list) => {
        setSchemas(list);
        const def = defaults.current.schema;
        if (def && list.some((s) => s.name === def)) setSchema(def);
      },
    );
  }, [source, catalog, run]);

  // Load the ERD once the scope is fully chosen.
  useEffect(() => {
    if (source === 'demo') {
      run(() => api.demoErd(infer), setModel);
    } else if (source === 'uc' && catalog && schema) {
      run(() => api.ucErd(catalog, schema, infer), setModel);
    } else if (source === 'lakebase' && schema) {
      run(() => api.lakebaseErd(schema, infer), setModel);
    }
  }, [source, catalog, schema, infer, run]);

  const view = useMemo(() => deriveView(model, level), [model, level]);

  const layout = useCallback(() => {
    if (!view) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const graph = buildGraph(view, { columnMode });
    setNodes(graph.nodes);
    setEdges(graph.edges);
    requestAnimationFrame(() => rf.fitView({ padding: 0.15, duration: 300 }));
  }, [view, columnMode, rf, setNodes]);

  useEffect(layout, [layout]);

  const tablesById = useMemo(
    () => new Map((view?.tables ?? []).map((t) => [t.id, t])),
    [view],
  );

  const focusTable = useCallback(
    (id) => {
      setSelectedId(id);
      rf.fitView({ nodes: [{ id }], duration: 500, padding: 0.6, maxZoom: 1.2 });
    },
    [rf],
  );

  // Highlight the active table, its neighbours and connecting edges.
  const activeId = hoveredId ?? selectedId;
  const query = search.trim().toLowerCase();

  const { displayNodes, displayEdges } = useMemo(() => {
    const neighbours = new Set();
    const columnsByTable = new Map();
    const mark = (table, cols) => {
      if (!columnsByTable.has(table)) columnsByTable.set(table, new Set());
      cols.forEach((c) => columnsByTable.get(table).add(c));
    };

    const displayEdges = edges.map((e) => {
      const connected = activeId && (e.source === activeId || e.target === activeId);
      if (connected) {
        neighbours.add(e.source);
        neighbours.add(e.target);
        const r = e.data.relationship;
        mark(r.from.table, r.from.columns);
        mark(r.to.table, r.to.columns);
      }
      return {
        ...e,
        className: `${e.className}${connected ? ' active' : ''}${activeId && !connected ? ' dimmed' : ''}`,
        label: connected ? e.data.relationship.label : undefined,
        zIndex: connected ? 10 : 0,
      };
    });

    const displayNodes = nodes.map((n) => {
      const matches = !query || matchesQuery(n.data.table, query);
      const related = !activeId || n.id === activeId || neighbours.has(n.id);
      const classes = [];
      if (n.id === activeId) classes.push('active');
      if (!matches || !related) classes.push('dimmed');
      if (query && matches) classes.push('match');
      return {
        ...n,
        selected: n.id === selectedId,
        className: classes.join(' '),
        data: { ...n.data, highlightColumns: columnsByTable.get(n.id) },
      };
    });

    return { displayNodes, displayEdges };
  }, [nodes, edges, activeId, selectedId, query]);

  const filteredTables = useMemo(
    () =>
      (view?.tables ?? [])
        .filter((t) => !query || matchesQuery(t, query))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [view, query],
  );

  const selectedTable = selectedId ? tablesById.get(selectedId) : null;
  const inferredCount = view?.relationships.filter((r) => r.inferred).length ?? 0;
  const physical = level === 'physical';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__logo" aria-hidden="true">◆</span>
          ERD Explorer
        </div>
        {view && (
          <div className="stats">
            <span>{view.tables.length} {physical ? 'tables' : 'entities'}</span>
            <span>
              {view.relationships.length} relationships
              {inferredCount > 0 && ` (${inferredCount} inferred)`}
            </span>
          </div>
        )}
        {config?.user && <div className="user">{config.user}</div>}
      </header>

      <div className="body">
        <aside className="sidebar">
          <section>
            <label className="label">Source</label>
            <div className="segmented">
              {SOURCES.map((s) => {
                const available = !config || config.sources[s.id]?.available;
                return (
                  <button
                    key={s.id}
                    className={source === s.id ? 'active' : ''}
                    disabled={!available}
                    title={available ? undefined : `${s.label} is not configured for this app`}
                    onClick={() => setSource(s.id)}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </section>

          {source === 'uc' && (
            <section>
              <label className="label" htmlFor="catalog">Catalog</label>
              <select id="catalog" value={catalog} onChange={(e) => setCatalog(e.target.value)}>
                <option value="">Select a catalog…</option>
                {catalogs.map((c) => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
              </select>
              <label className="label" htmlFor="schema">Schema</label>
              <select
                id="schema"
                value={schema}
                disabled={!catalog}
                onChange={(e) => setSchema(e.target.value)}
              >
                <option value="">Select a schema…</option>
                {schemas.map((s) => (
                  <option key={s.name} value={s.name}>{s.name}</option>
                ))}
              </select>
            </section>
          )}

          {source === 'lakebase' && (
            <section>
              {config?.sources.lakebase.host && (
                <div className="conn">
                  <div>{config.sources.lakebase.database}</div>
                  <div className="muted">{config.sources.lakebase.host}</div>
                </div>
              )}
              <label className="label" htmlFor="pg-schema">Schema</label>
              <select id="pg-schema" value={schema} onChange={(e) => setSchema(e.target.value)}>
                <option value="">Select a schema…</option>
                {schemas.map((s) => (
                  <option key={s.name} value={s.name}>{s.name}</option>
                ))}
              </select>
            </section>
          )}

          <section className="options">
            <label className="label">Model</label>
            <div className="segmented">
              {LEVELS.map((l) => (
                <button key={l.id} className={level === l.id ? 'active' : ''} onClick={() => setLevel(l.id)}>
                  {l.label}
                </button>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={infer} onChange={(e) => setInfer(e.target.checked)} />
              Infer relationships from column names
            </label>
            <label className="label" htmlFor="columns">{physical ? 'Columns' : 'Attributes'}</label>
            <select
              id="columns"
              value={level === 'conceptual' ? 'none' : columnMode}
              disabled={level === 'conceptual'}
              onChange={(e) => setColumnMode(e.target.value)}
            >
              <option value="all">{physical ? 'All columns' : 'All attributes'}</option>
              <option value="keys">Keys only</option>
              <option value="none">{physical ? 'Table names only' : 'Entity names only'}</option>
            </select>
          </section>

          {error && <div className="error">{error}</div>}

          {model && (
            <section className="tables">
              <input
                type="search"
                placeholder={physical ? 'Search tables…' : 'Search entities…'}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <ul>
                {filteredTables.map((t) => (
                  <li key={t.id}>
                    <button
                      className={t.id === selectedId ? 'active' : ''}
                      onClick={() => focusTable(t.id)}
                      onMouseEnter={() => setHoveredId(t.id)}
                      onMouseLeave={() => setHoveredId(null)}
                    >
                      <span>{t.label}</span>
                      <span className="muted">{t.columns.length}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>

        <main className="canvas">
          <ErdMarkers />
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onNodeMouseEnter={(_, node) => setHoveredId(node.id)}
            onNodeMouseLeave={() => setHoveredId(null)}
            onPaneClick={() => setSelectedId(null)}
            nodesConnectable={false}
            edgesFocusable={false}
            minZoom={0.05}
            maxZoom={2}
            panOnScroll
            selectionOnDrag={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false}>
              <button
                className="react-flow__controls-button"
                title="Re-run auto layout"
                onClick={layout}
              >
                ⟲
              </button>
            </Controls>
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => (n.id === activeId ? '#ff3621' : n.data.table.external ? '#c9d1d5' : '#1b3139')}
              nodeStrokeWidth={0}
            />
          </ReactFlow>

          {loading && <div className="overlay">Loading…</div>}
          {!loading && view && view.tables.length === 0 && (
            <div className="overlay">No tables found in this schema.</div>
          )}
          {!loading && !model && !error && source !== 'demo' && (
            <div className="overlay">Choose a {source === 'uc' ? 'catalog and schema' : 'schema'} to draw its ERD.</div>
          )}

          {selectedTable && (
            <TableDetails
              table={selectedTable}
              level={level}
              relationships={view.relationships}
              tablesById={tablesById}
              onSelect={focusTable}
              onClose={() => setSelectedId(null)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
