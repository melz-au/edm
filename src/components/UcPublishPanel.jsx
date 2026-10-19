import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const when = (t) => (t ? new Date(t).toLocaleString() : '');

/** Settings, status and history of publishing reference data to Unity Catalog. */
export default function UcPublishPanel({ me }) {
  const [state, setState] = useState(null);
  const [target, setTarget] = useState('');
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showRuns, setShowRuns] = useState(false);

  const load = useCallback(() => {
    api
      .publishStatus()
      .then((s) => {
        setState(s);
        setTarget(s.settings.target);
        setAuto(s.settings.auto);
      })
      .catch((err) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  // Refresh while a run is in progress (e.g. an auto-publish after approval).
  useEffect(() => {
    if (!state?.running) return undefined;
    const t = setTimeout(load, 2000);
    return () => clearTimeout(t);
  }, [state, load]);

  const steward = Boolean(me?.isSteward);
  const dirty = state && (target !== state.settings.target || auto !== state.settings.auto);
  const last = state?.runs?.[0];

  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <div className="uc-panel">
      <div className="uc-panel__title">Unity Catalog sync</div>
      {!state ? (
        <p className="muted small">{error ?? 'Loading…'}</p>
      ) : (
        <>
          <p className="muted small">
            Publishes code sets, codes and mappings as Delta tables <code>code_set</code>, <code>code_value</code>,{' '}
            <code>code_mapping</code>.
          </p>
          <label className="field">
            <span>Target catalog.schema</span>
            <input value={target} disabled={!steward} placeholder="main.refdata" onChange={(e) => setTarget(e.target.value)} />
          </label>
          <label className="check small">
            <input type="checkbox" checked={auto} disabled={!steward} onChange={(e) => setAuto(e.target.checked)} />
            Publish automatically after each approved change
          </label>
          {!state.warehouse && (
            <div className="error inline small">No SQL warehouse available. Add one to the app's resources to publish.</div>
          )}
          {state.warehouse && <div className="muted small">Warehouse: {state.warehouse.name ?? 'configured'}</div>}
          {steward && (
            <div className="uc-panel__actions">
              {dirty && (
                <button className="btn small" disabled={busy} onClick={() => act(() => api.savePublishSettings({ target, auto }))}>
                  Save settings
                </button>
              )}
              <button
                className="btn small primary"
                disabled={busy || dirty || !state.settings.target || !state.warehouse || state.running}
                onClick={() => act(() => api.publishNow())}
              >
                {busy || state.running ? 'Publishing…' : 'Publish now'}
              </button>
            </div>
          )}
          {last && (
            <div className={`uc-panel__last ${last.status}`}>
              Last publish: <strong>{last.status}</strong> · {when(last.finished_at ?? last.started_at)}
              {last.counts && (
                <div className="muted small">
                  {last.counts.code_set} sets · {last.counts.code_value} codes · {last.counts.code_mapping} mappings → {last.target}
                </div>
              )}
              {last.error && <div className="error inline small">{last.error}</div>}
            </div>
          )}
          {state.runs.length > 1 && (
            <button className="link small" onClick={() => setShowRuns(!showRuns)}>
              {showRuns ? 'Hide' : 'Show'} history
            </button>
          )}
          {showRuns && (
            <ul className="uc-panel__runs">
              {state.runs.map((r) => (
                <li key={r.id}>
                  <span className={`tag ${r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn'}`}>{r.status}</span>{' '}
                  {when(r.started_at)} · {r.trigger} · {r.triggered_by}
                </li>
              ))}
            </ul>
          )}
          {error && <div className="error inline small">{error}</div>}
        </>
      )}
    </div>
  );
}
