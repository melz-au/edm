import { useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { IDENT, proposedTableId, referenceTargets, upsertEntity, validateProposal } from '../lib/proposals.js';
import { TABLE_HANDLE_BOTTOM, TABLE_HANDLE_IN, TABLE_HANDLE_OUT, TABLE_HANDLE_TOP } from '../lib/layout.js';

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

const blankColumn = () => ({ name: '', type: '', pk: false, required: false, comment: '', ref: '', orig: null, showComment: false });
const refKey = (r) => `${r.table}|${r.column}`;
// Self-references are keyed by this marker, so they survive renaming the entity.
const SELF = '__self__';
// React Flow: don't start a node drag, a pan or a zoom from form controls.
const NO_FLOW = 'nodrag nopan nowheel';

/**
 * A proposed entity being edited in place on the diagram: the node itself
 * becomes the form (name, description, and each column's name, type, key,
 * required flag, reference and description). Changes go into the unsaved
 * data model when Done is pressed; saving the model stores them.
 * `isNew` means the entity was just placed on the canvas, so Discard removes it.
 */
export default function EntityEditor({ source, scope, model, proposal, entity, isNew, onSave, onCancel }) {
  const [name, setName] = useState(entity.name);
  const [comment, setComment] = useState(entity.comment ?? '');
  const [rows, setRows] = useState(() =>
    entity.columns.map((c) => ({
      name: c.name,
      orig: c.name,
      type: c.type,
      pk: c.pk,
      required: !c.nullable,
      comment: c.comment ?? '',
      showComment: Boolean(c.comment),
      ref: c.references
        ? refKey(c.references.table === proposedTableId(scope, entity.name) ? { ...c.references, table: SELF } : c.references)
        : '',
    })),
  );
  const [error, setError] = useState(null);
  const nameRef = useRef(null);
  const focusRow = useRef(null);
  const rowRefs = useRef([]);

  // React Flow keeps a new node hidden until it has measured it, and a hidden
  // input can't take focus, so keep trying briefly.
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      const el = nameRef.current;
      if (el) {
        el.focus();
        if (isNew) el.select();
      }
      if (document.activeElement === el || ++tries > 20) clearInterval(timer);
    }, 25);
    return () => clearInterval(timer);
  }, [isNew]);

  // Focus the name of a column that was just added.
  useEffect(() => {
    if (focusRow.current !== null) {
      rowRefs.current[focusRow.current]?.focus();
      focusRow.current = null;
    }
  }, [rows.length]);

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
  const addColumn = (at = rows.length) => {
    focusRow.current = at;
    setRows((rs) => [...rs.slice(0, at), blankColumn(), ...rs.slice(at)]);
  };

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
    // Old → new column names, so annotations on columns (e.g. star schema keys) can follow.
    const renames = Object.fromEntries(rows.filter((r) => r.orig && r.name.trim() && r.orig !== r.name.trim()).map((r) => [r.orig, r.name.trim()]));
    try {
      onSave(validateProposal(next), n, renames);
    } catch (err) {
      setError(err.message);
    }
  };

  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') onCancel();
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
  };

  // Enter in a column's name adds the next column.
  const onNameKey = (i) => (e) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      addColumn(i + 1);
    }
  };

  return (
    // Clicks inside the form are the form's: they must not reach React Flow's node
    // click, which would reselect the node by its old id after a rename.
    <div className="table-node proposed editing" onKeyDown={onKeyDown} onClick={(e) => e.stopPropagation()}>
      <Handle type="target" position={Position.Top} id={TABLE_HANDLE_TOP} className="erd-handle" />
      <Handle type="source" position={Position.Bottom} id={TABLE_HANDLE_BOTTOM} className="erd-handle" />
      <div className="table-node__header">
        <Handle type="target" position={Position.Left} id={TABLE_HANDLE_IN} className="erd-handle" />
        <input
          ref={nameRef}
          className={`entity-name ${NO_FLOW}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="table_name"
          aria-label="Table name"
        />
        <span className="table-node__badge proposed">{isNew ? 'new' : 'editing'}</span>
        <Handle type="source" position={Position.Right} id={TABLE_HANDLE_OUT} className="erd-handle" />
      </div>
      <input
        className={`entity-desc ${NO_FLOW}`}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Description: what does each row represent?"
        aria-label="Description"
      />
      <datalist id="entity-types">
        {TYPES[source].map((t) => <option key={t} value={t} />)}
      </datalist>
      {rows.map((r, i) => (
        <div key={i} className="edit-col">
          <div className="edit-col__line">
            {r.orig && <Handle type="target" position={Position.Left} id={`${r.orig}-in`} className="erd-handle" />}
            <button
              className={`key-toggle ${r.pk ? 'on pk' : ''} ${NO_FLOW}`}
              title={r.pk ? 'Primary key (click to remove)' : 'Make part of the primary key'}
              aria-label="Primary key"
              aria-pressed={r.pk}
              onClick={() => update(i, { pk: !r.pk })}
            >
              PK
            </button>
            <input
              ref={(el) => (rowRefs.current[i] = el)}
              className={`col-name ${NO_FLOW}`}
              value={r.name}
              onChange={(e) => update(i, { name: e.target.value })}
              onKeyDown={onNameKey(i)}
              placeholder="column_name"
              aria-label="Column name"
            />
            <input
              className={`col-type ${NO_FLOW}`}
              list="entity-types"
              value={r.type}
              onChange={(e) => update(i, { type: e.target.value })}
              placeholder="type"
              aria-label="Data type"
            />
            <button
              className={`key-toggle ${r.pk || r.required ? 'on' : ''} ${NO_FLOW}`}
              title={r.pk ? 'Primary key columns are required' : r.required ? 'Required (click to allow empty values)' : 'Optional (click to require a value)'}
              aria-label="Required"
              aria-pressed={r.pk || r.required}
              disabled={r.pk}
              onClick={() => update(i, { required: !r.required })}
            >
              REQ
            </button>
            <span className="edit-col__actions">
              <button className={`icon-btn ${NO_FLOW}`} title="Description" aria-label="Column description" onClick={() => update(i, { showComment: !r.showComment })}>✎</button>
              <button className={`icon-btn ${NO_FLOW}`} title="Move up" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button className={`icon-btn ${NO_FLOW}`} title="Move down" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === rows.length - 1}>↓</button>
              <button className={`icon-btn ${NO_FLOW}`} title="Remove column" aria-label="Remove column" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>×</button>
            </span>
            {r.orig && <Handle type="source" position={Position.Right} id={`${r.orig}-out`} className="erd-handle" />}
          </div>
          <div className="edit-col__line sub">
            <select
              className={`col-ref ${r.ref ? 'set' : ''} ${NO_FLOW}`}
              value={r.ref}
              onChange={(e) => chooseRef(i, e.target.value)}
              aria-label="References"
            >
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
          {r.showComment && (
            <input
              className={`col-desc ${NO_FLOW}`}
              value={r.comment}
              onChange={(e) => update(i, { comment: e.target.value })}
              placeholder="Column description"
              aria-label="Description of column"
            />
          )}
        </div>
      ))}
      <button className={`add-col ${NO_FLOW}`} onClick={() => addColumn()}>+ Add column</button>
      {error && <div className="edit-error">{error}</div>}
      <div className="edit-footer">
        <span className="hint">Enter: next column · Ctrl+Enter: done · Esc: {isNew ? 'discard' : 'cancel'}</span>
        <button className={`btn small ${NO_FLOW}`} onClick={onCancel}>{isNew ? 'Discard' : 'Cancel'}</button>
        <button className={`btn small primary ${NO_FLOW}`} disabled={!name.trim()} onClick={save}>Done</button>
      </div>
    </div>
  );
}
