// Write-back of approved corrections to source systems, through an outbox.
//
// 1. Proposals: corrections.js builds fixes from a table's data quality rules
//    and approved code mappings, grouped by column, fix and safety.
// 2. A person selects groups and submits a "writeback" change request. The
//    server rebuilds the proposals itself and keeps only the selected groups,
//    so nothing a browser sends is written back.
// 3. A steward approves. Each change is re-checked against the current data;
//    changes whose value moved on are dropped. The rest become outbox
//    entries, one per record: an API call (method, path, body) carrying the
//    new values and the expected old values for optimistic concurrency.
// 4. An integration (job, middleware) reads pending entries, calls the source
//    system's API, and acknowledges each as sent or failed.
//
// The app never calls the source system itself.
import * as lakebase from './lakebase.js';
import * as refdata from './refdata.js';
import * as dqstore from './dqstore.js';
import * as pii from './pii.js';
import { buildCorrections } from './corrections.js';

const S = lakebase.ident(refdata.SCHEMA);
export const DEFAULT_ROW_LIMIT = 100_000;

let ready = null;
function ensure() {
  if (!ready) {
    ready = refdata
      .ensureSchema()
      .then(() =>
        lakebase.query(`
          CREATE TABLE IF NOT EXISTS ${S}.writeback_outbox (
            id                serial PRIMARY KEY,
            change_request_id int REFERENCES ${S}.change_request(id),
            source_system     text NOT NULL,
            source_table      text NOT NULL,
            record_key        jsonb NOT NULL,
            method            text NOT NULL,
            path              text NOT NULL,
            body              jsonb NOT NULL,
            status            text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
            attempts          int NOT NULL DEFAULT 0,
            last_response     text,
            created_at        timestamptz NOT NULL DEFAULT now(),
            updated_at        timestamptz NOT NULL DEFAULT now(),
            updated_by        text
          );
          CREATE INDEX IF NOT EXISTS writeback_outbox_status_idx ON ${S}.writeback_outbox (status, id);`),
      )
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}

// --- proposals --------------------------------------------------------------

/**
 * `source` = { system, name, exec, ref, dialect } from the table context.
 * Returns rows read and the corrections, excluding records whose key is ambiguous.
 */
export async function proposals(source, { keyColumns, areaCode, limit = DEFAULT_ROW_LIMIT }) {
  const [rules, mappings] = await Promise.all([
    dqstore.listRules(source.system, source.name),
    refdata.mappingsForSource(source.system, source.name),
  ]);
  if (!rules.length) {
    throw Object.assign(new Error('Add data quality rules for this table first; corrections are derived from them.'), { status: 400 });
  }
  const rows = await source.exec(`SELECT * FROM ${source.ref} LIMIT ${Number(limit)}`);

  // A key that maps to rows with different contents can't be corrected safely.
  const byKey = new Map();
  for (const r of rows) {
    const k = JSON.stringify(keyColumns.map((c) => r[c]));
    const sig = JSON.stringify(r);
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(sig);
  }
  const ambiguous = new Set([...byKey].filter(([, sigs]) => sigs.size > 1).map(([k]) => k));
  const missingKey = rows.filter((r) => keyColumns.some((c) => r[c] === null || String(r[c]).trim() === '')).length;
  const usable = rows.filter((r) => !ambiguous.has(JSON.stringify(keyColumns.map((c) => r[c]))) && keyColumns.every((c) => r[c] !== null && String(r[c]).trim() !== ''));

  const result = buildCorrections({ rows: usable, rules, keyColumns, mappings, options: { areaCode } });
  // Personal-data columns (from rules or names), so displays can mask them.
  const piiTypes = {};
  for (const r of rules) if (r.params?.piiType) piiTypes[r.column_name] = r.params.piiType;
  for (const c of Object.keys(rows[0] ?? {})) {
    const t = pii.detectByName(c);
    if (t && !piiTypes[c]) piiTypes[c] = t;
  }
  return { ...result, piiTypes, rowsRead: rows.length, truncated: rows.length >= limit, ambiguousKeys: ambiguous.size, missingKey };
}

/** Masks values of personal-data columns for display. `piiTypes`: { column: type }. */
// Keeps separators and the last two letters/digits so a format fix stays visible:
// "545124" → "••••24", "545-124" → "•••-•24".
export function maskKeepingFormat(v) {
  const s = String(v);
  const positions = [...s].map((ch, i) => (/[A-Za-z0-9]/.test(ch) ? i : -1)).filter((i) => i >= 0);
  const keep = new Set(positions.slice(-2));
  return [...s].map((ch, i) => (/[A-Za-z0-9]/.test(ch) && !keep.has(i) ? '•' : ch)).join('');
}

export function maskChange(c, piiTypes = {}) {
  const t = piiTypes[c.column] ?? pii.detectByName(c.column);
  if (!t) return c;
  const m = (v) => (v === null || v === undefined || v === '' ? v : t === 'email' ? pii.mask(v, t) : maskKeepingFormat(v));
  return { ...c, old: m(c.old), new: m(c.new), key: c.key };
}

export function maskGroups(groups, piiTypes) {
  return groups.map((g) => ({ ...g, examples: g.examples.map((e) => maskChange({ ...e, column: g.column }, piiTypes)) }));
}

// --- API call shape ---------------------------------------------------------------

/** "/customers/{CUST_NO}" + { CUST_NO: "C300 380" } → "/customers/C300%20380". */
export function renderPath(template, key) {
  return template.replace(/\{([^}]+)\}/g, (_, name) => {
    if (!(name in key)) throw Object.assign(new Error(`Path template uses {${name}}, which isn't a key column`), { status: 400 });
    return encodeURIComponent(String(key[name]).trim());
  });
}

/** One outbox entry per record: the new values plus the expected old values. */
export function outboxEntries(changes, { method, pathTemplate }) {
  const byRecord = new Map();
  for (const c of changes) {
    const k = JSON.stringify(c.key);
    if (!byRecord.has(k)) byRecord.set(k, { key: c.key, set: {}, expect: {}, fixes: {} });
    const r = byRecord.get(k);
    r.set[c.column] = c.new;
    r.expect[c.column] = c.old;
    r.fixes[c.column] = c.fix;
  }
  return [...byRecord.values()].map((r) => ({
    record_key: r.key,
    method,
    path: renderPath(pathTemplate, r.key),
    body: { set: r.set, expect: r.expect, fixes: r.fixes },
  }));
}

// --- change kind ------------------------------------------------------------------

let contextFor = null; // (target) → table context, wired by index.js

export function configure({ tableContext }) {
  contextFor = tableContext;
}

refdata.registerChangeKind('writeback', {
  async prepare({ action, target, payload }, user) {
    if (action !== 'create') throw Object.assign(new Error('Write-back changes can only be created'), { status: 400 });
    const keyColumns = (payload.keyColumns ?? []).map(String);
    const groupIds = new Set((payload.groupIds ?? []).map(String));
    const method = ['PATCH', 'PUT', 'POST'].includes(payload.method) ? payload.method : 'PATCH';
    const pathTemplate = String(payload.pathTemplate ?? '').trim();
    if (!keyColumns.length) throw Object.assign(new Error('Choose the key column(s) that identify a record in the source system'), { status: 400 });
    if (!groupIds.size) throw Object.assign(new Error('Select at least one group of corrections'), { status: 400 });
    if (!pathTemplate.startsWith('/')) throw Object.assign(new Error('The API path template must start with /'), { status: 400 });

    const ctx = await contextFor(target);
    for (const k of keyColumns) {
      if (!ctx.columns.some((c) => c.name === k)) throw Object.assign(new Error(`Unknown key column ${k}`), { status: 400 });
    }
    // Rebuild from the data; take only the selected groups, never manual ones.
    const built = await proposals(ctx, { keyColumns, areaCode: payload.areaCode });
    const changes = built.changes.filter((c) => c.safety !== 'manual' && groupIds.has(`${c.column}|${c.fix}|${c.safety}`));
    if (!changes.length) throw Object.assign(new Error('None of the selected corrections apply any more'), { status: 409 });
    renderPath(pathTemplate, changes[0].key); // validates the template early

    const records = new Set(changes.map((c) => JSON.stringify(c.key))).size;
    const groups = built.groups.filter((g) => groupIds.has(g.id));
    const review = changes.filter((c) => c.safety === 'review').length;
    return {
      target: { system: target.system, catalog: target.catalog ?? null, schema: target.schema, table: target.table, name: ctx.name },
      payload: { keyColumns, method, pathTemplate, areaCode: payload.areaCode ?? null, groups, changes, piiTypes: built.piiTypes },
      previous: null,
      summary: `Write back ${changes.length} correction${changes.length === 1 ? '' : 's'} to ${records} record${records === 1 ? '' : 's'} of ${ctx.name}${review ? ` (${review} need review)` : ''}`,
    };
  },

  async apply(db, cr) {
    await ensure();
    const { payload, target } = cr;
    const ctx = await contextFor(target);
    // Re-read the affected records; drop changes whose value has moved on.
    const rows = await ctx.exec(`SELECT * FROM ${ctx.ref} LIMIT ${DEFAULT_ROW_LIMIT}`);
    const current = new Map(rows.map((r) => [JSON.stringify(payload.keyColumns.map((k) => r[k])), r]));
    const fresh = [];
    let stale = 0;
    for (const c of payload.changes) {
      const row = current.get(JSON.stringify(payload.keyColumns.map((k) => c.key[k])));
      if (row && String(row[c.column] ?? '') === String(c.old ?? '')) fresh.push(c);
      else stale += 1;
    }
    const entries = outboxEntries(fresh, payload);
    for (const e of entries) {
      await db.query(
        `INSERT INTO ${S}.writeback_outbox (change_request_id, source_system, source_table, record_key, method, path, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [cr.id, target.system, target.name, e.record_key, e.method, e.path, e.body],
      );
    }
    return {
      target,
      before: null,
      after: { outboxEntries: entries.length, changes: fresh.length, staleChangesDropped: stale },
    };
  },
});

// --- outbox -----------------------------------------------------------------------

export async function listOutbox({ status, table, limit = 500 } = {}) {
  await ensure();
  const where = [];
  const params = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (table) {
    params.push(table);
    where.push(`source_table = $${params.length}`);
  }
  // pii_types: personal-data columns recorded with the change request, for masking on screen.
  const { rows } = await lakebase.query(
    `SELECT o.*, c.payload->'piiTypes' AS pii_types
     FROM ${S}.writeback_outbox o LEFT JOIN ${S}.change_request c ON c.id = o.change_request_id
     ${where.length ? `WHERE ${where.map((w) => `o.${w}`).join(' AND ')}` : ''}
     ORDER BY o.id LIMIT ${Math.min(Number(limit) || 500, 10_000)}`,
    params,
  );
  return rows;
}

export async function outboxCounts() {
  await ensure();
  const { rows } = await lakebase.query(`SELECT status, count(*)::int AS n FROM ${S}.writeback_outbox GROUP BY status`);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Integration acknowledgement: mark entries sent / failed (retryable) / cancelled. */
export async function acknowledge(ids, { status, response }, user) {
  await ensure();
  if (!['sent', 'failed', 'cancelled', 'pending'].includes(status)) {
    throw Object.assign(new Error('status must be sent, failed, cancelled or pending'), { status: 400 });
  }
  const { rows } = await lakebase.query(
    `UPDATE ${S}.writeback_outbox
     SET status = $2, last_response = $3, updated_at = now(), updated_by = $4,
         attempts = attempts + CASE WHEN $2 IN ('sent', 'failed') THEN 1 ELSE 0 END
     WHERE id = ANY($1::int[]) AND status <> 'sent' RETURNING id, status`,
    [ids.map(Number), status, response ?? null, user],
  );
  return rows;
}

/** CSV of outbox entries: one row per changed field, for teams without an API integration. */
export function toCsv(entries) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['outbox_id', 'source_table', 'record_key', 'method', 'path', 'field', 'expected_old_value', 'new_value', 'fix', 'status'].join(',')];
  for (const e of entries) {
    for (const [field, value] of Object.entries(e.body.set)) {
      lines.push([e.id, e.source_table, e.record_key, e.method, e.path, field, e.body.expect[field], value, e.body.fixes?.[field], e.status].map(esc).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

/** A writeback change request as shown to people: counts plus masked examples. */
export function forDisplay(cr) {
  if (cr.kind !== 'writeback') return cr;
  const { changes = [], piiTypes = {}, groups = [] } = cr.payload ?? {};
  return {
    ...cr,
    payload: {
      ...cr.payload,
      changeCount: changes.length,
      changes: changes.slice(0, 50).map((c) => maskChange(c, piiTypes)),
      groups: maskGroups(groups, piiTypes),
    },
  };
}

/** An outbox entry with personal-data fields masked (format kept), for display. */
export function maskEntry(e) {
  const set = {};
  const expect = {};
  for (const [field, value] of Object.entries(e.body.set)) {
    const m = maskChange({ column: field, old: e.body.expect[field], new: value }, e.pii_types ?? {});
    set[field] = m.new;
    expect[field] = m.old;
  }
  return { ...e, body: { ...e.body, set, expect } };
}
