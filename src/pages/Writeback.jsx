import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const STATUSES = ['pending', 'sent', 'failed', 'cancelled'];
const show = (v) => (v === null || v === undefined ? '—' : v === '' ? '(empty)' : String(v).replace(/^ +| +$/g, (m) => '␣'.repeat(m.length)));

/** The write-back outbox: approved corrections waiting for the integration. */
export default function Writeback({ me, onChanged }) {
  const [status, setStatus] = useState('pending');
  const [entries, setEntries] = useState(null);
  const [counts, setCounts] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    api.outboxCounts().then(setCounts).catch(() => {});
    if (!me?.isSteward) return;
    api.outbox({ status, limit: 500 }).then(setEntries).catch((err) => setError(err.message));
    setSelected(new Set());
  }, [status, me]);
  useEffect(load, [load]);

  const mark = async (newStatus) => {
    try {
      await api.outboxAck([...selected], newStatus, `marked ${newStatus} in the app by ${me.user}`);
      load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="page">
      <div className="page__main narrow">
        <div className="page__header">
          <div>
            <h2>Write-back outbox</h2>
            <p className="muted small">
              Approved corrections, one API call per source record. Your integration sends them to the source system
              and acknowledges each one; this app never calls the source itself.
            </p>
          </div>
          <div className="segmented">
            {STATUSES.map((s) => (
              <button key={s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
                {s} ({counts[s] ?? 0})
              </button>
            ))}
          </div>
        </div>
        {!me?.isSteward ? (
          <p className="muted">The outbox holds personal data, so only data stewards can view or export it.</p>
        ) : (
          <>
            <div className="toolbar">
              <a className="btn small" href={api.outboxExportUrl('json', status)}>Export JSON</a>
              <a className="btn small" href={api.outboxExportUrl('csv', status)}>Export CSV</a>
              <span className="grow" />
              <span className="muted small">{selected.size} selected</span>
              <button className="btn small" disabled={!selected.size} onClick={() => mark('sent')}>Mark sent</button>
              <button className="btn small" disabled={!selected.size} onClick={() => mark('failed')}>Mark failed</button>
              <button className="btn small danger" disabled={!selected.size} onClick={() => mark('cancelled')}>Cancel</button>
            </div>
            {error && <div className="error inline">{error}</div>}
            {entries && !entries.length && <p className="muted">No {status} entries.</p>}
            {entries?.length > 0 && (
              <table className="grid">
                <thead>
                  <tr>
                    <th style={{ width: 28 }}>
                      <input
                        type="checkbox"
                        checked={selected.size === entries.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(entries.map((x) => x.id)) : new Set())}
                      />
                    </th>
                    <th>Call</th>
                    <th>Changes (expected → new)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(e.id)}
                          onChange={(ev) => {
                            const n = new Set(selected);
                            ev.target.checked ? n.add(e.id) : n.delete(e.id);
                            setSelected(n);
                          }}
                        />
                      </td>
                      <td className="nowrap"><code>{e.method} {e.path}</code><div className="muted small">#{e.id} · CR #{e.change_request_id}</div></td>
                      <td className="small">
                        {Object.keys(e.body.set).map((f) => (
                          <div key={f}>
                            <strong>{f}</strong>: <code>{show(e.body.expect[f])}</code> → <code>{show(e.body.set[f])}</code>{' '}
                            <span className="muted">{e.body.fixes?.[f]}</span>
                          </div>
                        ))}
                      </td>
                      <td>
                        <span className={`tag ${e.status === 'sent' ? 'ok' : e.status === 'pending' ? 'warn' : 'bad'}`}>{e.status}</span>
                        {e.last_response && <div className="muted small">{e.last_response}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
