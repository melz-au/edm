import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { api, sourceTableName } from '../lib/api.js';
import { attributeName } from '../lib/modelLevels.js';

const UNMAPPED = '';
const MISSING = '__missing__';

/** Shows hidden whitespace so "Closed " and "Closed" are distinguishable. */
export function showRaw(value) {
  if (value === '') return <span className="muted">(empty)</span>;
  const visible = String(value).replace(/^ +| +$/g, (m) => '␣'.repeat(m.length));
  return <code>{visible}</code>;
}

const selectionOf = (m) => (!m ? UNMAPPED : m.codeValueId === null ? MISSING : String(m.codeValueId));

/** Picks the code set whose name shares the most words with the column name. */
function guessCodeSet(sets, column, linked) {
  if (linked) return linked.id;
  const words = new Set(attributeName(column).toLowerCase().split(/\s+/));
  let best = null;
  for (const s of sets) {
    const score = s.name.toLowerCase().split(/\s+/).filter((w) => words.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { id: s.id, score };
  }
  return best?.id ?? sets[0]?.id ?? null;
}

/**
 * Maps every distinct value of a source column onto a code set, starting
 * from suggestions, and submits the changes for approval.
 */
export default function CodeMappingDialog({ source, table, column, onClose, onSubmitted }) {
  const tableName = sourceTableName(source, table);
  const [sets, setSets] = useState(null);
  const [setId, setSetId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [values, setValues] = useState(null); // [{ value, count }]
  const [current, setCurrent] = useState(new Map()); // value → { codeValueId }
  const [suggestions, setSuggestions] = useState(new Map()); // value → suggestion
  const [choice, setChoice] = useState(new Map()); // value → selection
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Code sets and the column's distinct values.
  useEffect(() => {
    Promise.all([api.codeSets(), api.distinctValues(source, table, column)])
      .then(([list, vals]) => {
        if (vals.some((v) => v.masked)) throw new Error('This column holds personal data, so its values are masked and cannot be mapped.');
        setSets(list);
        setValues(vals);
        setSetId(guessCodeSet(list, column, null));
      })
      .catch((err) => setError(err.message));
  }, [source, table, column]);

  // Existing mappings and suggestions for the chosen code set.
  useEffect(() => {
    if (!setId || !values) return;
    setDetail(null);
    Promise.all([
      api.codeSet(setId),
      api.sourceMappings(source, tableName, column),
      api.suggestMappings(setId, values.map((v) => v.value)),
    ])
      .then(([set, existing, suggested]) => {
        const cur = new Map(existing.filter((m) => m.code_set_id === setId).map((m) => [m.source_value, { codeValueId: m.code_value_id }]));
        const sug = new Map(suggested.map((s) => [s.value, s]));
        setDetail(set);
        setCurrent(cur);
        setSuggestions(sug);
        setChoice(
          new Map(
            values.map(({ value }) => {
              if (cur.has(value)) return [value, selectionOf(cur.get(value))];
              const s = sug.get(value);
              return [value, s?.missing ? MISSING : s?.codeValueId ? String(s.codeValueId) : UNMAPPED];
            }),
          ),
        );
      })
      .catch((err) => setError(err.message));
  }, [setId, values, source, tableName, column]);

  const totals = useMemo(() => {
    if (!values) return null;
    const total = values.reduce((n, v) => n + v.count, 0);
    const mapped = values.filter((v) => choice.get(v.value) !== UNMAPPED);
    const changes = values.filter((v) => choice.get(v.value) !== selectionOf(current.get(v.value)));
    return {
      total,
      mappedRows: mapped.reduce((n, v) => n + v.count, 0),
      unmappedValues: values.length - mapped.length,
      changes,
    };
  }, [values, choice, current]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    const target = { codeSetId: setId, source: { system: source, table: tableName, column } };
    const toSet = totals.changes.filter((v) => choice.get(v.value) !== UNMAPPED);
    const toRemove = totals.changes.filter((v) => choice.get(v.value) === UNMAPPED);
    try {
      const done = [];
      if (toSet.length) {
        done.push(
          await api.proposeChange({
            kind: 'code_mapping',
            action: 'create',
            target,
            payload: {
              mappings: toSet.map((v) => ({
                value: v.value,
                codeValueId: choice.get(v.value) === MISSING ? null : Number(choice.get(v.value)),
              })),
            },
            comment,
          }),
        );
      }
      if (toRemove.length) {
        done.push(
          await api.proposeChange({ kind: 'code_mapping', action: 'delete', target, payload: { values: toRemove.map((v) => v.value) }, comment }),
        );
      }
      done.forEach((c) => onSubmitted?.(c));
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const pct = totals?.total ? Math.round((totals.mappedRows / totals.total) * 100) : 0;
  const rows = (values ?? []).filter(
    (v) => !onlyOpen || choice.get(v.value) === UNMAPPED || choice.get(v.value) !== selectionOf(current.get(v.value)),
  );

  return (
    <Modal
      title="Map source values to a code set"
      subtitle={`${tableName}.${column} · changes require data steward approval`}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">
            {totals ? `${totals.changes.length} change${totals.changes.length === 1 ? '' : 's'} to submit` : ''}
          </span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={saving || !totals?.changes.length || !detail} onClick={submit}>
            {saving ? 'Submitting…' : 'Submit for approval'}
          </button>
        </>
      }
    >
      {error && <div className="error inline">{error}</div>}
      {sets && !sets.length && (
        <div className="error inline">No code sets yet. Create one first (for example from a clean source column), then map other sources to it.</div>
      )}
      {sets?.length > 0 && (
        <div className="form-row">
          <label className="field">
            <span>Target code set</span>
            <select value={setId ?? ''} onChange={(e) => setSetId(Number(e.target.value))}>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          {totals && (
            <div className="field grow">
              <span>
                Coverage: {totals.mappedRows.toLocaleString()} of {totals.total.toLocaleString()} rows ({pct}%) ·{' '}
                {totals.unmappedValues} value{totals.unmappedValues === 1 ? '' : 's'} unmapped
              </span>
              <div className="coverage"><div style={{ width: `${pct}%` }} /></div>
            </div>
          )}
        </div>
      )}

      {detail && values && (
        <>
          <label className="check small">
            <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />
            Only show unmapped or changed values
          </label>
          <table className="grid">
            <thead>
              <tr>
                <th>Source value</th>
                <th className="num">Rows</th>
                <th>Maps to</th>
                <th>Suggestion</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ value, count }) => {
                const sel = choice.get(value);
                const s = suggestions.get(value);
                const changed = sel !== selectionOf(current.get(value));
                return (
                  <tr key={value} className={`${changed ? 'pending' : ''}${sel === UNMAPPED ? ' unmapped' : ''}`}>
                    <td>{showRaw(value)}</td>
                    <td className="num">{count.toLocaleString()}</td>
                    <td>
                      <select
                        value={sel}
                        onChange={(e) => setChoice((m) => new Map(m).set(value, e.target.value))}
                      >
                        <option value={UNMAPPED}>— unmapped —</option>
                        <option value={MISSING}>∅ treat as missing</option>
                        {detail.values.map((c) => (
                          <option key={c.id} value={c.id} disabled={!c.active}>
                            {c.code}{c.label && c.label !== c.code ? ` · ${c.label}` : ''}{c.active ? '' : ' (inactive)'}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="small">
                      {current.has(value) && !changed ? (
                        <span className="tag ok">mapped</span>
                      ) : s ? (
                        <span className={`tag ${s.score >= 0.95 ? 'ok' : s.score > 0 ? 'warn' : ''}`} title={`score ${s.score}`}>
                          {s.reason}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <label className="field">
            <span>Comment for the reviewer</span>
            <input value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        </>
      )}
      {!detail && !error && <p className="muted">Loading values and suggestions…</p>}
    </Modal>
  );
}
