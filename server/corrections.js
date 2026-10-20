// Proposes corrections to source data that can be written back to the source
// system, each classified by how safe it is to send without a person:
//
//   safe    lossless and deterministic, or backed by an approved code mapping:
//           trimming whitespace, folding spelling variants of the column's own
//           codes, reformatting the same digits/characters into the column's
//           dominant format, unambiguous dates into the dominant date format
//   review  very likely right but resting on an assumption (a lost leading
//           zero, a missing area code, a two-digit year, a near spelling)
//   manual  not fixable from the data (lost digits, placeholders, missing
//           values, conflicts) — listed with the reason, never written back
//
// Write-back always uses the source system's own vocabulary: a value mapped to
// a standard code becomes the source's most common value for that code
// (HydroBill "act" → "A", not the CRM's "ACTIVE").

import { normalise, suggestMappings } from './mapping.js';
import { shapeOf } from './dq.js';

export const SAFETY = ['safe', 'review', 'manual'];

const MISSING = new Set(['', 'NULL', 'N/A', 'NA', '-', 'UNKNOWN', 'NONE', 'NIL']);
const isMissing = (v) => v === null || v === undefined || MISSING.has(String(v).trim().toUpperCase());
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// --- helpers ------------------------------------------------------------------

/** Rewrites `digits` into the layout of `shape` (e.g. "9999 999 999"), or null if lengths differ. */
export function fitShape(chars, shape) {
  const slots = [...shape].filter((c) => c === '9' || c === 'A' || c === 'a').length;
  if (slots !== chars.length) return null;
  let i = 0;
  let out = '';
  for (const c of shape) {
    if (c === '9' || c === 'A') out += chars[i++].toUpperCase();
    else if (c === 'a') out += chars[i++].toLowerCase();
    else out += c;
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

function parseDate(v) {
  const s = String(v).trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return { y: +m[1], mo: +m[2], d: +m[3], ambiguous: null };
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) {
    const a = +m[1];
    const b = +m[2];
    if (b > 12 && a <= 12) return { y: +m[3], mo: a, d: b, ambiguous: 'month and day were swapped' };
    return { y: +m[3], mo: b, d: a, ambiguous: null };
  }
  if ((m = /^(\d{1,2})-([A-Z]{3})-(\d{2})$/i.exec(s))) {
    const mo = MONTHS.indexOf(m[2].toUpperCase()) + 1;
    if (!mo) return null;
    return { y: null, yy: +m[3], mo, d: +m[1], ambiguous: 'two-digit year' };
  }
  return null;
}

function validDate({ y, mo, d }) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function formatDate(p, shapePattern) {
  if (shapePattern === '9999-99-99') return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  if (shapePattern === '99/99/9999') return `${pad(p.d)}/${pad(p.mo)}/${p.y}`;
  return null;
}

/** The source's own value for each standard code: its most common mapped value. */
function canonicalByCode(mappings, counts) {
  const best = new Map();
  for (const m of mappings) {
    if (m.code_value_id === null) continue;
    const n = counts.get(m.source_value) ?? 0;
    const cur = best.get(m.code_value_id);
    if (!cur || n > cur.n) best.set(m.code_value_id, { value: m.source_value, n });
  }
  return best;
}

// --- per-rule fixers ----------------------------------------------------------

/**
 * Proposes a fix for one value under one rule.
 * Returns { value, safety, fix, reason } or null when the value is fine.
 */
export function proposeFix(value, rule, ctx = {}) {
  if (isMissing(value)) {
    return rule.rule_type === 'not_null'
      ? { value: null, safety: 'manual', fix: 'missing_value', reason: 'value is missing; only the customer or source can supply it' }
      : null;
  }
  const raw = String(value);
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  const p = rule.params ?? {};

  if (rule.rule_type === 'allowed_values') {
    const allowed = ctx.allowed ?? p.values ?? [];
    if (allowed.includes(raw)) return null;
    if (allowed.includes(trimmed)) return { value: trimmed, safety: 'safe', fix: 'trim', reason: 'extra whitespace' };
    if (ctx.mappedTo?.has(raw)) {
      const target = ctx.mappedTo.get(raw);
      if (target === null) return { value: null, safety: 'manual', fix: 'maps_to_missing', reason: 'approved mapping says this means "missing"' };
      if (target !== raw) return { value: target, safety: 'safe', fix: 'standardise_code', reason: 'approved code mapping' };
      return null;
    }
    const same = allowed.filter((a) => normalise(a) === normalise(raw));
    if (same.length === 1) return { value: same[0], safety: 'safe', fix: 'standardise_code', reason: 'same code, different spelling or case' };
    // Abbreviations, initials, near spellings: likely, but a person should confirm.
    const [guess] = suggestMappings([raw], allowed.map((code, i) => ({ id: i, code, label: code })));
    if (guess?.codeValueId !== null && guess?.codeValueId !== undefined && guess.score >= 0.6) {
      return { value: allowed[guess.codeValueId], safety: 'review', fix: 'standardise_code', reason: `${guess.reason.replace(/"[^"]*"$/, `"${allowed[guess.codeValueId]}"`)}` };
    }
    return { value: null, safety: 'manual', fix: 'unknown_code', reason: `"${raw}" isn't a known code${guess?.reason?.startsWith('ambiguous') ? ` (${guess.reason})` : ''}` };
  }

  if (rule.rule_type === 'format') {
    const re = new RegExp(p.regex);
    // A date can have the right shape and still not be a date (10/30/1965).
    if (re.test(raw) && p.pattern === '99/99/9999') {
      const parsed = parseDate(raw);
      if (parsed && validDate(parsed) && parsed.ambiguous) {
        return { value: formatDate(parsed, p.pattern), safety: 'review', fix: 'date_format', reason: parsed.ambiguous };
      }
      if (!parsed || !validDate(parsed)) return { value: null, safety: 'manual', fix: 'invalid_date', reason: 'not a real calendar date' };
      return null;
    }
    // Common domain typos still pass an email format check (example.con).
    if (p.piiType === 'email' && /\.(con|ogr|nte|cmo|ocm)$/i.test(trimmed)) {
      const typo = trimmed.toLowerCase().replace(/\.(con|cmo|ocm)$/, '.com').replace(/\.ogr$/, '.org').replace(/\.nte$/, '.net');
      return { value: typo, safety: 'review', fix: 'domain_typo', reason: 'likely domain typo' };
    }
    if (re.test(raw)) return null;
    if (re.test(trimmed)) return { value: trimmed, safety: 'safe', fix: 'trim', reason: 'extra whitespace' };
    const shape = ctx.shape ?? p.pattern;

    if (p.piiType === 'email' || /@/.test(raw)) {
      const lower = trimmed.toLowerCase();
      if (re.test(lower)) return { value: lower, safety: 'safe', fix: 'email_case', reason: 'email addresses are case-insensitive' };
      return { value: null, safety: 'manual', fix: 'invalid_email', reason: 'not a valid email address' };
    }

    if (p.piiType === 'phone') {
      let d = trimmed.replace(/[^\d+]/g, '');
      if (d.startsWith('+61')) d = `0${d.slice(3)}`;
      else if (d.startsWith('61') && d.length === 11) d = `0${d.slice(2)}`;
      // Mobiles and landlines each go into their own usual layout in this column.
      const layout = (n) => fitShape(n, (n.startsWith('04') ? ctx.phoneShapes?.mobile : ctx.phoneShapes?.landline) ?? '9999999999') ?? n;
      if (/^0[2-478]\d{8}$/.test(d)) {
        const v = layout(d);
        if (v === raw) return null;
        return { value: v, safety: 'safe', fix: 'phone_format', reason: 'same number in the usual format' };
      }
      if (/^4\d{8}$/.test(d)) {
        return { value: layout(`0${d}`), safety: 'review', fix: 'phone_leading_zero', reason: 'leading zero probably lost (e.g. by Excel)' };
      }
      if (/^\d{8}$/.test(d) && ctx.areaCode) {
        return { value: layout(`${ctx.areaCode}${d}`), safety: 'review', fix: 'phone_area_code', reason: `assumes area code ${ctx.areaCode}` };
      }
      return { value: null, safety: 'manual', fix: 'invalid_phone', reason: 'not a recognisable phone number' };
    }

    // Dates into the dominant date format.
    if (shape === '99/99/9999' || shape === '9999-99-99') {
      const parsed = parseDate(trimmed);
      if (!parsed) return { value: null, safety: 'manual', fix: 'invalid_date', reason: 'not a recognisable date' };
      if (parsed.yy !== undefined) {
        const now = new Date().getUTCFullYear() % 100;
        parsed.y = ctx.pastDates ? (parsed.yy > now ? 1900 + parsed.yy : 2000 + parsed.yy) : 2000 + parsed.yy;
      }
      if (!validDate(parsed)) return { value: null, safety: 'manual', fix: 'invalid_date', reason: 'not a real calendar date' };
      const v = formatDate(parsed, shape);
      return v && { value: v, safety: parsed.ambiguous ? 'review' : 'safe', fix: 'date_format', reason: parsed.ambiguous ?? 'same date in the usual format' };
    }

    // Excel artefacts.
    if (/^\d+\.0$/.test(trimmed) && re.test(trimmed.slice(0, -2))) {
      return { value: trimmed.slice(0, -2), safety: 'safe', fix: 'excel_decimal', reason: 'number stored with a trailing ".0"' };
    }
    if (/^\d(\.\d+)?E\+\d+$/i.test(trimmed)) {
      return { value: null, safety: 'manual', fix: 'scientific_notation', reason: 'digits were lost to scientific notation; get the original number' };
    }

    // Same characters, different separators or case: lay them out in the usual shape.
    if (shape) {
      const chars = trimmed.replace(/[^A-Za-z0-9]/g, '');
      const fitted = fitShape(chars, shape);
      if (fitted && re.test(fitted)) return { value: fitted, safety: 'safe', fix: 'reformat', reason: `same characters in the usual ${shape} format` };
    }
    return { value: null, safety: 'manual', fix: 'unexpected_format', reason: `doesn't match ${shape ?? 'the expected format'}` };
  }

  if (rule.rule_type === 'unique') {
    return { value: null, safety: 'manual', fix: 'duplicate', reason: 'duplicate record; merge or deactivate in the source system' };
  }
  if (rule.rule_type === 'not_future' || rule.rule_type === 'references') {
    return { value: null, safety: 'manual', fix: rule.rule_type, reason: rule.rule_type === 'references' ? 'parent record is missing' : 'date is in the future' };
  }
  return null;
}

/**
 * Builds correction proposals for a table.
 *   rows      raw rows (all columns as read from the source)
 *   rules     stored data quality rules ({ column_name, rule_type, params })
 *   keyColumns  columns identifying a record in the source system
 *   mappings  approved code mappings for this table ({ source_column, source_value, code_value_id, code_set_id })
 *   options   { areaCode }
 * Returns { groups: [...], changes: [...] }: one change per record, column and
 * new value; groups summarise by column, fix and safety.
 */
export function buildCorrections({ rows, rules, keyColumns, mappings = [], options = {} }) {
  const changes = new Map(); // key|column → change
  const keyOf = (row) => Object.fromEntries(keyColumns.map((k) => [k, row[k]]));
  const manual = [];

  const byColumn = new Map();
  for (const r of rules) {
    if (r.column_name.includes(',')) continue;
    if (!byColumn.has(r.column_name)) byColumn.set(r.column_name, []);
    byColumn.get(r.column_name).push(r);
  }

  for (const [column, colRules] of byColumn) {
    const counts = new Map();
    for (const row of rows) counts.set(row[column], (counts.get(row[column]) ?? 0) + 1);

    // Mapped columns: raw value → the source's own value for the same standard code.
    let mappedTo = null;
    const colMappings = mappings.filter((m) => m.source_column === column);
    if (colMappings.length) {
      const canon = canonicalByCode(colMappings, counts);
      mappedTo = new Map(colMappings.map((m) => [m.source_value, m.code_value_id === null ? null : canon.get(m.code_value_id)?.value]));
    }
    const formatRule = colRules.find((r) => r.rule_type === 'format');
    const phoneShapes = formatRule?.params?.piiType === 'phone' ? dominantPhoneShapes(rows, column) : null;
    const pastDates = /birth|dob|connect|install|created|read/i.test(column);

    for (const row of rows) {
      for (const rule of colRules) {
        // Only values that actually repeat are duplicates.
        if (rule.rule_type === 'unique' && (isMissing(row[column]) || counts.get(row[column]) < 2)) continue;
        const ctx = {
          mappedTo,
          allowed: mappedTo ? [...new Set([...mappedTo.values()].filter(Boolean))] : undefined,
          shape: rule.params?.pattern,
          phoneShapes,
          pastDates,
          areaCode: options.areaCode,
        };
        const fix = proposeFix(row[column], rule, ctx);
        if (!fix) continue;
        const key = keyOf(row);
        if (fix.value === null || fix.safety === 'manual') {
          manual.push({ key, column, old: row[column], fix: fix.fix, reason: fix.reason, rule: rule.rule_type });
          continue;
        }
        const id = `${JSON.stringify(key)}|${column}`;
        const existing = changes.get(id);
        // Keep the safest fix per value; never two different new values for one field.
        if (!existing || SAFETY.indexOf(fix.safety) < SAFETY.indexOf(existing.safety)) {
          changes.set(id, { key, column, old: row[column], new: fix.value, safety: fix.safety, fix: fix.fix, reason: fix.reason });
        }
      }
    }
  }

  const all = [...changes.values()];
  const groups = new Map();
  for (const c of [...all, ...manual.map((m) => ({ ...m, safety: 'manual', new: null }))]) {
    const id = `${c.column}|${c.fix}|${c.safety}`;
    if (!groups.has(id)) groups.set(id, { id, column: c.column, fix: c.fix, safety: c.safety, reason: c.reason, count: 0, examples: [] });
    const g = groups.get(id);
    g.count += 1;
    if (g.examples.length < 3 && !g.examples.some((e) => e.old === c.old)) g.examples.push({ old: c.old, new: c.new });
  }
  const order = { safe: 0, review: 1, manual: 2 };
  return {
    changes: all,
    groups: [...groups.values()].sort((a, b) => order[a.safety] - order[b.safety] || b.count - a.count),
  };
}

/** The most common layout of well-formed mobile and landline numbers in a column. */
function dominantPhoneShapes(rows, column) {
  const counts = { mobile: new Map(), landline: new Map() };
  for (const row of rows) {
    const v = String(row[column] ?? '').trim();
    if (!/^(0|\(0)[2-478]/.test(v)) continue; // national format only
    const digits = v.replace(/\D/g, '');
    if (digits.length !== 10) continue;
    const kind = digits.startsWith('04') ? 'mobile' : 'landline';
    const s = shapeOf(v);
    counts[kind].set(s, (counts[kind].get(s) ?? 0) + 1);
  }
  const top = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { mobile: top(counts.mobile), landline: top(counts.landline) };
}
