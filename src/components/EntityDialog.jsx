import { useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { IDENT, proposedTableId, referenceTargets, upsertEntity, validateProposal } from '../lib/proposals.js';

// Suggested data types for the source the entity will be built in.
const TYPES = {
  uc: ['STRING', 'BIGINT', 'INT', 'DECIMAL(18,2)', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'BINARY'],
  lakebase: ['text', 'varchar(255)', 'bigint', 'integer', 'numeric(18,2)', 'boolean', 'date', 'timestamptz', 'uuid', 'jsonb'],
};
TYPES.demo = TYPES.uc;

const blankColumn = () => ({ name: '', type: '', pk: false, required: false, comment: '', ref: '' });
const refKey = (r) => `${r.table}|${r.column}`;
// Self-references are keyed by this marker, so they survive renaming the entity.
const SELF = '__self__';

/**
 * Adds or edits a proposed entity: its name, description and columns, with
 * keys and references to existing or other proposed entities. Changes go
 * into the unsaved data model; saving the model stores them.
 */
export default function EntityDialog({ source, scope, model, proposal, entity, onSave, onClose }) {
  const editing = Boolean(entity);
  const [name, setName] = useState(entity?.name ?? '');
  const [comment, setComment] = useState(entity?.comment ?? '');
  const [rows, setRows] = useState(() =>
    entity
      ? entity.columns.map((c) => ({
          name: c.name,
          type: c.type,
          pk: c.pk,
          required: !c.nullable,
          comment: c.comment ?? '',
          ref: c.references
            ? refKey(c.references.table === proposedTableId(scope, entity.name) ? { ...c.references, table: SELF } : c.references)
            : '',
        }))
      : [{ ...blankColumn(), name: 'id', type: TYPES[source][source === 'lakebase' ? 2 : 1], pk: true, required: true }],
  );
  const [error, setError] = useState(null);

  const oldId = editing ? proposedTableId(scope, entity.name) : null;
  const newId = IDENT.test(name.trim()) ? proposedTableId(scope, name.trim()) : null;

  // Other tables' keys, plus this entity's own keys for self-references (e.g. parent_id).
  const targets = useMemo(() => {
    const list = referenceTargets(model, oldId);
    if (newId) {
      for (const r of rows.filter((r) => r.pk && IDENT.test(r.name.trim()))) {
        list.push({ table: SELF, tableName: `${name.trim()} (this entity)`, column: r.name.trim(), type: r.type, proposed: true, self: true });
      }
    }
    return list;
  }, [model, oldId, newId, name, rows]);
  const byKey = new Map(targets.map((t) => [refKey(t), t]));
  const tableGroups = useMemo(() => {
    const groups = new Map();
    for (const t of targets) {
      const label = t.self ? t.tableName : `${t.tableName}${t.proposed ? ' (proposed)' : ''}`;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(t);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  }, [targets]);

  const update = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i, d) =>
    setRows((rs) => {
      const j = i + d;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const chooseRef = (i, key) => {
    const target = byKey.get(key);
    const row = rows[i];
    const patch = { ref: key };
    // Fill in the obvious name and type for a new reference column.
    if (target && !row.name.trim()) patch.name = target.column;
    if (target && !row.type.trim()) patch.type = target.type;
    update(i, patch);
  };

  const save = () => {
    setError(null);
    const n = name.trim();
    const clash = model?.tables.find(
      (t) => t.id !== oldId && !t.external && t.name.toLowerCase() === n.toLowerCase(),
    );
    if (clash) {
      setError(`${clash.proposed ? 'A proposed entity' : 'A table'} called ${clash.name} already exists in this schema.`);
      return;
    }
    const columns = rows
      .filter((r) => r.name.trim() || r.type.trim() || r.ref)
      .map((r) => {
        const target = r.ref ? byKey.get(r.ref) : null;
        return {
          name: r.name.trim(),
          type: r.type.trim(),
          pk: r.pk,
          nullable: !(r.pk || r.required),
          comment: r.comment.trim() || null,
          references: target ? { table: target.table === SELF ? proposedTableId(scope, n) : target.table, column: target.column } : undefined,
        };
      });
    const next = upsertEntity(proposal, scope, { name: n, comment: comment.trim() || null, columns }, entity?.name ?? null);
    try {
      onSave(validateProposal(next), n);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Modal
      title={editing ? `Edit proposed entity ${entity.name}` : 'Propose a new entity'}
      subtitle={`In ${scope}. It is added to the diagram as a proposal; save the data model to keep it.`}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">{rows.length} column{rows.length === 1 ? '' : 's'}</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()} onClick={save}>
            {editing ? 'Update entity' : 'Add to model'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label className="field">
          <span>Table name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. service_request" autoFocus />
        </label>
        <label className="field grow">
          <span>Description</span>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What does each row represent?" />
        </label>
      </div>
      {error && <div className="error inline">{error}</div>}
      <datalist id="entity-types">
        {TYPES[source].map((t) => <option key={t} value={t} />)}
      </datalist>
      <table className="grid entity-grid">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th title="Primary key">PK</th>
            <th title="Value is required (NOT NULL)">Required</th>
            <th>References</th>
            <th>Description</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><input value={r.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="column_name" /></td>
              <td><input list="entity-types" value={r.type} onChange={(e) => update(i, { type: e.target.value })} placeholder="type" /></td>
              <td><input type="checkbox" checked={r.pk} onChange={(e) => update(i, { pk: e.target.checked })} aria-label="Primary key" /></td>
              <td>
                <input
                  type="checkbox"
                  checked={r.pk || r.required}
                  disabled={r.pk}
                  onChange={(e) => update(i, { required: e.target.checked })}
                  aria-label="Required"
                />
              </td>
              <td>
                <select value={r.ref} onChange={(e) => chooseRef(i, e.target.value)}>
                  <option value="">—</option>
                  {r.ref && !byKey.has(r.ref) && <option value={r.ref}>{r.ref.replace('|', '.')} (missing)</option>}
                  {tableGroups.map(([label, cols]) => (
                    <optgroup key={label} label={label}>
                      {cols.map((t) => (
                        <option key={refKey(t)} value={refKey(t)}>{t.tableName.replace(' (this entity)', '')}.{t.column}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </td>
              <td><input value={r.comment} onChange={(e) => update(i, { comment: e.target.value })} /></td>
              <td className="row-actions">
                <button className="icon-btn" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button className="icon-btn" title="Move down" onClick={() => move(i, 1)} disabled={i === rows.length - 1}>↓</button>
                <button className="icon-btn" title="Remove column" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn small" onClick={() => setRows((rs) => [...rs, blankColumn()])}>+ Add column</button>
    </Modal>
  );
}
