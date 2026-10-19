import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api, sourceTableName } from '../lib/api.js';

const SAFETY_INFO = {
  safe: { label: 'Safe', tag: 'ok', help: 'Lossless and deterministic, or backed by an approved code mapping.' },
  review: { label: 'Needs review', tag: 'warn', help: 'Very likely right, but rests on an assumption.' },
  manual: { label: 'Not automatic', tag: 'bad', help: 'Can’t be fixed from the data; listed so it can be fixed in the source.' },
};
const show = (v) => (v === null || v === undefined ? '—' : v === '' ? '(empty)' : String(v).replace(/^ +| +$/g, (m) => '␣'.repeat(m.length)));

/**
 * Proposes corrections derived from a table's data quality rules and submits
 * the selected groups as a write-back change request.
 */
export default function WritebackDialog({ source, table, onClose, onSubmitted }) {
  const [data, setData] = useState(null);
  const [key, setKey] = useState(null);
  const [areaCode, setAreaCode] = useState('08');
  const [method, setMethod] = useState('PATCH');
  const [path, setPath] = useState('');
  const [chosen, setChosen] = useState(new Set());
  const [comment, setComment] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .writebackProposals(source, table, { key: key?.join(','), areaCode })
      .then((d) => {
        setData(d);
        if (!key && d.keyColumns.length) setKey(d.keyColumns);
        if (d.keyColumns.length) setPath((p) => p || `/${table.name}/${d.keyColumns.map((k) => `{${k}}`).join('/')}`);
        setChosen(new Set(d.groups.filter((g) => g.safety === 'safe').map((g) => g.id)));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, table, key?.join(','), areaCode]);

  const fixable = (data?.groups ?? []).filter((g) => g.safety !== 'manual');
  const manual = (data?.groups ?? []).filter((g) => g.safety === 'manual');
  const selectedCount = fixable.filter((g) => chosen.has(g.id)).reduce((n, g) => n + g.count, 0);
  const toggle = (id) => setChosen((c) => {
    const n = new Set(c);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const change = await api.proposeChange({
        kind: 'writeback',
        action: 'create',
        target: { system: source, catalog: table.catalog, schema: table.schema, table: table.name },
        payload: { keyColumns: key, groupIds: [...chosen], method, pathTemplate: path, areaCode },
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

  const GroupRow = ({ g, selectable }) => (
    <tr className={selectable && !chosen.has(g.id) ? 'excluded' : ''}>
      <td>{selectable && <input type="checkbox" checked={chosen.has(g.id)} onChange={() => toggle(g.id)} />}</td>
      <td><span className={`tag ${SAFETY_INFO[g.safety].tag}`}>{SAFETY_INFO[g.safety].label}</span></td>
      <td><code>{g.column}</code></td>
      <td className="small">{g.reason}</td>
      <td className="num">{g.count.toLocaleString()}</td>
      <td className="small">
        {g.examples.map((e, i) => (
          <div key={i}>
            <code>{show(e.old)}</code>
            {g.safety !== 'manual' && <> → <code>{show(e.new)}</code></>}
          </div>
        ))}
      </td>
    </tr>
  );

  return (
    <Modal
      title="Propose corrections for the source system"
      subtitle={`${sourceTableName(source, table)}${data?.rowsRead ? ` · ${data.rowsRead.toLocaleString()} rows checked` : ''} · approved corrections go to the write-back outbox`}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">{selectedCount.toLocaleString()} corrections selected · a data steward approves before anything is queued</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={saving || !selectedCount || !key?.length || !path} onClick={submit}>
            {saving ? 'Submitting…' : 'Submit for approval'}
          </button>
        </>
      }
    >
      {error && <div className="error inline">{error}</div>}
      {data && (
        <div className="form-row">
          <label className="field">
            <span>Record key in the source system</span>
            <select value={key?.join(',') ?? ''} onChange={(e) => setKey(e.target.value ? e.target.value.split(',') : null)}>
              {!key?.length && <option value="">Choose…</option>}
              {data.suggestedKey.length > 1 && <option value={data.suggestedKey.join(',')}>{data.suggestedKey.join(' + ')}</option>}
              {data.columns.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>API call</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option>PATCH</option>
              <option>PUT</option>
              <option>POST</option>
            </select>
          </label>
          <label className="field grow">
            <span>Path template (use key columns in braces)</span>
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/customers/{CUST_NO}" />
          </label>
          <label className="field" style={{ minWidth: 90 }}>
            <span>Area code</span>
            <input value={areaCode} onChange={(e) => setAreaCode(e.target.value)} title="Used (as a review item) for landlines missing an area code" />
          </label>
        </div>
      )}
      {data && (data.ambiguousKeys > 0 || data.missingKey > 0) && (
        <div className="notice warn small">
          {data.ambiguousKeys > 0 && `${data.ambiguousKeys} key value(s) match records with different contents and are left out. `}
          {data.missingKey > 0 && `${data.missingKey} row(s) have no key and are left out.`}
        </div>
      )}
      {loading && <p className="muted">Building corrections from the data quality rules…</p>}
      {data?.needsKey && <p className="muted">Choose the column that identifies a record in the source system.</p>}
      {!loading && data && !data.needsKey && (
        <>
          <h4>Corrections to send</h4>
          <p className="muted small">{SAFETY_INFO.safe.help} {SAFETY_INFO.review.help}</p>
          {fixable.length ? (
            <table className="grid">
              <thead><tr><th style={{ width: 28 }} /><th>Safety</th><th>Field</th><th>Fix</th><th className="num">Records</th><th>Examples</th></tr></thead>
              <tbody>{fixable.map((g) => <GroupRow key={g.id} g={g} selectable />)}</tbody>
            </table>
          ) : (
            <p className="muted">Nothing can be corrected automatically.</p>
          )}
          {manual.length > 0 && (
            <details>
              <summary className="muted small">
                {manual.reduce((n, g) => n + g.count, 0).toLocaleString()} issues that can’t be corrected automatically (fix in the source)
              </summary>
              <table className="grid">
                <tbody>{manual.map((g) => <GroupRow key={g.id} g={g} />)}</tbody>
              </table>
            </details>
          )}
          <label className="field">
            <span>Comment for the reviewer</span>
            <input value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        </>
      )}
    </Modal>
  );
}
