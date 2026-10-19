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
import CodeSetDialog from './components/CodeSetDialog.jsx';
import MasterDataEditor from './components/MasterDataEditor.jsx';
import ReferenceData from './pages/ReferenceData.jsx';
import Approvals from './pages/Approvals.jsx';
import UploadCsv from './pages/UploadCsv.jsx';
import { api, sourceTableName } from './lib/api.js';
import { buildGraph } from './lib/layout.js';
import { LEVELS, deriveView } from './lib/modelLevels.js';

const nodeTypes = { table: TableNode };

const SOURCES = [
  { id: 'uc', label: 'Unity Catalog' },
  { id: 'lakebase', label: 'Lakebase' },
  { id: 'demo', label: 'Demo' },
];

const PAGES = [
  { id: 'diagram', label: 'Diagram' },
  { id: 'refdata', label: 'Reference data' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'upload', label: 'Upload CSV' },
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
  const canvasRef = useRef(null);
  const defaults = useRef({});
  const [page, setPage] = useState('diagram');
  const [me, setMe] = useState(null);
  const [pending, setPending] = useState(0);
  const [profiles, setProfiles] = useState(() => new Map());
  const [profiling, setProfiling] = useState(null); // { done, total } while profiling a schema
  const [dialog, setDialog] = useState(null);
  const [linked, setLinked] = useState([]);
  const [notice, setNotice] = useState(null);

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

  const refdataAvailable = Boolean(config?.sources.refdata?.available);
  const ingestAvailable = Boolean(config?.sources.ingest?.available);
  // Why a page can't be used here, shown on its greyed-out tab; null when available.
  const unavailable = (id) => {
    if (id === 'upload') {
      return ingestAvailable ? null : 'Uploading CSV files needs Unity Catalog and a SQL warehouse connected to this app.';
    }
    if (id === 'refdata' || id === 'approvals') {
      return refdataAvailable ? null : 'Reference data and approvals need a Lakebase database connected to this app.';
    }
    return null;
  };

  const refreshPending = useCallback(() => {
    if (!refdataAvailable) return;
    api.pendingCount().then((r) => setPending(r.pending)).catch(() => {});
  }, [refdataAvailable]);

  useEffect(() => {
    if (!refdataAvailable) return;
    api.me().then(setMe).catch(() => {});
    refreshPending();
  }, [refdataAvailable, refreshPending]);

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
    const box = canvasRef.current?.getBoundingClientRect();
    const graph = buildGraph(view, {
      columnMode,
      viewport: box && { width: box.width, height: box.height },
    });
    setNodes(graph.nodes);
    setEdges(graph.edges);
    requestAnimationFrame(() => rf.fitView({ padding: 0.15, duration: 300 }));
  }, [view, columnMode, rf, setNodes]);

  useEffect(layout, [layout]);

  // Profiles belong to the loaded schema.
  useEffect(() => setProfiles(new Map()), [model]);

  const canProfile = source === 'lakebase' || (source === 'uc' && Boolean(config?.sources.warehouse?.available));

  const profileOne = useCallback(
    async (table) => {
      const result = await api.profile(source, table);
      setProfiles((m) => new Map(m).set(table.id, result));
      return result;
    },
    [source],
  );

  const profileAll = useCallback(async () => {
    const tables = (model?.tables ?? []).filter((t) => !t.external);
    setProfiling({ done: 0, total: tables.length });
    setError(null);
    const queue = [...tables];
    const failures = [];
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        try {
          await profileOne(t);
        } catch (err) {
          failures.push(`${t.name}: ${err.message}`);
        }
        setProfiling((p) => p && { ...p, done: p.done + 1 });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setProfiling(null);
    if (failures.length) setError(`Profiling failed for ${failures.length} table(s). ${failures[0]}`);
  }, [model, profileOne]);

  const categoricalCount = useMemo(
    () => [...profiles.values()].reduce((n, p) => n + p.columns.filter((c) => c.categorical).length, 0),
    [profiles],
  );
  const piiCount = useMemo(
    () => [...profiles.values()].reduce((n, p) => n + p.columns.filter((c) => c.pii).length, 0),
    [profiles],
  );

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

  const categoricalByTable = useMemo(
    () =>
      new Map(
        [...profiles].map(([id, p]) => [id, new Set(p.columns.filter((c) => c.categorical).map((c) => c.name))]),
      ),
    [profiles],
  );
  const piiByTable = useMemo(
    () => new Map([...profiles].map(([id, p]) => [id, new Map(p.columns.filter((c) => c.pii).map((c) => [c.name, c.pii]))])),
    [profiles],
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
        data: { ...n.data, highlightColumns: columnsByTable.get(n.id), categorical: categoricalByTable.get(n.id), pii: piiByTable.get(n.id) },
      };
    });

    return { displayNodes, displayEdges };
  }, [nodes, edges, activeId, selectedId, query, categoricalByTable, piiByTable]);

  const filteredTables = useMemo(
    () =>
      (view?.tables ?? [])
        .filter((t) => !query || matchesQuery(t, query))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [view, query],
  );

  const selectedTable = selectedId ? tablesById.get(selectedId) : null;

  // Code sets already created from the selected table's columns.
  useEffect(() => {
    setLinked([]);
    if (!selectedTable || !refdataAvailable || source === 'demo' || selectedTable.external) return;
    api.linkedCodeSets(source, sourceTableName(source, selectedTable)).then(setLinked).catch(() => {});
  }, [selectedTable, refdataAvailable, source]);

  const submitted = (change) => {
    setNotice(`Submitted for approval: ${change.summary}`);
    refreshPending();
  };
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
        {config && (
          <nav className="tabs">
            {PAGES.map((p) => (
              <button
                key={p.id}
                className={page === p.id ? 'active' : ''}
                aria-disabled={Boolean(unavailable(p.id))}
                title={unavailable(p.id) ?? undefined}
                onClick={() => !unavailable(p.id) && setPage(p.id)}
              >
                {p.label}
                {p.id === 'approvals' && pending > 0 && <span className="badge">{pending}</span>}
              </button>
            ))}
          </nav>
        )}
        {(me?.user || config?.user) && (
          <div className="user">
            {me?.user ?? config.user}
            {me?.isSteward && <span className="tag steward">steward</span>}
          </div>
        )}
      </header>

      {page === 'refdata' && <ReferenceData onChanged={refreshPending} />}
      {page === 'approvals' && <Approvals me={me} onChanged={refreshPending} />}
      {page === 'upload' && <UploadCsv config={config} />}

      <div className="body" hidden={page !== 'diagram'}>
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
              {config?.sources.uc.identity && (
                <div className="conn muted">Querying as {config.sources.uc.identity}</div>
              )}
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

          {model && source !== 'demo' && (
            <section>
              <label className="label">Data</label>
              <button className="btn block" disabled={!canProfile || Boolean(profiling)} onClick={profileAll}>
                {profiling ? `Profiling ${profiling.done}/${profiling.total} tables…` : 'Profile data'}
              </button>
              {!canProfile && (
                <div className="muted small" style={{ marginTop: 6 }}>
                  Profiling Unity Catalog tables needs a SQL warehouse. In Databricks, open this app → Edit → App
                  resources → add a SQL warehouse (Can use), then reload.
                </div>
              )}
              {canProfile && profiles.size === 0 && !profiling && (
                <div className="muted small" style={{ marginTop: 6 }}>Finds categorical fields and personal data (PII).</div>
              )}
              {canProfile && source === 'uc' && config?.sources.warehouse?.name && (
                <div className="muted small" style={{ marginTop: 6 }}>Using warehouse {config.sources.warehouse.name}</div>
              )}
              {profiles.size > 0 && !profiling && (
                <div className="muted small" style={{ marginTop: 6 }}>
                  {profiles.size} table{profiles.size === 1 ? '' : 's'} profiled: {categoricalCount} categorical{' '}
                  <span className="key cat">CAT</span> · {piiCount} personal data <span className="key pii">PII</span>
                </div>
              )}
            </section>
          )}

          {error && <div className="error">{error}</div>}
          {notice && (
            <div className="notice" onClick={() => setNotice(null)}>
              {notice}
            </div>
          )}

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

        <main className="canvas" ref={canvasRef}>
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
              profile={profiles.get(selectedTable.id)}
              canProfile={canProfile && !selectedTable.external}
              onProfile={() => profileOne(selectedTable)}
              linked={linked}
              onCreateCodeSet={refdataAvailable ? (column) => setDialog({ type: 'codeSet', table: selectedTable, column }) : null}
              onEditData={
                refdataAvailable && source === 'lakebase' && !selectedTable.external
                  ? () => setDialog({ type: 'masterData', table: selectedTable })
                  : null
              }
            />
          )}
        </main>
      </div>

      {dialog?.type === 'codeSet' && (
        <CodeSetDialog
          source={source}
          table={dialog.table}
          column={dialog.column}
          onClose={() => setDialog(null)}
          onSubmitted={submitted}
        />
      )}
      {dialog?.type === 'masterData' && (
        <MasterDataEditor table={dialog.table} onClose={() => setDialog(null)} onSubmitted={submitted} />
      )}
    </div>
  );
}
