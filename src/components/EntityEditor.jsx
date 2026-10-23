import { useEffect, useMemo, useRef, useState } from 'react';
import { IDENT, proposedTableId, referenceTargets, upsertEntity, validateProposal } from '../lib/proposals.js';

// Suggested data types for the source the entity will be built in.
export const TYPES = {
  uc: ['STRING', 'BIGINT', 'INT', 'DECIMAL(18,2)', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'BINARY'],
  lakebase: ['text', 'varchar(255)', 'bigint', 'integer', 'numeric(18,2)', 'boolean', 'date', 'timestamptz', 'uuid', 'jsonb'],
};
TYPES.demo = TYPES.uc;

/** A starter entity for the canvas: a unique name and a primary key column. */
export function starterEntity(source, model) {
  const taken = new Set((model?.tables ?? []).map((t) => t.name.toLowerCase()));
  let name = 'new_entity';
  for (let i = 2; taken.has(name); i++) name = `new_entity_${i}`;
  return {
    name,
    comment: null,
    columns: [{ name: 'id', type: TYPES[source][source === 'lakebase' ? 2 : 1], pk: true, nullable: false, comment: null }],
  };
}

const blankColumn = () => ({ name: '', type: '', pk: false, required: false, comment: '', ref: '' });
const refKey = (r) => `${r.table}|${r.column}`;
// Self-references are keyed by this marker, so they survive renaming the entity.
const SELF = '__self__';

/**
 * Edits a proposed entity in the details panel: its name, description and
 * columns, with keys and references to existing or other proposed entities.
 * Changes go into the unsaved data model; saving the model stores them.
 * `isNew` means the entity was just placed on the canvas, so Cancel removes it.
 */
export default function EntityEditor({ source, scope, model, proposal, entity, isNew, onSave, onCancel }) {
  const [name, setName] = useState(entity.name);
  const [comment, setComment] = useState(entity.comment ?? '');
  const [rows, setRows] = useState(() =>
    entity.columns.map((c) => ({
      name: c.name,
      type: c.type,
      pk: c.pk,
      required: !c.nullable,
      comment: c.comment ?? '',
      ref: c.references
        ? refKey(c.references.table === proposedTableId(scope, entity.name) ? { ...c.references, table: SELF } : c.references)
        : '',
    })),
  );
  const [error, setError] = useState(null);
  const nameRef = useRef(null);

  useEffect(() => {
    nameRef.current?.focus();
    if (isNew) nameRef.current?.select();
  }, [isNew]);

  const oldId = proposedTableId(scope, entity.name);
  const validName = IDENT.test(name.trim());

  // Other tables' keys, plus this entity's own keys for self-references (e.g. parent_id).
  const targets = useMemo(() => {
    const list = referenceTargets(model, oldId);
    if (validName) {
      for (const r of rows.filter((r) => r.pk && IDENT.test(r.name.trim()))) {
        list.push({ table: SELF, tableName: `${name.trim()} (this entity)`, column: r.name.trim(), type: r.type, proposed: true, self: true });
      }
    }
    return list;
  }, [model, oldId, validName, name, rows]);
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
    const clash = model?.tables.find((t) => t.id !== oldId && !t.external && t.name.toLowerCase() === n.toLowerCase());
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
    const next = upsertEntity(proposal, scope, { name: n, comment: comment.trim() || null, columns }, entity.name);
    try {
      onSave(validateProposal(next), n);
    } catch (err) {
      setError(err.message);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') onCancel();
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
  };

  return (
    <div className="details entity-editor" onKeyDown={onKeyDown}>
      <div className="details__header">
        <div>
          <div className="details__title">
            {isNew ? 'New entity' : `Edit ${entity.name}`}
            <span className="tag proposed">proposed</span>
          </div>
          <div className="details__subtitle">in {scope} · save the data model to keep it</div>
        </div>
        <button className="icon-btn" onClick={onCancel} aria-label="Cancel">×</button>
      </div>

      <label className="field">
        <span>Table name</span>
        <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. service_request" />
      </label>
      <label className="field">
        <span>Description</span>
        <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What does each row represent?" />
      </label>

      <h4>Columns</h4>
      <datalist id="entity-types">
        {TYPES[source].map((t) => <option key={t} value={t} />)}
      </datalist>
      {rows.map((r, i) => (
        <div key={i} className="entity-col">
          <div className="entity-col__line">
            <input className="grow" value={r.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="column_name" aria-label="Column name" />
            <input className="type" list="entity-types" value={r.type} onChange={(e) => update(i, { type: e.target.value })} placeholder="type" aria-label="Data type" />
            <span className="row-actions">
              <button className="icon-btn" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button className="icon-btn" title="Move down" onClick={() => move(i, 1)} disabled={i === rows.length - 1}>↓</button>
              <button className="icon-btn" title="Remove column" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>×</button>
            </span>
          </div>
          <div className="entity-col__line">
            <label className="check" title="Primary key">
              <input type="checkbox" checked={r.pk} onChange={(e) => update(i, { pk: e.target.checked })} aria-label="Primary key" />
              PK
            </label>
            <label className="check" title="Value is required (NOT NULL)">
              <input
                type="checkbox"
                checked={r.pk || r.required}
                disabled={r.pk}
                onChange={(e) => update(i, { required: e.target.checked })}
                aria-label="Required"
              />
              Required
            </label>
            <select className="grow" value={r.ref} onChange={(e) => chooseRef(i, e.target.value)} aria-label="References" title="References">
              <option value="">No reference</option>
              {r.ref && !byKey.has(r.ref) && <option value={r.ref}>{r.ref.replace('|', '.')} (missing)</option>}
              {tableGroups.map(([label, cols]) => (
                <optgroup key={label} label={label}>
                  {cols.map((t) => (
                    <option key={refKey(t)} value={refKey(t)}>→ {t.tableName.replace(' (this entity)', '')}.{t.column}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <input className="entity-col__comment" value={r.comment} onChange={(e) => update(i, { comment: e.target.value })} placeholder="Description (optional)" aria-label="Column description" />
        </div>
      ))}
      <button className="btn small" onClick={() => setRows((rs) => [...rs, blankColumn()])}>+ Add column</button>

      {error && <div className="error inline">{error}</div>}
      <div className="entity-editor__footer">
        <span className="muted small">Ctrl+Enter saves · Esc cancels</span>
        <button className="btn small" onClick={onCancel}>{isNew ? 'Discard' : 'Cancel'}</button>
        <button className="btn small primary" disabled={!name.trim()} onClick={save}>{isNew ? 'Add to model' : 'Update entity'}</button>
      </div>
    </div>
  );
}
