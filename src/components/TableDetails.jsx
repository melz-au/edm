const CARDINALITY_TEXT = { 'N:1': 'many-to-one', '1:1': 'one-to-one', 'M:N': 'many-to-many' };

export default function TableDetails({ table, level, relationships, tablesById, onSelect, onClose }) {
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

      <h4>{physical ? 'Columns' : 'Attributes'}</h4>
      <table className="details__columns">
        <tbody>
          {table.columns.map((c) => (
            <tr key={c.name} title={[c.comment, !physical && c.name].filter(Boolean).join('\n') || undefined}>
              <td className="keys">
                {c.pk && <span className="key pk">PK</span>}
                {c.fk && <span className="key fk">FK</span>}
              </td>
              <td className={c.nullable ? '' : 'required'}>{c.label ?? c.name}</td>
              <td className="type">{c.displayType ?? c.type}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
