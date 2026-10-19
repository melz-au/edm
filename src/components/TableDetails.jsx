const CARDINALITY_TEXT = { 'N:1': 'many-to-one', '1:1': 'one-to-one', 'M:N': 'many-to-many' };

import { useState } from 'react';
import DataQuality from './DataQuality.jsx';

function ProfileSection({ table, profile, canProfile, onProfile, linked, mapped, onCreateCodeSet, onMapCodes }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!canProfile && !profile) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onProfile();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const categorical = profile?.columns.filter((c) => c.categorical) ?? [];
  const personal = profile?.columns.filter((c) => c.pii) ?? [];
  const linkedBy = new Map((linked ?? []).map((l) => [l.source_column, l]));
  const mappedBy = new Map();
  for (const m of mapped ?? []) {
    const key = m.source_column;
    if (!mappedBy.has(key)) mappedBy.set(key, { name: m.code_set_name, count: 0 });
    mappedBy.get(key).count += 1;
  }
  const rank = { high: 0, medium: 1, low: 2 };

  return (
    <>
      <h4>Data profile</h4>
      {!profile ? (
        <button className="btn small" disabled={busy} onClick={run}>
          {busy ? 'Profiling…' : 'Profile data (categorical & PII)'}
        </button>
      ) : (
        <>
          <p className="muted small">
            {categorical.length} categorical, {personal.length} personal data field{personal.length === 1 ? '' : 's'} in a
            sample of {profile.sampled.toLocaleString()} rows
            {canProfile && (
              <>
                {' · '}
                <button className="link" disabled={busy} onClick={run}>{busy ? 'profiling…' : 're-run'}</button>
              </>
            )}
          </p>
          {personal.length > 0 && <h4>Personal data (PII)</h4>}
          {[...personal]
            .sort((a, b) => rank[a.pii.sensitivity] - rank[b.pii.sensitivity])
            .map((c) => (
              <div key={c.name} className={`cat-field pii-field ${c.pii.sensitivity}`}>
                <div className="cat-field__head">
                  <code>{c.name}</code>
                  <span className={`tag pii ${c.pii.sensitivity}`}>{c.pii.sensitivity} sensitivity</span>
                  <span className="grow" />
                  <span className="muted small">{c.pii.confidence} confidence</span>
                </div>
                <div className="small">{c.pii.label}</div>
                <div className="muted small">Evidence: {c.pii.evidence}</div>
                {c.pii.examples.length > 0 && (
                  <div className="chips">
                    {c.pii.examples.map((v, i) => (
                      <span key={i} className="chip masked" title="Masked sample value">{v}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          {categorical.length > 0 && <h4>Categorical fields</h4>}
          {categorical.map((c) => (
            <div key={c.name} className="cat-field">
              <div className="cat-field__head">
                <code>{c.name}</code>
                <span className={`tag ${c.confidence === 'high' ? 'ok' : ''}`}>{c.confidence}</span>
                <span className="grow" />
                {c.pii ? (
                  <span className="tag pii medium" title="Personal data is not offered as reference data">PII · values masked</span>
                ) : linkedBy.has(c.name) ? (
                  <span className="tag ok" title="Managed as reference data">code set: {linkedBy.get(c.name).name}</span>
                ) : (
                  <>
                    {onMapCodes && (
                      <button className="btn small" onClick={() => onMapCodes(c.name)}>
                        {mappedBy.has(c.name) ? 'Edit mapping' : 'Map to code set'}
                      </button>
                    )}
                    {onCreateCodeSet && !mappedBy.has(c.name) && (
                      <button className="btn small" onClick={() => onCreateCodeSet(c.name)}>
                        Create code set
                      </button>
                    )}
                  </>
                )}
              </div>
              <div className="muted small">{c.reason}</div>
              {mappedBy.has(c.name) && (
                <div className="small">
                  <span className="tag ok">mapped → {mappedBy.get(c.name).name}</span>{' '}
                  <span className="muted">{mappedBy.get(c.name).count} source values mapped</span>
                </div>
              )}
              <div className="chips">
                {c.topValues.map((v) => (
                  <span key={v.value} className="chip" title={`${v.count} rows`}>
                    {v.value} <em>{v.count}</em>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
      {error && <div className="error inline">{error}</div>}
    </>
  );
}

export default function TableDetails({
  table,
  level,
  relationships,
  tablesById,
  onSelect,
  onClose,
  profile,
  canProfile,
  onProfile,
  linked,
  mapped,
  onCreateCodeSet,
  onMapCodes,
  onEditData,
  dqSource,
  onDqChanged,
  onChangeSubmitted,
}) {
  const categorical = new Set(profile?.columns.filter((c) => c.categorical).map((c) => c.name));
  const piiNames = new Set(profile?.columns.filter((c) => c.pii).map((c) => c.name));
  const physical = level === 'physical';
  const outgoing = relationships.filter((r) => r.from.table === table.id);
  const incoming = relationships.filter((r) => r.to.table === table.id && r.from.table !== table.id);
  const label = (id) => tablesById.get(id)?.label ?? tablesById.get(id)?.name ?? id;

  const describe = (r, cols) =>
    physical ? (
      <code>({cols.join(', ')})</code>
    ) : (
      <span className="tag">
        {CARDINALITY_TEXT[r.cardinality] ?? r.cardinality}
        {r.parentEnd === 'zero-one' && ', optional'}
        {r.via && `, via ${r.via.label}`}
      </span>
    );

  const RelList = ({ rels, otherEnd, cols }) => (
    <ul className="details__rels">
      {rels.map((r) => (
        <li key={r.id}>
          {physical && r.from.table === table.id && <><code>{r.from.columns.join(', ')}</code> → </>}
          <button className="link" onClick={() => onSelect(r[otherEnd].table)}>
            {label(r[otherEnd].table)}
          </button>
          {describe(r, r[cols].columns)}
          {r.inferred && <span className="tag">inferred</span>}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="details">
      <div className="details__header">
        <div>
          <div className="details__title">{table.label ?? table.name}</div>
          <div className="details__subtitle">{table.id}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close details">×</button>
      </div>
      {table.comment && <p className="details__comment">{table.comment}</p>}
      {onEditData && (
        <button className="btn small" onClick={onEditData}>
          Edit master data
        </button>
      )}

      <h4>{physical ? 'Columns' : 'Attributes'}</h4>
      <table className="details__columns">
        <tbody>
          {table.columns.map((c) => (
            <tr key={c.name} title={[c.comment, !physical && c.name].filter(Boolean).join('\n') || undefined}>
              <td className="keys">
                {c.pk && <span className="key pk">PK</span>}
                {c.fk && <span className="key fk">FK</span>}
                {piiNames.has(c.name) && <span className="key pii">PII</span>}
                {categorical.has(c.name) && !piiNames.has(c.name) && <span className="key cat">CAT</span>}
              </td>
              <td className={c.nullable ? '' : 'required'}>{c.label ?? c.name}</td>
              <td className="type">{c.displayType ?? c.type}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ProfileSection
        table={table}
        profile={profile}
        canProfile={canProfile}
        onProfile={onProfile}
        linked={linked}
        mapped={mapped}
        onCreateCodeSet={onCreateCodeSet}
        onMapCodes={onMapCodes}
      />

      {dqSource && !table.external && (
        <DataQuality source={dqSource} table={table} onChanged={onDqChanged} onSubmitted={onChangeSubmitted} />
      )}

      {outgoing.length > 0 && (
        <>
          <h4>{physical ? 'References' : 'Relates to'}</h4>
          <RelList rels={outgoing} otherEnd="to" cols="to" />
        </>
      )}
      {incoming.length > 0 && (
        <>
          <h4>{physical ? 'Referenced by' : 'Related from'}</h4>
          <RelList rels={incoming} otherEnd="from" cols="from" />
        </>
      )}
    </div>
  );
}
