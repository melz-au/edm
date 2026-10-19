import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { api, sourceTableName } from '../lib/api.js';

const TYPE_LABEL = {
  not_null: 'Not null',
  unique: 'Unique',
  allowed_values: 'Allowed values',
  format: 'Format',
  not_future: 'Not in future',
  references: 'References',
};

export const passRate = (r) => (r.last_total ? 1 - r.last_failed / r.last_total : null);
const pct = (x) => `${Math.round(x * 1000) / 10}%`;

function SuggestDialog({ source, table, onClose, onAdded }) {
  const [data, setData] = useState(null);
  const [chosen, setChosen] = useState(new Set());
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .dqSuggest(source, table)
      .then((d) => {
        setData(d);
        setChosen(new Set(d.suggestions.map((s, i) => (s.exists ? null : i)).filter((i) => i !== null)));
      })
      .catch((err) => setError(err.message));
  }, [source, table]);

  const toggle = (i) => setChosen((c) => {
    const n = new Set(c);
    n.has(i) ? n.delete(i) : n.add(i);
    return n;
  });

  const groups = useMemo(() => {
    const g = new Map();
    (data?.suggestions ?? []).forEach((s, i) => {
      if (!g.has(s.column)) g.set(s.column, []);
      g.get(s.column).push({ ...s, i });
    });
    return [...g];
  }, [data]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const rules = data.suggestions.filter((_, i) => chosen.has(i));
      await api.dqAddRules(source, sourceTableName(source, table), rules);
      onAdded();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Suggested data quality rules"
      subtitle={`${sourceTableName(source, table)}${data ? ` · from a profile of ${data.sampled.toLocaleString()} rows` : ''}`}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">{chosen.size} selected</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={saving || !chosen.size} onClick={save}>
            {saving ? 'Adding…' : `Add ${chosen.size} rule${chosen.size === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      {error && <div className="error inline">{error}</div>}
      {!data && !error && <p className="muted">Profiling the table and building suggestions…</p>}
      {data && !data.suggestions.length && <p className="muted">No rules to suggest for this table.</p>}
      {data && data.suggestions.length > 0 && (
        <>
          <div className="toolbar">
            <button className="link small" onClick={() => setChosen(new Set(data.suggestions.map((_, i) => i)))}>Select all</button>
            <button className="link small" onClick={() => setChosen(new Set())}>Select none</button>
          </div>
          <table className="grid">
            <thead>
              <tr><th style={{ width: 32 }} /><th>Column</th><th>Rule</th><th>Why</th><th>Severity</th></tr>
            </thead>
            <tbody>
              {groups.map(([column, rules]) =>
                rules.map((s, k) => (
                  <tr key={s.i} className={s.exists ? 'excluded' : ''}>
                    <td><input type="checkbox" checked={chosen.has(s.i)} onChange={() => toggle(s.i)} /></td>
                    <td>{k === 0 && <code>{column}</code>}</td>
                    <td>
                      <span className="tag">{TYPE_LABEL[s.rule_type]}</span> {s.description}
                      {s.exists && <span className="muted small"> · already added (adding replaces it)</span>}
                    </td>
                    <td className="muted small">{s.reason}</td>
                    <td><span className={`tag ${s.severity === 'error' ? 'bad' : 'warn'}`}>{s.severity}</span></td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}

/** Data quality section of the table details panel. */
export default function DataQuality({ source, table, onChanged }) {
  const tableName = sourceTableName(source, table);
  const [rules, setRules] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api.dqRules(source, tableName).then(setRules).catch((err) => setError(err.message));
  }, [source, tableName]);
  useEffect(load, [load]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setRules(await api.dqRun(source, table));
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const remove = async (id) => {
    await api.dqDeleteRule(id).catch((err) => setError(err.message));
    load();
    onChanged?.();
  };

  const ran = (rules ?? []).filter((r) => r.last_run_at && !r.last_error);
  const score = ran.length ? ran.reduce((n, r) => n + passRate(r), 0) / ran.length : null;
  const failing = ran.filter((r) => r.last_failed > 0).length;
  const sorted = [...(rules ?? [])].sort((a, b) => (passRate(a) ?? 2) - (passRate(b) ?? 2));

  return (
    <>
      <h4>Data quality</h4>
      <div className="dq-head">
        {score !== null && (
          <span className={`dq-score ${score >= 0.98 ? 'ok' : score >= 0.9 ? 'warn' : 'bad'}`}>{pct(score)}</span>
        )}
        <span className="muted small">
          {rules?.length ? `${rules.length} rule${rules.length === 1 ? '' : 's'}${ran.length ? ` · ${failing} failing` : ' · not run yet'}` : 'No rules yet'}
        </span>
        <span className="grow" />
        <button className="btn small" onClick={() => setSuggesting(true)}>Suggest rules</button>
        {rules?.length > 0 && (
          <button className="btn small primary" disabled={running} onClick={run}>
            {running ? 'Running…' : 'Run checks'}
          </button>
        )}
      </div>
      {error && <div className="error inline">{error}</div>}
      {sorted.map((r) => {
        const rate = passRate(r);
        return (
          <div key={r.id} className={`dq-rule ${r.last_error ? 'error' : r.last_failed > 0 ? r.severity : r.last_run_at ? 'pass' : ''}`}>
            <div className="dq-rule__head">
              <span className="small">{r.description}</span>
              <span className="grow" />
              {rate !== null && <span className="small">{pct(rate)}</span>}
              <button className="icon-btn small" title="Remove rule" onClick={() => remove(r.id)}>×</button>
            </div>
            {rate !== null && (
              <div className="coverage"><div style={{ width: `${rate * 100}%` }} /></div>
            )}
            {r.last_failed > 0 && (
              <div className="muted small">
                {r.last_failed.toLocaleString()} of {r.last_total.toLocaleString()} rows fail
                {r.last_samples?.length > 0 && (
                  <div className="chips">
                    {r.last_samples.map((s, i) => (
                      <span key={i} className="chip" title={`${s.count} rows`}>
                        {s.value === '' ? '(empty)' : s.value} <em>{s.count}</em>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {r.last_error && <div className="error inline small">{r.last_error}</div>}
          </div>
        );
      })}
      {suggesting && (
        <SuggestDialog source={source} table={table} onClose={() => setSuggesting(false)} onAdded={() => { load(); onChanged?.(); }} />
      )}
    </>
  );
}
