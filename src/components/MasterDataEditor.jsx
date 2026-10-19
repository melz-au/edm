import { useCallback, useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../lib/api.js';

const PAGE = 50;
const text = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function RowForm({ meta, row, onCancel, onSubmitted }) {
  const creating = !row;
  const [values, setValues] = useState(() => Object.fromEntries(meta.columns.map((c) => [c.name, text(row?.[c.name])])));
  const [comment, setComment] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const key = row ? Object.fromEntries(meta.primaryKey.map((k) => [k, row[k]])) : null;

  const submit = async (action) => {
    setSaving(true);
    setError(null);
    try {
      let payload = {};
      if (action === 'create') {
        // Leave generated/defaulted columns out when blank so the database fills them.
        for (const c of meta.columns) {
          if (values[c.name] === '' && (c.generated || c.has_default)) continue;
          payload[c.name] = values[c.name] === '' ? null : values[c.name];
        }
      } else if (action === 'update') {
        for (const c of meta.columns) {
          if (c.pk) continue;
          const v = values[c.name] === '' ? null : values[c.name];
          if (text(v) !== text(row[c.name])) payload[c.name] = v;
        }
      }
      const change = await api.proposeChange({
        kind: 'master_row',
        action,
        target: { schema: meta.schema, table: meta.table, ...(key ? { key } : {}) },
        payload,
        comment,
      });
      onSubmitted(change);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="row-form">
      <div className="row-form__title">{creating ? 'New row' : `Row ${Object.values(key).join(' / ')}`}</div>
      <div className="row-form__fields">
        {meta.columns.map((c) => (
          <label key={c.name} className="field">
            <span>
              {c.name} {c.pk && <span className="key pk">PK</span>} {c.fk && <span className="key fk">FK</span>}
              <em className="muted"> {c.type}{c.nullable ? '' : ', required'}</em>
            </span>
            <input
              value={values[c.name]}
              disabled={(!creating && c.pk) || c.generated}
              placeholder={creating && (c.generated || c.has_default) ? '(generated)' : ''}
              onChange={(e) => setValues((v) => ({ ...v, [c.name]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <label className="field">
        <span>Comment for the reviewer</span>
        <input value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      {error && <div className="error inline">{error}</div>}
      <div className="row-form__actions">
        {!creating && (
          <button className="btn danger" disabled={saving} onClick={() => submit('delete')}>
            Propose delete
          </button>
        )}
        <span className="grow" />
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={saving} onClick={() => submit(creating ? 'create' : 'update')}>
          {creating ? 'Propose new row' : 'Propose changes'}
        </button>
      </div>
    </div>
  );
}

/** Browse a Lakebase table and propose row changes for approval. */
export default function MasterDataEditor({ table, onClose, onSubmitted }) {
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(undefined); // undefined: none, null: new row, object: existing
  const [pending, setPending] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(() => {
    api
      .rows(table.schema, table.name, { limit: PAGE, offset, search })
      .then(setData)
      .catch((err) => setError(err.message));
    api
      .changes({ status: 'pending', kind: 'master_row' })
      .then((list) => setPending(list.filter((c) => c.target.schema === table.schema && c.target.table === table.name)))
      .catch(() => {});
  }, [table, offset, search]);

  useEffect(load, [load]);

  const pendingKeys = new Set(pending.map((c) => JSON.stringify(c.target.key ?? null)));
  const keyOf = (row) => JSON.stringify(Object.fromEntries(data.primaryKey.map((k) => [k, row[k]])));
  const editable = data && data.primaryKey.length > 0;

  return (
    <Modal
      title={`Master data: ${table.name}`}
      subtitle={`${table.schema}.${table.name} · changes require data steward approval`}
      onClose={onClose}
      wide
    >
      {error && <div className="error inline">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      {data && !editable && (
        <div className="error inline">This table has no primary key, so rows can be viewed but not edited.</div>
      )}
      {editing !== undefined && data ? (
        <RowForm
          meta={data}
          row={editing}
          onCancel={() => setEditing(undefined)}
          onSubmitted={(change) => {
            setEditing(undefined);
            setNotice(`Submitted for approval: ${change.summary}`);
            onSubmitted?.(change);
            load();
          }}
        />
      ) : (
        <>
          <div className="toolbar">
            <input
              type="search"
              placeholder="Search all columns…"
              value={search}
              onChange={(e) => {
                setOffset(0);
                setSearch(e.target.value);
              }}
            />
            {pending.length > 0 && <span className="tag warn">{pending.length} pending change{pending.length === 1 ? '' : 's'}</span>}
            <span className="grow" />
            {editable && <button className="btn primary" onClick={() => setEditing(null)}>+ Add row</button>}
          </div>
          {data && (
            <div className="grid-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    {data.columns.map((c) => (
                      <th key={c.name}>
                        {c.name} {c.pk && <span className="key pk">PK</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr
                      key={keyOf(row)}
                      className={`${editable ? 'clickable' : ''}${pendingKeys.has(keyOf(row)) ? ' pending' : ''}`}
                      onClick={() => editable && setEditing(row)}
                      title={pendingKeys.has(keyOf(row)) ? 'A change to this row is awaiting approval' : undefined}
                    >
                      {data.columns.map((c) => (
                        <td key={c.name}>{text(row[c.name])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && (
            <div className="pager">
              <span className="muted">
                {data.total === 0 ? 'No rows' : `${offset + 1}–${Math.min(offset + PAGE, data.total)} of ${data.total}`}
              </span>
              <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Previous
              </button>
              <button className="btn small" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
