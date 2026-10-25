import { FIX_LABELS, ROLE_LABELS, ROLES, scd2Columns, suggestRole, surrogateOf } from '../lib/star.js';

const SEVERITY_ICON = { error: '✕', warning: '!', info: 'i' };

/** One star schema issue, with its fix button when the app can repair it. */
export function StarIssue({ issue, onFix, onSelect, showTable = false, tableLabel }) {
  return (
    <li className={`star-issue sev-${issue.severity}`}>
      <span className="star-issue__icon" title={issue.severity}>{SEVERITY_ICON[issue.severity]}</span>
      <span className="star-issue__text">
        {showTable && (
          <button className="link" onClick={() => onSelect(issue.table)}>{tableLabel(issue.table)}</button>
        )}
        {showTable && ': '}
        {issue.message}
      </span>
      {issue.fix && onFix && (
        <button className="btn small" onClick={() => onFix(issue.fix)}>{FIX_LABELS[issue.fix.type]}</button>
      )}
    </li>
  );
}

/**
 * The star schema part of a table's details panel: its role and, for a
 * dimension, the surrogate key, business key and SCD type; for a fact, its
 * grain. Works for existing and proposed tables alike (annotations only).
 */
export default function StarSection({ table, annotation, issues, onChange, onFix }) {
  const ann = annotation ?? null;
  const role = ann?.role ?? '';
  const suggested = suggestRole(table.name);
  const set = (patch) => onChange({ scd: 1, surrogate: null, business: [], grain: null, identity: true, ...ann, ...patch });
  const sk = role === 'dimension' ? surrogateOf(table, ann) : null;
  const business = new Set(ann?.business ?? []);
  const toggleBusiness = (name) => {
    const next = new Set(business);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    set({ business: [...next] });
  };
  const h = role === 'dimension' && ann?.scd === 2 ? scd2Columns(table) : null;

  return (
    <>
      <h4>Star schema</h4>
      <div className="star-form">
        <label className="star-row">
          Role
          <select
            value={role}
            onChange={(e) => (e.target.value ? set({ role: e.target.value }) : onChange(null))}
            aria-label="Star schema role"
          >
            <option value="">Not classified</option>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
          {!role && suggested && (
            <button className="link" onClick={() => set({ role: suggested })}>Use {ROLE_LABELS[suggested].toLowerCase()} (from name)</button>
          )}
        </label>

        {role === 'dimension' && (
          <>
            <label className="star-row">
              Surrogate key
              <select value={ann?.surrogate ?? ''} onChange={(e) => set({ surrogate: e.target.value || null })} aria-label="Surrogate key">
                <option value="">{sk?.assumed ? `${sk.column.name} (assumed from the key)` : 'None'}</option>
                {table.columns.map((c) => <option key={c.name} value={c.name}>{c.name} · {c.displayType ?? c.type}</option>)}
              </select>
            </label>
            {table.proposed && (ann?.surrogate || sk) && (
              <label className="check small">
                <input type="checkbox" checked={ann?.identity !== false} onChange={(e) => set({ identity: e.target.checked })} />
                Generate it (identity column). Untick for smart keys like yyyymmdd.
              </label>
            )}
            <div className="star-row star-row--top">
              Business key
              <div className="star-bk">
                {table.columns
                  .filter((c) => c.name !== (ann?.surrogate ?? sk?.column.name))
                  .map((c) => (
                    <label key={c.name} className="check small">
                      <input type="checkbox" checked={business.has(c.name)} onChange={() => toggleBusiness(c.name)} />
                      {c.name}
                    </label>
                  ))}
              </div>
            </div>
            <label className="star-row">
              History
              <select value={ann?.scd ?? 1} onChange={(e) => set({ scd: Number(e.target.value) })} aria-label="Slowly changing dimension type">
                <option value={1}>SCD type 1 (overwrite)</option>
                <option value={2}>SCD type 2 (keep versions)</option>
              </select>
            </label>
            {h && (
              <p className="muted small">
                Versions: {h.from ?? '—'} → {h.to ?? '—'}, current flag {h.current ?? '—'}
              </p>
            )}
          </>
        )}

        {role === 'fact' && (
          <label className="star-row">
            Grain
            <input
              key={table.id}
              defaultValue={ann?.grain ?? ''}
              placeholder="e.g. one row per order line"
              onBlur={(e) => e.target.value.trim() !== (ann?.grain ?? '') && set({ grain: e.target.value.trim() || null })}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              aria-label="Grain"
            />
          </label>
        )}
      </div>
      {issues.length > 0 && (
        <ul className="star-issues">
          {issues.map((i) => <StarIssue key={i.id} issue={i} onFix={onFix} />)}
        </ul>
      )}
      {role && !issues.length && <p className="muted small">✓ No star schema issues for this table.</p>}
    </>
  );
}
