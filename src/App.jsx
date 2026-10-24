import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  ConnectionMode,
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
import CodeMappingDialog from './components/CodeMappingDialog.jsx';
import MasterDataEditor from './components/MasterDataEditor.jsx';
import { starterEntity } from './components/EntityEditor.jsx';
import ModelPanel from './components/ModelPanel.jsx';
import DdlDialog from './components/DdlDialog.jsx';
import RelationshipEditor from './components/RelationshipEditor.jsx';
import ReferenceData from './pages/ReferenceData.jsx';
import Approvals from './pages/Approvals.jsx';
import Writeback from './pages/Writeback.jsx';
import UploadCsv from './pages/UploadCsv.jsx';
import { api, sourceTableName } from './lib/api.js';
import { NODE_WIDTH, buildGraph, nodeHeight } from './lib/layout.js';
import { LEVELS, deriveView } from './lib/modelLevels.js';
import {
  applyProposals,
  clearRelationship,
  emptyProposal,
  freeSpot,
  placeNodes,
  proposedTableId,
  removeEntity,
  upsertEntity,
  scopeName,
  setCardinality,
  validateProposal,
} from './lib/proposals.js';

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
  { id: 'writeback', label: 'Write-back' },
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
  const [mapped, setMapped] = useState([]);
  const [mappingsVersion, setMappingsVersion] = useState(0);
  const [dqScores, setDqScores] = useState(new Map());
  const [dqVersion, setDqVersion] = useState(0);
  const [notice, setNotice] = useState(null);
  // The data model: proposed entities for this schema, and the saved model they belong to.
  const [proposal, setProposal] = useState(emptyProposal);
  const [savedModel, setSavedModel] = useState(null);
  const [dirty, setDirty] = useState(false);
  // Node positions for the next layout: saved ones, or the current ones while editing.
  const nextPositions = useRef(null);
  // The proposed entity open in the panel editor: { name, isNew, before } (before = state to restore on discard).
  const [editing, setEditing] = useState(null);
  // Right-click menu on the canvas: { x, y } within the canvas, the flow position, and the node clicked, if any.
  const [menu, setMenu] = useState(null);
  // The relationship whose cardinality is being edited: { id, x, y } within the canvas.
  const [relEdit, setRelEdit] = useState(null);

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
    if (id === 'refdata' || id === 'approvals' || id === 'writeback') {
      return refdataAvailable ? null : 'Reference data and approvals need a Lakebase database connected to this app.';
    }
    return null;
  };

  const [outboxPending, setOutboxPending] = useState(0);
  const refreshPending = useCallback(() => {
    if (!refdataAvailable) return;
    api.pendingCount().then((r) => setPending(r.pending)).catch(() => {});
    api.outboxCounts().then((c) => setOutboxPending(c.pending ?? 0)).catch(() => {});
  }, [refdataAvailable]);

  useEffect(() => {
    if (!refdataAvailable) return;
    api.me().then(setMe).catch(() => {});
    refreshPending();
  }, [refdataAvailable, refreshPending]);

  const scope = scopeName(source, catalog, schema);
  const confirmDiscard = useCallback(
    () => !dirty || window.confirm('Discard your unsaved changes to the data model?'),
    [dirty],
  );
  const guarded = (fn) => (...args) => confirmDiscard() && fn(...args);

  // A data model belongs to one schema: start afresh when the schema changes.
  useEffect(() => {
    setProposal(emptyProposal());
    setSavedModel(null);
    setDirty(false);
    setEditing(null);
    setMenu(null);
    setRelEdit(null);
    nextPositions.current = null;
  }, [source, scope]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

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

  const merged = useMemo(() => applyProposals(model, { source, scope, proposal }), [model, source, scope, proposal]);
  const view = useMemo(() => deriveView(merged.model, level), [merged, level]);

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
    const known = nextPositions.current;
    nextPositions.current = null;
    setNodes(known ? placeNodes(graph.nodes, known.positions) : graph.nodes);
    setEdges(graph.edges);
    if (!known?.keepViewport) requestAnimationFrame(() => rf.fitView({ padding: 0.06, duration: 300 }));
  }, [view, columnMode, rf, setNodes]);

  const autoLayout = () => {
    nextPositions.current = null;
    layout();
    if (savedModel || proposal.tables.length) setDirty(true);
  };

  const currentPositions = () => Object.fromEntries(rf.getNodes().map((n) => [n.id, { ...n.position }]));
  const modelContent = () => ({
    tables: proposal.tables,
    positions: currentPositions(),
    relationships: proposal.relationships ?? [],
    cardinality: proposal.cardinality ?? {},
  });

  // Changes the proposed entities while keeping the diagram where it is.
  const editProposal = (next, positions = currentPositions()) => {
    nextPositions.current = { positions, keepViewport: true };
    setProposal(next);
    setDirty(true);
  };

  /**
   * Puts a starter entity on the canvas and opens it in the panel editor:
   * at `at` (a flow position, from the right-click menu), or in the free space
   * nearest the middle of the screen.
   */
  const startNewEntity = (at = null) => {
    const entity = starterEntity(source, merged.model);
    const id = proposedTableId(scope, entity.name);
    const size = { width: NODE_WIDTH, height: nodeHeight(level === 'conceptual' || columnMode === 'none' ? 0 : entity.columns.length) };
    const rects = rf.getNodes().map((n) => ({
      ...n.position,
      width: n.measured?.width ?? NODE_WIDTH,
      height: n.measured?.height ?? 200,
    }));
    let preferred = at;
    if (!preferred) {
      const box = canvasRef.current.getBoundingClientRect();
      const centre = rf.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      preferred = { x: centre.x - size.width / 2, y: centre.y - size.height / 2 };
    }
    const spot = freeSpot(rects, preferred, size, { gap: 16, step: 20 });
    showEditor(id, spot);
    setEditing({ name: entity.name, isNew: true, before: { proposal, dirty } });
    editProposal(upsertEntity(proposal, scope, entity), { ...currentPositions(), [id]: spot });
    setSelectedId(id);
  };

  // Brings the entity being edited to the middle of the screen at a readable zoom.
  const showEditor = (id, spot = null) =>
    requestAnimationFrame(() => {
      const node = rf.getNode(id);
      const p = spot ?? node?.position;
      if (!p) return;
      rf.setCenter(p.x + 200, p.y + 120, { zoom: Math.max(rf.getZoom(), 1), duration: 300 });
    });

  const editEntity = (name) => {
    setMenu(null);
    const id = proposedTableId(scope, name);
    setEditing({ name, isNew: false });
    setSelectedId(id);
    showEditor(id);
  };

  const saveEntity = (next, name) => {
    const previous = editing.name;
    const id = proposedTableId(scope, name);
    const positions = currentPositions();
    if (previous !== name) {
      const oldId = proposedTableId(scope, previous);
      positions[id] = positions[oldId];
      delete positions[oldId];
    }
    editProposal(next, positions);
    setEditing(null);
    setSelectedId(id);
  };

  // Discarding a just-placed entity takes it off the canvas again.
  const cancelEditing = () => {
    if (editing?.isNew) {
      nextPositions.current = { positions: currentPositions(), keepViewport: true };
      setProposal(editing.before.proposal);
      setDirty(editing.before.dirty);
      setSelectedId(null);
    }
    setEditing(null);
  };

  // Relationships drawn by dragging from one table (or column) to another.
  const handleColumn = (handle) => /^(.+)-(in|out)$/.exec(handle ?? '')?.[1] ?? null;
  const canvasPoint = (flow) => {
    const box = canvasRef.current.getBoundingClientRect();
    const p = rf.flowToScreenPosition(flow);
    return { x: Math.min(Math.max(p.x - box.left, 8), box.width - 340), y: Math.min(Math.max(p.y - box.top, 8), box.height - 260) };
  };
  const drawRelationship = ({ source: from, sourceHandle, target: to, targetHandle }) => {
    if (!from || !to) return;
    const id = `drawn:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const relationship = {
      id,
      from: { table: from, column: handleColumn(sourceHandle) },
      to: { table: to, column: handleColumn(targetHandle) },
      fromEnd: 'many',
      toEnd: 'one',
      phrase: null,
    };
    editProposal({ ...proposal, relationships: [...(proposal.relationships ?? []), relationship] });
    // Open the editor between the two tables so the cardinality can be set straight away.
    const a = rf.getNode(from);
    const b = rf.getNode(to);
    const mid = {
      x: ((a?.position.x ?? 0) + (b?.position.x ?? 0)) / 2 + NODE_WIDTH / 2,
      y: ((a?.position.y ?? 0) + (b?.position.y ?? 0)) / 2,
    };
    setRelEdit({ id, ...canvasPoint(mid) });
  };
  const editedRel = relEdit && view?.relationships.find((r) => r.id === relEdit.id);

  const removeProposed = (table) => {
    const referencedBy = proposal.tables.filter(
      (t) => t.name !== table.name && t.columns.some((c) => c.references?.table === table.id),
    );
    const also = referencedBy.length
      ? ` References to it from ${referencedBy.map((t) => t.name).join(', ')} will be removed too.`
      : '';
    if (!window.confirm(`Remove the proposed entity ${table.name} from the model?${also}`)) return;
    setSelectedId(null);
    setEditing(null);
    editProposal(removeEntity(proposal, scope, table.name));
  };

  const openModel = (row) => {
    setEditing(null);
    nextPositions.current = { positions: row.content.positions ?? {} };
    setProposal(validateProposal(row.content));
    setSavedModel(row);
    setDirty(false);
    setSelectedId(null);
  };

  const restoreVersion = (v) => {
    setEditing(null);
    nextPositions.current = { positions: v.content.positions ?? {} };
    setProposal(validateProposal(v.content));
    setDirty(true);
    setNotice(`Restored version ${v.version} of ${v.name}. Save to make it the current version.`);
  };

  const closeModel = () => {
    setEditing(null);
    nextPositions.current = null;
    setProposal(emptyProposal());
    setSavedModel(null);
    setDirty(false);
    setSelectedId(null);
  };

  useEffect(layout, [layout]);

  // Profiles belong to the loaded schema.
  useEffect(() => setProfiles(new Map()), [model]);

  // Data quality scores per table, for the diagram badges.
  const dqPrefix = source === 'uc' ? (catalog && schema ? `${catalog}.${schema}.` : null) : source === 'lakebase' && schema ? `${schema}.` : null;
  useEffect(() => {
    setDqScores(new Map());
    if (!model || !dqPrefix || !config?.sources.refdata?.available) return;
    api
      .dqSummary(source, dqPrefix)
      .then((rows) => setDqScores(new Map(rows.filter((r) => r.score !== null).map((r) => [r.source_table, r]))))
      .catch(() => {});
  }, [model, source, dqPrefix, config, dqVersion]);

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

  // The proposed entity being edited on the canvas, and what its node needs to be the form.
  const editedEntity = editing && proposal.tables.find((t) => t.name === editing.name);
  const editorFor = editedEntity
    ? {
        id: proposedTableId(scope, editedEntity.name),
        props: {
          source,
          scope,
          model: merged.model,
          proposal,
          entity: editedEntity,
          isNew: editing.isNew,
          onSave: saveEntity,
          onCancel: cancelEditing,
        },
      }
    : null;

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
        label: connected ? e.data.relationship.label : e.data.relationship.phrase || undefined,
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
        data: {
          ...n.data,
          highlightColumns: columnsByTable.get(n.id),
          categorical: categoricalByTable.get(n.id),
          pii: piiByTable.get(n.id),
          dq: dqScores.get(n.id),
          editor: n.id === editorFor?.id ? editorFor.props : undefined,
        },
        // The node being edited sits above its neighbours while it is larger.
        ...(n.id === editorFor?.id ? { zIndex: 1000, className: 'editing' } : {}),
      };
    });

    return { displayNodes, displayEdges };
  }, [nodes, edges, activeId, selectedId, query, categoricalByTable, piiByTable, dqScores, editorFor]);

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
    setMapped([]);
    if (!selectedTable || !refdataAvailable || source === 'demo' || selectedTable.external || selectedTable.proposed) return;
    const name = sourceTableName(source, selectedTable);
    api.linkedCodeSets(source, name).then(setLinked).catch(() => {});
    api.sourceMappings(source, name).then(setMapped).catch(() => {});
  }, [selectedTable, refdataAvailable, source, mappingsVersion]);

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
                {p.id === 'writeback' && outboxPending > 0 && <span className="badge muted-badge">{outboxPending}</span>}
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

      {page === 'refdata' && <ReferenceData me={me} onChanged={refreshPending} />}
      {page === 'approvals' && <Approvals me={me} onChanged={refreshPending} />}
      {page === 'writeback' && <Writeback me={me} onChanged={refreshPending} />}
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
                    onClick={guarded(() => setSource(s.id))}
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
              <select id="catalog" value={catalog} onChange={guarded((e) => setCatalog(e.target.value))}>
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
                onChange={guarded((e) => setSchema(e.target.value))}
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
              <select id="pg-schema" value={schema} onChange={guarded((e) => setSchema(e.target.value))}>
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

          {model && scope && (
            <ModelPanel
              source={source}
              scope={scope}
              canSave={refdataAvailable}
              me={me}
              saved={savedModel}
              dirty={dirty}
              entityCount={proposal.tables.length}
              getContent={modelContent}
              onOpen={openModel}
              onSaved={(row) => {
                setSavedModel(row);
                setDirty(false);
                setNotice(`Saved ${row.name} (version ${row.version}).`);
              }}
              onRestore={restoreVersion}
              onClose={closeModel}
              onAddEntity={() => (editing ? setNotice('Finish or cancel the entity you are editing first.') : startNewEntity())}
              onGenerateDdl={() => setDialog({ type: 'ddl', only: null })}
              confirmDiscard={confirmDiscard}
            />
          )}
          {merged.built.length > 0 && (
            <div className="notice warn small">
              Now built in the schema, so the real table is shown instead: {merged.built.join(', ')}.{' '}
              <button
                className="link"
                onClick={() => editProposal(merged.built.reduce((p, name) => removeEntity(p, scope, name, { keepReferences: true }), proposal))}
              >
                Remove the proposal{merged.built.length === 1 ? '' : 's'} from the model
              </button>
            </div>
          )}
          {merged.broken.length > 0 && (
            <div className="notice warn small">
              Some references point at tables that are no longer in the schema: {merged.broken.join('; ')}.
            </div>
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
                      <span>
                        {t.label}
                        {t.proposed && <span className="tag proposed">proposed</span>}
                      </span>
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
            onNodesChange={(changes) => {
              onNodesChange(changes);
              if ((savedModel || proposal.tables.length) && changes.some((c) => c.type === 'position' && c.dragging === false)) {
                setDirty(true);
              }
            }}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onNodeDoubleClick={(_, node) => node.data.table.proposed && !editing && editEntity(node.data.table.name)}
            deleteKeyCode={null}
            onNodeMouseEnter={(_, node) => setHoveredId(node.id)}
            onNodeMouseLeave={() => setHoveredId(null)}
            onPaneClick={() => {
              setMenu(null);
              setRelEdit(null);
              if (!editing) setSelectedId(null);
            }}
            onEdgeClick={(e, edge) => {
              if (!model || !scope) return;
              const box = canvasRef.current.getBoundingClientRect();
              setMenu(null);
              setRelEdit({
                id: edge.id,
                x: Math.min(e.clientX - box.left + 8, box.width - 340),
                y: Math.min(e.clientY - box.top + 8, box.height - 260),
              });
            }}
            onConnect={drawRelationship}
            onPaneContextMenu={(e) => {
              if (!model || !scope) return;
              e.preventDefault();
              const box = canvasRef.current.getBoundingClientRect();
              setMenu({ x: e.clientX - box.left, y: e.clientY - box.top, flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
            }}
            onNodeContextMenu={(e, node) => {
              if (!node.data.table.proposed) return;
              e.preventDefault();
              const box = canvasRef.current.getBoundingClientRect();
              setMenu({ x: e.clientX - box.left, y: e.clientY - box.top, node: node.data.table });
            }}
            onMoveStart={() => setMenu(null)}
            nodesConnectable={Boolean(model && scope) && !editing}
            connectionMode={ConnectionMode.Loose}
            connectionLineStyle={{ stroke: '#6941c6', strokeWidth: 2, strokeDasharray: '5 4' }}
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
                onClick={autoLayout}
              >
                ⟲
              </button>
            </Controls>
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => (n.id === activeId ? '#ff3621' : n.data.table.proposed ? '#6941c6' : n.data.table.external ? '#c9d1d5' : '#1b3139')}
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

          {menu && (
            <div className="context-menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
              {menu.node ? (
                <>
                  <button disabled={Boolean(editing)} onClick={() => editEntity(menu.node.name)}>Edit {menu.node.name}</button>
                  <button
                    disabled={Boolean(editing)}
                    onClick={() => {
                      setMenu(null);
                      removeProposed(menu.node);
                    }}
                  >
                    Remove from model
                  </button>
                </>
              ) : (
                <button
                  disabled={Boolean(editing)}
                  title={editing ? 'Finish or cancel the entity you are editing first' : undefined}
                  onClick={() => {
                    setMenu(null);
                    startNewEntity(menu.flow);
                  }}
                >
                  Propose new entity here
                </button>
              )}
            </div>
          )}

          {editedRel && (
            <RelationshipEditor
              rel={editedRel}
              fromLabel={tablesById.get(editedRel.from.table)?.label ?? editedRel.from.table}
              toLabel={tablesById.get(editedRel.to.table)?.label ?? editedRel.to.table}
              position={relEdit}
              onChange={(ends) => editProposal(setCardinality(proposal, editedRel, ends))}
              onClear={() => {
                editProposal(clearRelationship(proposal, editedRel));
                if (editedRel.drawn) setRelEdit(null);
              }}
              onClose={() => setRelEdit(null)}
            />
          )}

          {selectedTable && !editing && (
            <TableDetails
              table={selectedTable}
              level={level}
              relationships={view.relationships}
              tablesById={tablesById}
              onSelect={focusTable}
              onClose={() => setSelectedId(null)}
              profile={profiles.get(selectedTable.id)}
              canProfile={canProfile && !selectedTable.external && !selectedTable.proposed}
              onProfile={() => profileOne(selectedTable)}
              linked={linked}
              mapped={mapped}
              onEditEntity={selectedTable.proposed ? () => editEntity(selectedTable.name) : null}
              onRemoveEntity={selectedTable.proposed ? () => removeProposed(selectedTable) : null}
              onShowDdl={selectedTable.proposed ? () => setDialog({ type: 'ddl', only: [selectedTable.id], title: `DDL for ${selectedTable.name}` }) : null}
              onCreateCodeSet={refdataAvailable ? (column) => setDialog({ type: 'codeSet', table: selectedTable, column }) : null}
              onMapCodes={refdataAvailable ? (column) => setDialog({ type: 'mapping', table: selectedTable, column }) : null}
              dqSource={refdataAvailable && canProfile ? source : null}
              onDqChanged={() => setDqVersion((v) => v + 1)}
              onChangeSubmitted={submitted}
              onEditData={
                refdataAvailable && source === 'lakebase' && !selectedTable.external && !selectedTable.proposed
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
      {dialog?.type === 'mapping' && (
        <CodeMappingDialog
          source={source}
          table={dialog.table}
          column={dialog.column}
          onClose={() => {
            setDialog(null);
            setMappingsVersion((v) => v + 1);
          }}
          onSubmitted={submitted}
        />
      )}
      {dialog?.type === 'ddl' && (
        <DdlDialog
          source={source}
          scope={scope}
          model={merged.model}
          saved={savedModel}
          only={dialog.only}
          title={dialog.title}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'masterData' && (
        <MasterDataEditor table={dialog.table} onClose={() => setDialog(null)} onSubmitted={submitted} />
      )}
    </div>
  );
}
