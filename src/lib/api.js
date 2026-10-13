async function get(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  const res = await fetch(`./api/${path}${qs ? `?${qs}` : ''}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const api = {
  config: () => get('config'),
  ucCatalogs: () => get('uc/catalogs'),
  ucSchemas: (catalog) => get('uc/schemas', { catalog }),
  ucErd: (catalog, schema, infer) => get('uc/erd', { catalog, schema, infer }),
  lakebaseSchemas: () => get('lakebase/schemas'),
  lakebaseErd: (schema, infer) => get('lakebase/erd', { schema, infer }),
  demoErd: (infer) => get('demo/erd', { infer }),
};
