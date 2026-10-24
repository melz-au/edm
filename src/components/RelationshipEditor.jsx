import { useEffect, useState } from 'react';
import { END_LABELS, ENDS } from '../lib/proposals.js';

/**
 * Edits one relationship's cardinality on the diagram, in crow's foot terms:
 * how many rows of each table go with one row of the other, plus an optional
 * verb phrase ("places"). Changes apply straight away to the unsaved data
 * model. Drawn relationships can be deleted; others can go back to what the
 * keys imply.
 */
export default function RelationshipEditor({ rel, fromLabel, toLabel, position, onChange, onClear, onClose }) {
  const [phrase, setPhrase] = useState(rel.phrase ?? '');
  useEffect(() => setPhrase(rel.phrase ?? ''), [rel.id, rel.phrase]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = { fromEnd: rel.childEnd, toEnd: rel.parentEnd, phrase: rel.phrase ?? null };
  const set = (patch) => onChange({ ...current, ...patch });

  const select = (value, onSelect, label) => (
    <select value={value} onChange={(e) => onSelect(e.target.value)} aria-label={label}>
      {ENDS.map((e) => (
        <option key={e} value={e}>{END_LABELS[e]}</option>
      ))}
    </select>
  );

  return (
    <div className="rel-editor" style={{ left: position.x, top: position.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="rel-editor__head">
        <strong>{fromLabel}</strong> → <strong>{toLabel}</strong>
        {rel.drawn ? <span className="tag proposed">drawn</span> : rel.override && <span className="tag proposed">edited</span>}
        <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
      </div>
      {rel.via ? (
        <p className="muted small">
          This many-to-many comes from the junction table {rel.via.label}. Edit its two relationships in the logical or
          physical view.
        </p>
      ) : (
        <>
          <div className="rel-editor__line">
            Each <strong>{fromLabel}</strong> has {select(current.toEnd, (toEnd) => set({ toEnd }), `${toLabel} per ${fromLabel}`)}{' '}
            <strong>{toLabel}</strong>
          </div>
          <div className="rel-editor__line">
            Each <strong>{toLabel}</strong> has {select(current.fromEnd, (fromEnd) => set({ fromEnd }), `${fromLabel} per ${toLabel}`)}{' '}
            <strong>{fromLabel}</strong>
          </div>
          <label className="rel-editor__line">
            Phrase
            <input
              value={phrase}
              maxLength={100}
              placeholder="e.g. places, belongs to"
              onChange={(e) => setPhrase(e.target.value)}
              onBlur={() => phrase.trim() !== (rel.phrase ?? '') && set({ phrase: phrase.trim() || null })}
              onKeyDown={(e) => e.key === 'Enter' && set({ phrase: phrase.trim() || null })}
            />
          </label>
          <div className="rel-editor__actions">
            {rel.drawn ? (
              <button className="btn small danger" onClick={onClear}>Delete relationship</button>
            ) : (
              rel.override && <button className="btn small" onClick={onClear}>Reset to keys</button>
            )}
            <span className="grow" />
            <button className="btn small primary" onClick={onClose}>Done</button>
          </div>
          {!rel.drawn && !rel.override && (
            <p className="muted small">Now derived from the keys. Changing it only affects this data model.</p>
          )}
        </>
      )}
    </div>
  );
}
