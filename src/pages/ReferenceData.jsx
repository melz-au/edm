import { useCallback, useEffect, useState } from 'react';
import Modal from '../components/Modal.jsx';
import CodeSetDialog from '../components/CodeSetDialog.jsx';
import ChangeDiff from '../components/ChangeDiff.jsx';
import { api } from '../lib/api.js';
import { showRaw } from '../components/CodeMappingDialog.jsx';

function MappingsTab({ set, mappings, onSubmitted, onError }) {
  const [selected, setSelected] = useState(new Set());
  const groups = new Map();
  for (const m of mappings) {
    const key = `${m.source_system}|${m.source_table}|${m.source_column}`;
    if (!groups.has(key)) groups.set(key, { system: m.source_system, table: m.source_table, column: m.source_column, rows: [] });
    groups.get(key).rows.push(m);
  }

  const remove = async (group) => {
    const values = group.rows.filter((r) => selected.has(r.id)).map((r) => r.source_value);
    try {
      onSubmitted(
        await api.proposeChange({
          kind: 'code_mapping',
          action: 'delete',
          target: { codeSetId: set.id, source: { system: group.system, table: group.table, column: group.column } },
          payload: { values },
        }),
      );
      setSelected(new Set());
    } catch (err) {
      onError(err.message);
    }
  };

  if (!mappings.length) {
    return (
      <p className="muted">
        No source values are mapped to {set.name} yet. In the Diagram, open a table from another system, profile it, and use{' '}
        <strong>Map to code set</strong> on a categorical field.
      </p>
    );
  }

  return (
    <>
      {[...groups.values()].map((g) => {
        const chosen = g.rows.filter((r) => selected.has(r.id)).length;
        return (
          <div key={`${g.system}|${g.table}|${g.column}`} className="mapping-group">
            <div className="page__header">
              <div>
                <strong>{g.table}.{g.column}</strong> <span className="muted small">({g.system}) · {g.rows.length} values</span>
              </div>
              <button className="btn small danger" disabled={!chosen} onClick={() => remove(g)}>
                Propose removal{chosen ? ` of ${chosen}` : ''}
              </button>
            </div>
            <table className="grid">
              <thead>
                <tr><th style={{ width: 32 }} /><th>Source value</th><th>Maps to</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          e.target.checked ? next.add(r.id) : next.delete(r.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td>{showRaw(r.source_value)}</td>
                    <td>{r.code_value_id === null ? <span className="muted">∅ treat as missing</span> : <><code>{r.code}</code> {r.label && r.label !== r.code && <span className="muted">{r.label}</span>}</>}</td>
                    <td className="muted small">{new Date(r.updated_at).toLocaleDateString()} · {r.updated_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <div className="sql-box">
        <strong>Use in a pipeline</strong>: join raw values to the mapping view (in Lakebase, or sync it to Unity Catalog):
        <pre>{`SELECT src.*, m.code AS ${set.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}
FROM <source table> src
LEFT JOIN refdata.code_mapping_v m
  ON  m.code_set = '${set.name.replace(/'/g, "''")}'
  AND m.source_table = '<schema.table>' AND m.source_column = '<column>'
  AND m.source_value = src.<column>;
-- m.code IS NULL AND m.maps_to_missing  → deliberately mapped to missing
-- m.source_value IS NULL               → value not mapped yet`}</pre>
      </div>
    </>
  );
}

function ValueDialog({ set, value, onClose, onSubmitted }) {
  const creating = !value;
  const [form, setForm] = useState({
    code: value?.code ?? '',
    label: value?.label ?? '',
    description: value?.description ?? '',
    sort_order: value?.sort_order ?? '',
  });
  const [comment, setComment] = useState('');
  const [error, setError] = useState(null);

  const submit = async () => {
    setError(null);
    const clean = Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, v === '' ? null : k === 'sort_order' ? Number(v) : v]),
    );
    const payload = creating
      ? clean
      : Object.fromEntries(Object.entries(clean).filter(([k, v]) => k !== 'code' && String(v ?? '') !== String(value[k] ?? '')));
    try {
      const change = await api.proposeChange({
        kind: 'code_value',
        action: creating ? 'create' : 'update',
        target: { codeSetId: set.id, ...(creating ? {} : { codeValueId: value.id }) },
        payload,
        comment,
      });
      onSubmitted(change);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };

  const field = (name, label, props = {}) => (
    <label className="field">
      <span>{label}</span>
      <input value={form[name]} onChange={(e) => setForm({ ...form, [name]: e.target.value })} {...props} />
    </label>
  );

  return (
    <Modal
      title={creating ? `Add code to ${set.name}` : `Edit ${value.code}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit}>Submit for approval</button>
        </>
      }
    >
      {field('code', 'Code', { disabled: !creating })}
      {field('label', 'Label')}
      {field('description', 'Description')}
      {field('sort_order', 'Sort order', { type: 'number' })}
      <label className="field">
        <span>Comment for the reviewer</span>
        <input value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      {error && <div className="error inline">{error}</div>}
    </Modal>
  );
}

export default function ReferenceData({ onChanged }) {
  const [sets, setSets] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [pending, setPending] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState('codes');
  const [mappings, setMappings] = useState([]);

  const loadSets = useCallback(() => {
    api
      .codeSets()
      .then((list) => {
        setSets(list);
        setSelectedId((id) => id ?? list[0]?.id ?? null);
      })
      .catch((err) => setError(err.message));
  }, []);

  const loadDetail = useCallback(() => {
    if (!selectedId) return setDetail(null);
    api.codeSet(selectedId).then(setDetail).catch((err) => setError(err.message));
    api.mappings(selectedId).then(setMappings).catch(() => setMappings([]));
    api
      .changes({ status: 'pending' })
      .then((list) => setPending(list.filter((c) => Number(c.target.codeSetId) === selectedId)))
      .catch(() => {});
  }, [selectedId]);

  useEffect(loadSets, [loadSets]);
  useEffect(loadDetail, [loadDetail]);

  const submitted = (change) => {
    setNotice(`Submitted for approval: ${change.summary}`);
    loadSets();
    loadDetail();
    onChanged?.();
  };

  const toggleActive = async (value) => {
    try {
      submitted(
        await api.proposeChange({
          kind: 'code_value',
          action: 'update',
          target: { codeSetId: detail.id, codeValueId: value.id },
          payload: { active: !value.active },
        }),
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const pendingFor = (valueId) => pending.filter((c) => Number(c.target.codeValueId) === valueId);
  const shown = (sets ?? []).filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page split">
      <aside className="page__list">
        <div className="toolbar">
          <input type="search" placeholder="Search code sets…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button className="btn primary block" onClick={() => setDialog({ type: 'set' })}>+ New code set</button>
        {sets && !sets.length && (
          <p className="muted small">
            No code sets yet. Create one here, or profile a table in the diagram and turn a categorical field into a code set.
          </p>
        )}
        <ul>
          {shown.map((s) => (
            <li key={s.id}>
              <button className={s.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(s.id)}>
                <span>{s.name}</span>
                <span className="muted">
                  {s.active_count}
                  {s.pending_count > 0 && <span className="dot" title={`${s.pending_count} pending`} />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="page__main">
        {error && <div className="error inline">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        {detail ? (
          <>
            <div className="page__header">
              <div>
                <h2>{detail.name}</h2>
                {detail.description && <p className="muted">{detail.description}</p>}
                {detail.source_table && (
                  <p className="muted small">
                    Source: {detail.source_system} · {detail.source_table}.{detail.source_column}
                  </p>
                )}
                <p className="muted small">
                  Updated {new Date(detail.updated_at).toLocaleString()} by {detail.updated_by}
                </p>
              </div>
              <button className="btn primary" onClick={() => setDialog({ type: 'value' })}>+ Add code</button>
            </div>

            {pending.length > 0 && (
              <details className="pending-box">
                <summary>{pending.length} change{pending.length === 1 ? '' : 's'} awaiting approval</summary>
                {pending.map((c) => (
                  <div key={c.id} className="pending-item">
                    <div><strong>{c.summary}</strong> <span className="muted">by {c.requested_by}</span></div>
                    <ChangeDiff change={c} />
                  </div>
                ))}
              </details>
            )}

            <div className="page-tabs">
              <button className={tab === 'codes' ? 'active' : ''} onClick={() => setTab('codes')}>
                Codes ({detail.values.length})
              </button>
              <button className={tab === 'mappings' ? 'active' : ''} onClick={() => setTab('mappings')}>
                Source mappings ({mappings.length})
              </button>
            </div>

            {tab === 'mappings' ? (
              <MappingsTab set={detail} mappings={mappings} onSubmitted={submitted} onError={setError} />
            ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Label</th>
                  <th>Description</th>
                  <th className="num">Order</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {detail.values.map((v) => (
                  <tr key={v.id} className={`${v.active ? '' : 'inactive'}${pendingFor(v.id).length ? ' pending' : ''}`}>
                    <td><code>{v.code}</code></td>
                    <td>{v.label}</td>
                    <td>{v.description}</td>
                    <td className="num">{v.sort_order}</td>
                    <td>
                      {v.active ? <span className="tag ok">Active</span> : <span className="tag">Inactive</span>}
                      {pendingFor(v.id).length > 0 && <span className="tag warn">Pending</span>}
                    </td>
                    <td className="actions">
                      <button className="btn small" onClick={() => setDialog({ type: 'value', value: v })}>Edit</button>
                      <button className="btn small" onClick={() => toggleActive(v)}>
                        {v.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </>
        ) : (
          sets?.length > 0 && <p className="muted">Select a code set.</p>
        )}
      </section>

      {dialog?.type === 'set' && <CodeSetDialog onClose={() => setDialog(null)} onSubmitted={submitted} />}
      {dialog?.type === 'value' && detail && (
        <ValueDialog set={detail} value={dialog.value} onClose={() => setDialog(null)} onSubmitted={submitted} />
      )}
    </div>
  );
}
