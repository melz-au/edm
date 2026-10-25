import { useState } from 'react';
import { ROLE_LABELS } from '../lib/star.js';
import { StarIssue } from './StarSection.jsx';

/**
 * Sidebar summary of the star schema: how many facts and dimensions, every
 * issue found (click a table name to go to it), and roles suggested from
 * table names.
 */
export default function StarPanel({ star, issues, suggestions, tableLabel, onSelect, onFix, onApplySuggestions }) {
  const [filter, setFilter] = useState('problems');
  const counts = { fact: 0, dimension: 0, bridge: 0 };
  for (const a of Object.values(star)) if (counts[a.role] !== undefined) counts[a.role] += 1;
  const classified = counts.fact + counts.dimension + counts.bridge;
  const bySeverity = { error: 0, warning: 0, info: 0 };
  for (const i of issues) bySeverity[i.severity] += 1;
  const shown = filter === 'all' ? issues : issues.filter((i) => i.severity !== 'info');

  return (
    <section className="star-panel">
      <label className="label">Star schema</label>
      {classified === 0 && !suggestions.length && (
        <p className="muted small">
          Classify tables as facts and dimensions in the details panel, or right-click the diagram for a new dimension,
          fact or date dimension.
        </p>
      )}
      {suggestions.length > 0 && (
        <p className="small">
          {suggestions.length} table{suggestions.length === 1 ? '' : 's'} look{suggestions.length === 1 ? 's' : ''} like{' '}
          {[...new Set(suggestions.map((s) => ROLE_LABELS[s.role].toLowerCase() + 's'))].join(' and ')} from {suggestions.length === 1 ? 'its name' : 'their names'}.{' '}
          <button className="link" onClick={onApplySuggestions}>Classify them</button>
        </p>
      )}
      {classified > 0 && (
        <>
          <div className="star-summary small">
            <span>{counts.fact} fact{counts.fact === 1 ? '' : 's'}</span>
            <span>{counts.dimension} dimension{counts.dimension === 1 ? '' : 's'}</span>
            {counts.bridge > 0 && <span>{counts.bridge} bridge{counts.bridge === 1 ? '' : 's'}</span>}
          </div>
          <div className="star-summary small">
            <span className={`sev sev-error ${bySeverity.error ? '' : 'zero'}`}>{bySeverity.error} error{bySeverity.error === 1 ? '' : 's'}</span>
            <span className={`sev sev-warning ${bySeverity.warning ? '' : 'zero'}`}>{bySeverity.warning} warning{bySeverity.warning === 1 ? '' : 's'}</span>
            <button className="link small" onClick={() => setFilter(filter === 'all' ? 'problems' : 'all')}>
              {filter === 'all' ? 'hide' : 'show'} {bySeverity.info} note{bySeverity.info === 1 ? '' : 's'}
            </button>
          </div>
          {shown.length ? (
            <ul className="star-issues scroll">
              {shown.map((i) => (
                <StarIssue key={i.id} issue={i} onFix={onFix} onSelect={onSelect} showTable tableLabel={tableLabel} />
              ))}
            </ul>
          ) : (
            <p className="muted small">✓ The star schema follows the common patterns.</p>
          )}
        </>
      )}
    </section>
  );
}
