import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  DELIMITERS,
  NAME_RE,
  RESERVED_COLUMNS,
  columnNames,
  detectDelimiter,
  formatBytes,
  guessKind,
  nameProblems,
  parseCsv,
  suggestTableName,
} from '../lib/csv.js';

const FULL_PARSE_LIMIT = 25 * 1024 * 1024; // files up to this size are counted exactly
const SAMPLE_BYTES = 2 * 1024 * 1024;
const PREVIEW_ROWS = 10;
const ACCEPT = '.csv,.tsv,.txt,text/csv';
const NEW_SCHEMA = '\u0000new'; // schema picker value for "create a new schema"

/** Parses the file text into rows and summary facts for the "Check your data" step. */
function analyse(sample, { delimiter, hasHeader, complete, fileSize }) {
  const rows = parseCsv(sample, delimiter);
  // A partial sample may end mid-row; drop it.
  if (!complete && rows.length > 1) rows.pop();
  const width = Math.max(0, ...rows.map((r) => r.length));
  const data = hasHeader ? rows.slice(1) : rows;
  const expected = rows[0]?.length ?? 0;
  const ragged = data.filter((r) => r.length !== expected).length;
  const rowCount = complete ? data.length : Math.round((data.length * fileSize) / sample.length);
  return { rows, header: hasHeader ? rows[0] : null, data, width, ragged, rowCount, exact: complete };
}

function Step({ n, title, done, children }) {
  return (
    <section className={`upload-step${done ? ' done' : ''}`}>
      <h3>
        <span className="upload-step__n">{done ? '✓' : n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

export default function UploadCsv({ config }) {
  const ingest = config?.sources.ingest;
  const canCreateSchema = ingest?.canCreateSchema !== false;
  const maxMb = ingest?.maxMb ?? 100;
  const inputRef = useRef(null);

  const [file, setFile] = useState(null);
  const [sample, setSample] = useState(null); // { text, complete }
  const [fileError, setFileError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [delimiter, setDelimiter] = useState(',');
  const [hasHeader, setHasHeader] = useState(true);
  const [names, setNames] = useState([]);

  const [catalogs, setCatalogs] = useState([]);
  const [schemas, setSchemas] = useState([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [catalog, setCatalog] = useState('');
  const [schema, setSchema] = useState('');
  const [creatingSchema, setCreatingSchema] = useState(false); // typing a new schema name
  const [table, setTable] = useState('');
  const [existing, setExisting] = useState(null); // { exists, columns } for the current name
  const [mode, setMode] = useState(null);

  const [status, setStatus] = useState({ state: 'idle' });
  const [error, setError] = useState(null);

  // Dropping a file anywhere else on the page shouldn't navigate away.
  useEffect(() => {
    const stop = (e) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  useEffect(() => {
    api
      .ucCatalogs()
      .then((list) => {
        setCatalogs(list);
        const preferred = ingest?.defaultCatalog;
        setCatalog(list.some((c) => c.name === preferred) ? preferred : list[0]?.name ?? '');
      })
      .catch((err) => setError(`Could not list catalogs: ${err.message}`));
  }, [ingest?.defaultCatalog]);

  useEffect(() => {
    setSchemas([]);
    setSchema('');
    setCreatingSchema(false);
    if (!catalog) return;
    setSchemasLoading(true);
    api
      .ucSchemas(catalog)
      .then((list) => {
        setSchemas(list);
        const preferred = ingest?.defaultSchema;
        if (list.some((s) => s.name === preferred)) setSchema(preferred);
        else if (!list.length && canCreateSchema) {
          // An empty catalog: offer to create the usual bronze schema.
          setCreatingSchema(true);
          setSchema(preferred || 'bronze');
        } else setSchema(list[0]?.name ?? '');
      })
      .catch((err) => setError(`Could not list schemas: ${err.message}`))
      .finally(() => setSchemasLoading(false));
  }, [catalog, ingest?.defaultSchema, canCreateSchema]);

  const pickSchema = (value) => {
    if (value === NEW_SCHEMA) {
      setCreatingSchema(true);
      const preferred = ingest?.defaultSchema || 'bronze';
      setSchema(schemas.some((s) => s.name === preferred) ? '' : preferred);
    } else {
      setCreatingSchema(false);
      setSchema(value);
    }
  };

  const parsed = useMemo(
    () =>
      sample && analyse(sample.text, { delimiter, hasHeader, complete: sample.complete, fileSize: file.size }),
    [sample, delimiter, hasHeader, file],
  );

  // New file, separator or header setting: suggest column names again.
  useEffect(() => {
    setNames(parsed ? columnNames(parsed.header, parsed.width, hasHeader) : []);
  }, [parsed, hasHeader]);

  // Does the target table already exist?
  useEffect(() => {
    setExisting(null);
    setMode(null);
    if (!catalog || !NAME_RE.test(schema) || !NAME_RE.test(table)) return;
    // A schema that doesn't exist yet has no tables.
    if (!schemas.some((s) => s.name === schema)) return setExisting({ exists: false });
    let current = true;
    const timer = setTimeout(() => {
      api
        .ingestTable(catalog, schema, table)
        .then((r) => current && setExisting(r))
        .catch(() => current && setExisting({ exists: false })); // the load re-checks
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [catalog, schema, table, schemas]);

  const chooseFile = async (f) => {
    setError(null);
    setFileError(null);
    setStatus({ state: 'idle' });
    if (!f) return;
    if (!/\.(csv|tsv|txt)$/i.test(f.name)) {
      setFileError(`"${f.name}" doesn't look like a CSV file. Save it as .csv (in Excel: File → Save As → CSV UTF-8) and try again.`);
      return;
    }
    if (f.size === 0) return setFileError(`"${f.name}" is empty.`);
    if (f.size > maxMb * 1024 * 1024) {
      return setFileError(`"${f.name}" is ${formatBytes(f.size)}; the limit is ${maxMb} MB. Split it into smaller files.`);
    }
    const complete = f.size <= FULL_PARSE_LIMIT;
    const text = await (complete ? f : f.slice(0, SAMPLE_BYTES)).text();
    setFile(f);
    setSample({ text, complete });
    setDelimiter(detectDelimiter(text));
    setHasHeader(true);
    setTable(suggestTableName(f.name));
  };

  const reset = () => {
    setFile(null);
    setSample(null);
    setFileError(null);
    setStatus({ state: 'idle' });
    setError(null);
    setTable('');
    if (inputRef.current) inputRef.current.value = '';
  };

  const problems = useMemo(() => nameProblems(names), [names]);
  const missingForAppend = existing?.exists
    ? [...names, ...RESERVED_COLUMNS].filter((n) => !existing.columns.includes(n))
    : [];
  const tableNameError = table && !NAME_RE.test(table)
    ? 'Use lower-case letters, numbers and _ only, not starting with a number.'
    : null;
  const newSchema = creatingSchema && schema && !schemas.some((s) => s.name === schema);
  const schemaNameError = creatingSchema && schema && !NAME_RE.test(schema)
    ? 'Use lower-case letters, numbers and _ only, not starting with a number.'
    : null;
  const busy = ['creating-schema', 'uploading', 'loading'].includes(status.state);
  const ready =
    parsed?.data.length > 0 &&
    problems.size === 0 &&
    catalog &&
    schema &&
    !schemaNameError &&
    table &&
    !tableNameError &&
    existing !== null &&
    (!existing.exists || mode) &&
    !busy;

  const load = async () => {
    setError(null);
    try {
      if (newSchema) {
        setStatus({ state: 'creating-schema' });
        await api.ingestCreateSchema(catalog, schema);
        // From here on it's an existing schema, even if a later step fails.
        setSchemas((list) => [...list, { name: schema }].sort((a, b) => a.name.localeCompare(b.name)));
        setCreatingSchema(false);
      }
      setStatus({ state: 'uploading', progress: 0 });
      const upload = await api.ingestUpload(file, { catalog, schema }, (progress) =>
        setStatus({ state: 'uploading', progress }),
      );
      setStatus({ state: 'loading' });
      const result = await api.ingestLoad({
        catalog,
        schema,
        table,
        path: upload.path,
        loadId: upload.loadId,
        fileName: file.name,
        columns: names,
        delimiter,
        header: hasHeader,
        mode: existing?.exists ? mode : 'create',
      });
      setStatus({ state: 'done', result: { ...result, newSchema: newSchema ? `${catalog}.${schema}` : null } });
    } catch (err) {
      setStatus({ state: 'idle' });
      setError(err.message);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length > 1) setFileError('Drop one file at a time.');
    else chooseFile(files[0]);
  };

  if (status.state === 'done') {
    const { result } = status;
    return (
      <div className="page">
        <section className="page__main narrow">
          <div className="upload-done">
            <div className="upload-done__icon" aria-hidden="true">✓</div>
            <h2>
              {result.rows.toLocaleString()} row{result.rows === 1 ? '' : 's'}{' '}
              {result.mode === 'append' ? 'added to' : 'loaded into'} <code>{result.table}</code>
            </h2>
            <p className="muted">
              Every value is stored as text, exactly as it was in <strong>{file.name}</strong>. Each row also records
              which file it came from, when it was loaded, who loaded it and a load ID (<code>_source_file</code>,{' '}
              <code>_ingested_at</code>, <code>_ingested_by</code>, <code>_load_id</code>).
            </p>
            {parsed?.exact && result.rows !== parsed.rowCount && (
              <div className="notice warn">
                Your file appeared to have {parsed.rowCount.toLocaleString()} rows, but {result.rows.toLocaleString()} were
                loaded. Check the file for unusual quoting or line breaks.
              </div>
            )}
            {result.newSchema && (
              <p className="muted">
                The new schema <code>{result.newSchema}</code> was created for it.
              </p>
            )}
            <p className="muted small">
              Original file kept at <code>{result.path}</code>
            </p>
            <pre className="upload-sql">SELECT * FROM {result.table}{'\n'}WHERE _load_id = '{result.loadId}';</pre>
            <button className="btn primary" onClick={reset}>Upload another file</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="page__main narrow">
        <div className="page__header">
          <div>
            <h2>Upload a CSV file</h2>
            <p className="muted">
              Turn a spreadsheet export into a <strong>bronze</strong> table in Unity Catalog: a raw, unchanged copy that
              data engineers can clean up later.
            </p>
          </div>
        </div>

        {error && <div className="error inline">{error}</div>}

        <Step n={1} title="Choose your file" done={Boolean(file)}>
          {file ? (
            <div className="upload-file">
              <span className="upload-file__icon" aria-hidden="true">▤</span>
              <div className="grow">
                <strong>{file.name}</strong>
                <div className="muted small">{formatBytes(file.size)}</div>
              </div>
              <button className="btn" onClick={reset} disabled={busy}>Choose a different file</button>
            </div>
          ) : (
            <div
              className={`dropzone${dragging ? ' dragging' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
              onDragEnter={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setDragging(false)}
              onDrop={onDrop}
            >
              <div className="dropzone__icon" aria-hidden="true">⇪</div>
              <div className="dropzone__title">Drag and drop a CSV file here</div>
              <div className="muted">
                or <span className="link">browse your computer</span>
              </div>
              <div className="muted small">.csv, .tsv or .txt · up to {maxMb} MB</div>
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => chooseFile(e.target.files?.[0])}
          />
          {fileError && <div className="error inline">{fileError}</div>}
        </Step>

        {parsed && (
          <Step n={2} title="Check your data" done={parsed.data.length > 0 && problems.size === 0}>
            <div className="upload-facts">
              <div>
                <strong>{parsed.rowCount.toLocaleString()}</strong>
                <span className="muted"> {parsed.exact ? '' : 'about '}rows</span>
              </div>
              <div>
                <strong>{parsed.width}</strong>
                <span className="muted"> columns</span>
              </div>
              <label className="inline-field">
                Values separated by
                <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)} disabled={busy}>
                  {DELIMITERS.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
              </label>
              <label className="inline-field">
                <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} disabled={busy} />
                First row has column names
              </label>
            </div>

            {parsed.data.length === 0 && <div className="error inline">The file has no data rows.</div>}
            {parsed.width === 1 && parsed.data.length > 0 && (
              <div className="notice warn">
                Only one column was found. If your data has more, try a different separator above.
              </div>
            )}
            {parsed.ragged > 0 && (
              <div className="notice warn">
                {parsed.ragged.toLocaleString()} row{parsed.ragged === 1 ? ' has' : 's have'} a different number of values
                than the first row. They will still be loaded; missing values are left blank.
              </div>
            )}

            <p className="muted small">
              Column names have been tidied so the database accepts them. You can change any of them.
            </p>
            <div className="grid-scroll">
              <table className="grid compact">
                <thead>
                  <tr>
                    {hasHeader && <th>In your file</th>}
                    <th>Column name in table</th>
                    <th>Looks like</th>
                    <th>Examples</th>
                  </tr>
                </thead>
                <tbody>
                  {names.map((name, i) => {
                    const values = parsed.data.slice(0, 200).map((r) => r[i] ?? '');
                    const examples = [...new Set(values.filter((v) => v.trim()))].slice(0, 3);
                    return (
                      <tr key={i}>
                        {hasHeader && <td className="muted">{parsed.header?.[i] || <em>(blank)</em>}</td>}
                        <td>
                          <input
                            className={problems.has(i) ? 'invalid' : ''}
                            value={name}
                            disabled={busy}
                            aria-label={`Name for column ${i + 1}`}
                            onChange={(e) => setNames(names.map((n, j) => (j === i ? e.target.value : n)))}
                          />
                          {problems.has(i) && <div className="field-error">{problems.get(i)}</div>}
                        </td>
                        <td><span className="tag">{guessKind(values)}</span></td>
                        <td className="upload-examples">{examples.join(' · ')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <details className="upload-preview">
              <summary>Preview the first {Math.min(PREVIEW_ROWS, parsed.data.length)} rows</summary>
              <div className="grid-scroll">
                <table className="grid compact">
                  <thead>
                    <tr>{names.map((n, i) => <th key={i}>{n}</th>)}</tr>
                  </thead>
                  <tbody>
                    {parsed.data.slice(0, PREVIEW_ROWS).map((r, k) => (
                      <tr key={k}>{names.map((_, i) => <td key={i}>{r[i]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </Step>
        )}

        {parsed && (
          <Step n={3} title="Choose where to save it" done={Boolean(ready)}>
            <div className="upload-target">
              <label className="field">
                <span>Catalog</span>
                <select value={catalog} onChange={(e) => setCatalog(e.target.value)} disabled={busy}>
                  {!catalogs.length && <option value="">Loading…</option>}
                  {catalogs.map((c) => <option key={c.name}>{c.name}</option>)}
                </select>
              </label>
              <div className="field">
                <label htmlFor="upload-schema">Schema</label>
                <select
                  id="upload-schema"
                  value={creatingSchema ? NEW_SCHEMA : schema}
                  onChange={(e) => pickSchema(e.target.value)}
                  disabled={busy || schemasLoading || !catalog}
                >
                  {schemasLoading && <option value="">Loading…</option>}
                  {!schemasLoading && !schemas.length && !canCreateSchema && <option value="">No schemas</option>}
                  {schemas.map((s) => <option key={s.name}>{s.name}</option>)}
                  {canCreateSchema && !schemasLoading && catalog && (
                    <option value={NEW_SCHEMA}>+ Create a new schema…</option>
                  )}
                </select>
                {creatingSchema && (
                  <>
                    <input
                      className={schemaNameError ? 'invalid' : ''}
                      value={schema}
                      placeholder="New schema name, e.g. bronze"
                      aria-label="New schema name"
                      disabled={busy}
                      autoFocus
                      onChange={(e) => setSchema(e.target.value)}
                    />
                    {schemaNameError && <span className="field-error">{schemaNameError}</span>}
                    {!schemaNameError && schema && !newSchema && (
                      <span className="muted small">This schema already exists and will be used.</span>
                    )}
                  </>
                )}
              </div>
              <label className="field">
                <span>Table name</span>
                <input
                  className={tableNameError ? 'invalid' : ''}
                  value={table}
                  disabled={busy}
                  onChange={(e) => setTable(e.target.value)}
                />
                {tableNameError && <span className="field-error">{tableNameError}</span>}
              </label>
            </div>
            {catalog && schema && table && !tableNameError && !schemaNameError && (
              <p className="muted">
                Will be saved as <code>{catalog}.{schema}.{table}</code>
                {newSchema && <span className="tag ok">new schema</span>}
                {existing && !existing.exists && <span className="tag ok">new table</span>}
              </p>
            )}
            {existing?.exists && (
              <div className="upload-exists">
                <strong>A table with this name already exists.</strong> What should happen?
                <label className={missingForAppend.length ? 'disabled' : ''}>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === 'append'}
                    disabled={busy || missingForAppend.length > 0}
                    onChange={() => setMode('append')}
                  />
                  Add these rows to it
                  {missingForAppend.length > 0 && (
                    <span className="muted small">
                      {' '}(not possible: the table has no column{missingForAppend.length > 1 ? 's' : ''}{' '}
                      {missingForAppend.slice(0, 5).join(', ')}{missingForAppend.length > 5 ? '…' : ''})
                    </span>
                  )}
                </label>
                <label>
                  <input type="radio" name="mode" checked={mode === 'replace'} disabled={busy} onChange={() => setMode('replace')} />
                  Replace it with this file <span className="muted small">(its current rows are removed)</span>
                </label>
                <div className="muted small">Or type a different table name above.</div>
              </div>
            )}
          </Step>
        )}

        {parsed && (
          <div className="upload-actions">
            <button className="btn primary large" disabled={!ready} onClick={load}>
              {status.state === 'creating-schema'
                ? 'Creating schema…'
                : status.state === 'uploading'
                  ? `Uploading… ${Math.round((status.progress ?? 0) * 100)}%`
                  : status.state === 'loading'
                    ? 'Creating table…'
                    : 'Load to bronze table'}
            </button>
            {busy && (
              <div className="upload-progress">
                <div
                  className={status.state === 'uploading' ? '' : 'indeterminate'}
                  style={status.state === 'uploading' ? { width: `${(status.progress ?? 0) * 100}%` } : undefined}
                />
              </div>
            )}
            {status.state !== 'uploading' && busy && (
              <p className="muted small">This can take a minute if the SQL warehouse is starting up.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
