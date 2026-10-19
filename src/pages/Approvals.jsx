import { useCallback, useEffect, useState } from 'react';
import ChangeDiff from '../components/ChangeDiff.jsx';
import { api } from '../lib/api.js';

const STATUS_CLASS = { pending: 'warn', applied: 'ok', rejected: 'bad', failed: 'bad', cancelled: '' };
const when = (t) => (t ? new Date(t).toLocaleString() : '');

function ChangeCard({ change, me, onDone }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const own = change.requested_by === me?.user;
  const canReview = change.status === 'pending' && me?.isSteward && (!own || me.selfApproval);

  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`change-card status-${change.status}`}>
      <div className="change-card__head">
        <div>
          <div className="change-card__title">{change.summary}</div>
          <div className="muted small">
            #{change.id} · requested by {change.requested_by} · {when(change.requested_at)}
          </div>
        </div>
        <span className={`tag ${STATUS_CLASS[change.status]}`}>{change.status}</span>
      </div>
      {change.request_comment && <p className="quote">“{change.request_comment}”</p>}
      <ChangeDiff change={change} />
      {change.reviewed_by && change.status !== 'pending' && (
        <p className="muted small">
          {change.status === 'cancelled' ? 'Cancelled' : 'Reviewed'} by {change.reviewed_by} · {when(change.reviewed_at)}
          {change.review_comment && <> · “{change.review_comment}”</>}
        </p>
      )}
      {change.error && <div className="error inline">{change.error}</div>}
      {error && <div className="error inline">{error}</div>}
      {change.status === 'pending' && (
        <div className="change-card__actions">
          {canReview && (
            <>
              <input placeholder="Review comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
              <button className="btn danger" disabled={busy} onClick={() => act(() => api.reviewChange(change.id, 'reject', comment))}>
                Reject
              </button>
              <button className="btn primary" disabled={busy} onClick={() => act(() => api.reviewChange(change.id, 'approve', comment))}>
                Approve &amp; apply
              </button>
            </>
          )}
          {!canReview && !own && <span className="muted small">Waiting for a data steward.</span>}
          {own && !canReview && <span className="muted small">Your request — another steward must review it.</span>}
          {own && (
            <button className="btn" disabled={busy} onClick={() => act(() => api.cancelChange(change.id))}>
              Cancel request
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Approvals({ me, onChanged }) {
  const [tab, setTab] = useState('pending');
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    const req = tab === 'audit' ? api.audit() : api.changes(tab === 'pending' ? { status: 'pending' } : {});
    req.then(setItems).catch((err) => setError(err.message));
  }, [tab]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  const done = () => {
    load();
    onChanged?.();
  };

  return (
    <div className="page">
      <div className="page__main narrow">
        <div className="page__header">
          <div>
            <h2>Approvals</h2>
            <p className="muted small">
              Signed in as {me?.user}
              {me?.isSteward ? ' · data steward' : ' · requester (stewards approve changes)'}
            </p>
          </div>
          <div className="segmented">
            {[
              ['pending', 'Pending'],
              ['all', 'All requests'],
              ['audit', 'Change history'],
            ].map(([id, label]) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="error inline">{error}</div>}
        {items && !items.length && <p className="muted">Nothing here yet.</p>}
        {tab === 'audit'
          ? items && (
              <table className="grid">
                <thead>
                  <tr><th>Applied</th><th>Change</th><th>Requested by</th><th>Approved by</th><th>Before → After</th></tr>
                </thead>
                <tbody>
                  {items.map((a) => (
                    <tr key={a.id}>
                      <td className="nowrap">{when(a.applied_at)}</td>
                      <td>{a.summary}</td>
                      <td>{a.requested_by}</td>
                      <td>{a.approved_by}</td>
                      <td>
                        <details>
                          <summary className="muted small">details</summary>
                          <pre className="json">{JSON.stringify({ before: a.before, after: a.after }, null, 2)}</pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          : items?.map((c) => <ChangeCard key={c.id} change={c} me={me} onDone={done} />)}
      </div>
    </div>
  );
}
