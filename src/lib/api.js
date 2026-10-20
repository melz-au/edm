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

  // Data quality. `system` is 'uc' | 'lakebase'; `tableName` as sourceTableName().
  dqSuggest: (system, table) =>
    get('dq/suggest', { system, catalog: table.catalog, schema: table.schema, table: table.name }),
  dqRules: (system, tableName) => get('dq/rules', { system, table: tableName }),
  dqAddRules: (system, tableName, rules) => post('dq/rules', { system, table: tableName, rules }),
  dqDeleteRule: (id) => request('DELETE', `dq/rules/${id}`),
  dqRun: (system, table) => post('dq/run', { system, catalog: table.catalog, schema: table.schema, table: table.name }),
  dqSummary: (system, prefix) => get('dq/summary', { system, prefix }),

  // Write-back to source systems.
  writebackProposals: (system, table, { key, areaCode } = {}) =>
    get('writeback/proposals', { system, catalog: table.catalog, schema: table.schema, table: table.name, key, areaCode }),
  outbox: (params) => get('writeback/outbox', params),
  outboxCounts: () => get('writeback/outbox/counts'),
  outboxAck: (ids, status, response) => post('writeback/outbox/ack', { ids, status, response }),
  outboxExportUrl: (format, status = 'pending') => `./api/writeback/outbox/export?format=${format}&status=${status}`,

  // Saved data models. `scope` as scopeName() in proposals.js.
  models: (source, scope) => get('models', { source, scope }),
  model: (id) => get(`models/${id}`),
  createModel: (model) => post('models', model),
  saveModel: (id, model) => request('PUT', `models/${id}`, {}, model),
  deleteModel: (id) => request('DELETE', `models/${id}`),
  modelVersions: (id) => get(`models/${id}/versions`),
  modelVersion: (id, version) => get(`models/${id}/versions/${version}`),

  codeSets: () => get('refdata/code-sets'),
  codeSet: (id) => get(`refdata/code-sets/${id}`),
  linkedCodeSets: (system, table) => get('refdata/linked', { system, table }),
  mappings: (codeSetId) => get(`refdata/code-sets/${codeSetId}/mappings`),
  sourceMappings: (system, table, column) => get('refdata/mappings', { system, table, column }),
  suggestMappings: (codeSetId, values) => post(`refdata/code-sets/${codeSetId}/suggest`, { values }),
  publishStatus: () => get('refdata/publish'),
  savePublishSettings: (settings) => request('PUT', 'refdata/publish/settings', {}, settings),
  publishNow: () => post('refdata/publish'),
  changes: (params) => get('refdata/changes', params),
  pendingCount: () => get('refdata/pending-count'),
  audit: () => get('refdata/audit'),
  proposeChange: (change) => post('refdata/changes', change),
  reviewChange: (id, decision, comment) => post(`refdata/changes/${id}/review`, { decision, comment }),
  cancelChange: (id) => post(`refdata/changes/${id}/cancel`),

  ingestTable: (catalog, schema, table) => get('ingest/table', { catalog, schema, table }),
  ingestLoad: (load) => post('ingest/load', load),
  ingestCreateSchema: (catalog, schema) => post('ingest/schema', { catalog, schema }),
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
