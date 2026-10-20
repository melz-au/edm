const show = (v) => (v === null || v === undefined || v === '' ? <span className="muted">(empty)</span> : String(v));

/** Field-by-field view of what a change request will do. */
export default function ChangeDiff({ change }) {
  const { kind, action, payload = {}, previous } = change;

  if (kind === 'code_set' && action === 'create') {
    return (
      <div className="diff">
        {payload.description && <p className="muted">{payload.description}</p>}
        {payload.source && (
          <p className="muted">
            Source: {payload.source.table}.{payload.source.column}
          </p>
        )}
        <table className="grid compact">
          <thead>
            <tr><th>Code</th><th>Label</th><th>Description</th></tr>
          </thead>
          <tbody>
            {payload.values.map((v) => (
              <tr key={v.code}><td><code>{v.code}</code></td><td>{show(v.label)}</td><td>{show(v.description)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (kind === 'writeback') {
    const label = { safe: ['Safe', 'ok'], review: ['Needs review', 'warn'] };
    const shown = (v) => (v === null || v === undefined ? '—' : v === '' ? '(empty)' : String(v).replace(/^ +| +$/g, (m) => '␣'.repeat(m.length)));
    return (
      <div className="diff">
        <p className="muted small">
          {payload.method} <code>{payload.pathTemplate}</code> · key {payload.keyColumns?.join(' + ')} ·{' '}
          {(payload.changeCount ?? payload.changes?.length ?? 0).toLocaleString()} field changes. On approval each is re-checked
          against the current data and queued in the write-back outbox.
        </p>
        <table className="grid compact">
          <thead><tr><th>Safety</th><th>Field</th><th>Fix</th><th className="num">Records</th><th>Example</th></tr></thead>
          <tbody>
            {(payload.groups ?? []).map((g) => (
              <tr key={g.id}>
                <td><span className={`tag ${label[g.safety]?.[1] ?? ''}`}>{label[g.safety]?.[0] ?? g.safety}</span></td>
                <td><code>{g.column}</code></td>
                <td>{g.reason}</td>
                <td className="num">{g.count}</td>
                <td>{g.examples?.[0] && <><code>{shown(g.examples[0].old)}</code> → <code>{shown(g.examples[0].new)}</code></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (kind === 'code_mapping') {
    const codes = payload.codes ?? {};
    const name = (m) => (!m ? <span className="muted">(unmapped)</span> : m.codeValueId === null ? '∅ missing' : codes[m.codeValueId] ?? `#${m.codeValueId}`);
    const rows =
      action === 'delete'
        ? payload.values.map((v) => ({ value: v, from: previous?.[v], to: null }))
        : payload.mappings.map((m) => ({ value: m.value, from: previous?.[m.value], to: { codeValueId: m.codeValueId } }));
    return (
      <table className="grid compact diff">
        <thead>
          <tr><th>Source value ({change.target.source?.table}.{change.target.source?.column})</th><th>Current</th><th>Proposed</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.value}>
              <th><code>{r.value === '' ? '(empty)' : r.value.replace(/^ +| +$/g, (m) => '␣'.repeat(m.length))}</code></th>
              <td className={r.from ? 'old' : ''}>{name(r.from)}</td>
              <td className="new">{name(r.to)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (action === 'delete') {
    return (
      <table className="grid compact diff">
        <tbody>
          {Object.entries(previous ?? {}).map(([k, v]) => (
            <tr key={k} className="removed"><th>{k}</th><td>{show(v)}</td></tr>
          ))}
        </tbody>
      </table>
    );
  }

  const fields = Object.keys(payload);
  return (
    <table className="grid compact diff">
      <thead>
        <tr><th>Field</th>{previous && <th>Current</th>}<th>Proposed</th></tr>
      </thead>
      <tbody>
        {fields.map((k) => (
          <tr key={k}>
            <th>{k}</th>
            {previous && <td className="old">{show(previous[k])}</td>}
            <td className="new">{show(payload[k])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
