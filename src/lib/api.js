async function request(method, path, params = {}, body) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  const res = await fetch(`./api/${path}${qs ? `?${qs}` : ''}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const get = (path, params) => request('GET', path, params);
const post = (path, body) => request('POST', path, {}, body ?? {});

export const api = {
  config: () => get('config'),
  me: () => get('me'),
  ucCatalogs: () => get('uc/catalogs'),
  ucSchemas: (catalog) => get('uc/schemas', { catalog }),
  ucErd: (catalog, schema, infer) => get('uc/erd', { catalog, schema, infer }),
  lakebaseSchemas: () => get('lakebase/schemas'),
  lakebaseErd: (schema, infer) => get('lakebase/erd', { schema, infer }),
  demoErd: (infer) => get('demo/erd', { infer }),

  // `table` is a model table ({ catalog?, schema, name }); `source` is 'uc' | 'lakebase'.
  profile: (source, table) =>
    source === 'uc'
      ? get('uc/profile', { catalog: table.catalog, schema: table.schema, table: table.name })
      : get('lakebase/profile', { schema: table.schema, table: table.name }),
  distinctValues: (source, table, column) =>
    source === 'uc'
      ? get('uc/values', { catalog: table.catalog, schema: table.schema, table: table.name, column })
      : get('lakebase/values', { schema: table.schema, table: table.name, column }),
  rows: (schema, table, params) => get('lakebase/rows', { schema, table, ...params }),

  codeSets: () => get('refdata/code-sets'),
  codeSet: (id) => get(`refdata/code-sets/${id}`),
  linkedCodeSets: (system, table) => get('refdata/linked', { system, table }),
  mappings: (codeSetId) => get(`refdata/code-sets/${codeSetId}/mappings`),
  sourceMappings: (system, table, column) => get('refdata/mappings', { system, table, column }),
  suggestMappings: (codeSetId, values) => post(`refdata/code-sets/${codeSetId}/suggest`, { values }),
  changes: (params) => get('refdata/changes', params),
  pendingCount: () => get('refdata/pending-count'),
  audit: () => get('refdata/audit'),
  proposeChange: (change) => post('refdata/changes', change),
  reviewChange: (id, decision, comment) => post(`refdata/changes/${id}/review`, { decision, comment }),
  cancelChange: (id) => post(`refdata/changes/${id}/cancel`),

  ingestTable: (catalog, schema, table) => get('ingest/table', { catalog, schema, table }),
  ingestLoad: (load) => post('ingest/load', load),
  /** Sends the raw file to the landing volume, reporting progress as 0–1. */
  ingestUpload: (file, { catalog, schema }, onProgress) =>
    new Promise((resolve, reject) => {
      const qs = new URLSearchParams({ catalog, schema, fileName: file.name });
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `./api/ingest/upload?${qs}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          // not JSON
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed: the connection was interrupted.'));
      xhr.send(file);
    }),
};

/** Identifies a model table in refdata links: "maximo.asset" or "main.sales.orders". */
export const sourceTableName = (source, table) =>
  source === 'uc' ? `${table.catalog}.${table.schema}.${table.name}` : `${table.schema}.${table.name}`;
