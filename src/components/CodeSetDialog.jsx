import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api, sourceTableName } from '../lib/api.js';
import { codeSetName } from '../lib/modelLevels.js';

const labelFor = (code) =>
  String(code)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Proposes a new code set. With `source`/`table`/`column` it is seeded from
 * that column's distinct values; otherwise codes are entered by hand.
 */
export default function CodeSetDialog({ source, table, column, onClose, onSubmitted }) {
  const seeded = Boolean(column);
  const [name, setName] = useState(seeded ? codeSetName(table.name, column) : '');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState(seeded ? [] : [{ code: '', label: '', description: '', include: true }]);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(seeded);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!seeded) return;
    api
      .distinctValues(source, table, column)
      .then((values) =>
        setRows(values.map((v) => ({ code: v.value, label: labelFor(v.value), description: '', count: v.count, include: true }))),
      )
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [seeded, source, table, column]);

  const update = (i, field, value) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  const included = rows.filter((r) => r.include && String(r.code).trim() !== '');

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const change = await api.proposeChange({
        kind: 'code_set',
        action: 'create',
        payload: {
          name,
          description: description || null,
          source: seeded ? { system: source, table: sourceTableName(source, table), column } : null,
          values: included.map((r, i) => ({
            code: String(r.code).trim(),
            label: r.label || null,
            description: r.description || null,
            sort_order: i + 1,
          })),
        },
        comment,
      });
      onSubmitted?.(change);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Propose code set"
      subtitle={seeded ? `From ${sourceTableName(source, table)}.${column}` : 'New reference data list'}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">{included.length} codes · a data steward must approve before it is created</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={saving || !name.trim() || !included.length} onClick={submit}>
            {saving ? 'Submitting…' : 'Submit for approval'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Asset Status" />
        </label>
        <label className="field grow">
          <span>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      {error && <div className="error inline">{error}</div>}
      {loading ? (
        <p className="muted">Reading distinct values…</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 32 }} />
              <th>Code</th>
              <th>Label</th>
              <th>Description</th>
              {seeded && <th className="num">Rows</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.include ? '' : 'excluded'}>
                <td>
                  <input type="checkbox" checked={r.include} onChange={(e) => update(i, 'include', e.target.checked)} />
                </td>
                <td>
                  {seeded ? <code>{r.code}</code> : <input value={r.code} onChange={(e) => update(i, 'code', e.target.value)} />}
                </td>
                <td><input value={r.label} onChange={(e) => update(i, 'label', e.target.value)} /></td>
                <td><input value={r.description} onChange={(e) => update(i, 'description', e.target.value)} /></td>
                {seeded && <td className="num">{r.count}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!seeded && (
        <button className="btn small" onClick={() => setRows((rs) => [...rs, { code: '', label: '', description: '', include: true }])}>
          + Add code
        </button>
      )}
      <label className="field">
        <span>Comment for the reviewer</span>
        <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Why is this needed?" />
      </label>
    </Modal>
  );
}
