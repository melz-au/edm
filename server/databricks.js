// Minimal Databricks REST client.
//
// Authentication order:
//   1. The signed-in user's token forwarded by Databricks Apps
//      (x-forwarded-access-token), only when ERD_USE_USER_TOKEN=true.
//   2. The app's service principal via OAuth M2M (DATABRICKS_CLIENT_ID /
//      DATABRICKS_CLIENT_SECRET), which Databricks Apps injects automatically.
//   3. A personal access token (DATABRICKS_TOKEN) for local development.

export function getHost() {
  const raw = process.env.DATABRICKS_HOST;
  if (!raw) return null;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

let cachedM2M = null; // { token, expiresAt }

export async function getServicePrincipalToken() {
  const host = getHost();
  const clientId = process.env.DATABRICKS_CLIENT_ID;
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;

  if (host && clientId && clientSecret) {
    if (cachedM2M && cachedM2M.expiresAt - Date.now() > 60_000) {
      return cachedM2M.token;
    }
    const res = await fetch(`${host}/oidc/v1/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all-apis' }),
    });
    if (!res.ok) {
      throw new Error(`OAuth token request failed (${res.status}): ${await res.text()}`);
    }
    const body = await res.json();
    cachedM2M = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return cachedM2M.token;
  }

  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  return null;
}

export function isConfigured() {
  return Boolean(
    getHost() &&
      ((process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET) ||
        process.env.DATABRICKS_TOKEN),
  );
}

export class DatabricksError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * GET a Databricks REST endpoint. When `userToken` (from x-forwarded-access-token)
 * is given it takes precedence, so Unity Catalog permissions are evaluated as the user.
 */
export async function apiGet(path, params = {}, userToken = null) {
  const host = getHost();
  if (!host) throw new DatabricksError('DATABRICKS_HOST is not set', 500);

  const token = userToken || (await getServicePrincipalToken());
  if (!token) {
    throw new DatabricksError(
      'No Databricks credentials found. Set DATABRICKS_CLIENT_ID/DATABRICKS_CLIENT_SECRET or DATABRICKS_TOKEN.',
      500,
    );
  }

  const url = new URL(`${host}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let message = await res.text();
    try {
      message = JSON.parse(message).message ?? message;
    } catch {
      // keep raw text
    }
    if (userToken && /scope/i.test(message)) {
      message +=
        ' (the signed-in user token lacks the required scopes: add catalog.catalogs:read, catalog.schemas:read and catalog.tables:read under the app\'s user authorization, or unset ERD_USE_USER_TOKEN to use the service principal)';
    }
    throw new DatabricksError(`Databricks API ${path} failed (${res.status}): ${message}`, res.status);
  }
  return res.json();
}

/** POST JSON to a Databricks REST endpoint (same auth rules as apiGet). */
export async function apiPost(path, body, userToken = null) {
  const host = getHost();
  if (!host) throw new DatabricksError('DATABRICKS_HOST is not set', 500);
  const token = userToken || (await getServicePrincipalToken());
  if (!token) throw new DatabricksError('No Databricks credentials found.', 500);
  const res = await fetch(`${host}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = await res.text();
    try {
      message = JSON.parse(message).message ?? message;
    } catch {
      // keep raw text
    }
    throw new DatabricksError(`Databricks API ${path} failed (${res.status}): ${message}`, res.status);
  }
  return res.json();
}

/** Follows next_page_token pagination and concatenates `key` arrays. */
export async function apiGetAll(path, key, params = {}, userToken = null) {
  const items = [];
  let pageToken;
  do {
    const body = await apiGet(path, { ...params, page_token: pageToken }, userToken);
    items.push(...(body[key] ?? []));
    pageToken = body.next_page_token;
  } while (pageToken);
  return items;
}
