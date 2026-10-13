export default function TableDetails({ table, relationships, tablesById, onSelect, onClose }) {
  const outgoing = relationships.filter((r) => r.from.table === table.id);
  const incoming = relationships.filter((r) => r.to.table === table.id && r.from.table !== table.id);
  const label = (id) => tablesById.get(id)?.name ?? id;

  return (
    <div className="details">
      <div className="details__header">
        <div>
          <div className="details__title">{table.name}</div>
          <div className="details__subtitle">{table.id}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close details">×</button>
      </div>
      {table.comment && <p className="details__comment">{table.comment}</p>}

      <table className="details__columns">
        <tbody>
          {table.columns.map((c) => (
            <tr key={c.name} title={c.comment || undefined}>
              <td className="keys">
                {c.pk && <span className="key pk">PK</span>}
                {c.fk && <span className="key fk">FK</span>}
              </td>
              <td className={c.nullable ? '' : 'required'}>{c.name}</td>
              <td className="type">{c.type}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {outgoing.length > 0 && (
        <>
          <h4>References</h4>
          <ul className="details__rels">
            {outgoing.map((r) => (
              <li key={r.id}>
                <code>{r.from.columns.join(', ')}</code> →{' '}
                <button className="link" onClick={() => onSelect(r.to.table)}>
                  {label(r.to.table)}
                </button>
                <code>({r.to.columns.join(', ')})</code>
                {r.inferred && <span className="tag">inferred</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {incoming.length > 0 && (
        <>
          <h4>Referenced by</h4>
          <ul className="details__rels">
            {incoming.map((r) => (
              <li key={r.id}>
                <button className="link" onClick={() => onSelect(r.from.table)}>
                  {label(r.from.table)}
                </button>
                <code>({r.from.columns.join(', ')})</code>
                {r.inferred && <span className="tag">inferred</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
