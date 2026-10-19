// Suggests which standard code each raw source value maps to.
//
// Strategies, strongest first (score in brackets):
//   missing  "", "NULL", "N/A", "-", "UNKNOWN", ... → treat as missing   [1.00]
//   exact    same code or label ignoring case, spaces and punctuation     [1.00]
//            ("Closed " → CLOSED, "S.A." → SA, "B-PAY" → BPAY)
//   known    the same normalised value is already mapped in another
//            source column of this code set                              [0.95]
//   word     a word of the value is the code ("Credit Card" → CARD)      [0.90]
//   initials the value is the initials of the label ("DD" → Direct Debit,
//            "South Australia" → SA)                                      [0.90]
//   prefix   the value starts a code/label ("A", "act" → ACTIVE)         [0.85]
//   contains the code starts the value ("Male" → M)                      [0.80]
//   letters  the value's letters appear in order in the code, same first
//            letter ("CLS" → CLOSED, "CHQ" → CHEQUE)                     [0.70]
//   typo     small edit distance ("Inactve" → INACTIVE)                  [0.60]
// When two codes tie for the best score the value is left for a person to
// decide, with both candidates named.

const MISSING = new Set(['', 'NULL', 'NA', 'NONE', 'NIL', 'UNKNOWN', 'UNK', 'TBA', 'TBC', 'NOTKNOWN', 'BLANK']);

export const normalise = (v) =>
  String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const words = (v) =>
  String(v ?? '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);

const initials = (v) => words(v).map((w) => w[0]).join('');

function isSubsequence(short, long) {
  if (!short || short[0] !== long[0]) return false;
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
}

export function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function scoreAgainst(value, code) {
  const v = normalise(value);
  const targets = [code.code, code.label].filter(Boolean);
  let best = null;
  const consider = (score, reason) => {
    if (!best || score > best.score) best = { score, reason };
  };
  for (const t of targets) {
    const n = normalise(t);
    if (!n) continue;
    if (v === n) consider(1, 'exact match');
    if (words(value).length > 1 && words(value).some((w) => w === n)) consider(0.9, `contains "${t}"`);
    if (v.length >= 2 && v === initials(t) && words(t).length > 1) consider(0.9, `initials of "${t}"`);
    if (words(value).length > 1 && initials(value) === n) consider(0.9, `initials match "${t}"`);
    if (v.length >= 1 && n.startsWith(v) && v.length < n.length) consider(0.85, `abbreviation of "${t}"`);
    if (n.length >= 1 && v.startsWith(n) && n.length < v.length && /^[A-Z]+$/.test(v)) consider(0.8, `starts with "${t}"`);
    if (v.length >= 2 && isSubsequence(v, n)) consider(0.7, `letters of "${t}"`);
    if (v.length >= 4 && n.length >= 4) {
      const d = editDistance(v, n);
      if (d <= Math.max(1, Math.floor(n.length / 5))) consider(0.6, `close spelling of "${t}"`);
    }
  }
  return best;
}

/**
 * @param values      raw source values (strings)
 * @param codes       [{ id, code, label, active }] of the target code set
 * @param known       [{ source_value, code_value_id }] mappings already in the
 *                    code set (any source), used to reuse earlier decisions
 * @returns [{ value, codeValueId, missing, score, reason }]; codeValueId null
 *          with missing=false means "no suggestion".
 */
export function suggestMappings(values, codes, known = []) {
  const active = codes.filter((c) => c.active !== false);
  const knownByNorm = new Map();
  for (const k of known) {
    const n = normalise(k.source_value);
    if (!knownByNorm.has(n)) knownByNorm.set(n, k);
  }

  return values.map((value) => {
    const n = normalise(value);
    const scored = active
      .map((c) => ({ c, s: scoreAgainst(value, c) }))
      .filter((x) => x.s)
      .sort((a, b) => b.s.score - a.s.score);

    // A real code wins over the missing-value rule (e.g. a code set with "UNKNOWN").
    if (scored[0]?.s.score === 1) {
      return { value, codeValueId: scored[0].c.id, missing: false, score: 1, reason: 'exact match' };
    }
    if (MISSING.has(n) || /^[-_.?\s]*$/.test(String(value))) {
      return { value, codeValueId: null, missing: true, score: 1, reason: 'missing-value token' };
    }
    const prior = knownByNorm.get(n);
    if (prior) {
      return {
        value,
        codeValueId: prior.code_value_id,
        missing: prior.code_value_id === null,
        score: 0.95,
        reason: 'same value mapped in another source',
      };
    }
    if (!scored.length) return { value, codeValueId: null, missing: false, score: 0, reason: 'no match' };
    const top = scored.filter((x) => x.s.score === scored[0].s.score);
    if (top.length > 1) {
      return {
        value,
        codeValueId: null,
        missing: false,
        score: 0,
        reason: `ambiguous: ${top.map((x) => x.c.code).join(' or ')}`,
      };
    }
    return { value, codeValueId: top[0].c.id, missing: false, score: top[0].s.score, reason: top[0].s.reason };
  });
}
