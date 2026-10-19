// CSV helpers for the upload page: previewing a file in the browser and
// suggesting table and column names that Unity Catalog accepts.

export const DELIMITERS = [
  { value: ',', label: 'Comma ( , )' },
  { value: ';', label: 'Semicolon ( ; )' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe ( | )' },
];

/** Parses CSV text (RFC 4180: quoted fields, "" escapes, line breaks inside quotes). */
export function parseCsv(text, delimiter = ',', maxRows = Infinity) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    field = '';
  };
  for (; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += ch;
  }
  if (rows.length < maxRows && (field !== '' || row.length)) endRow();
  return rows;
}

/** Picks the separator that splits the first lines most consistently. */
export function detectDelimiter(text) {
  const sample = text.slice(0, 64 * 1024);
  let best = ',';
  let bestScore = 0;
  for (const { value } of DELIMITERS) {
    const rows = parseCsv(sample, value, 20);
    if (!rows.length) continue;
    const width = rows[0].length;
    if (width < 2) continue;
    const consistent = rows.filter((r) => r.length === width).length / rows.length;
    const score = width * consistent;
    if (score > bestScore) {
      best = value;
      bestScore = score;
    }
  }
  return best;
}

/** A lower-case snake_case identifier: "Customer ID #" → "customer_id". */
export function sanitizeName(raw, fallback = 'column') {
  let name = String(raw ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) name = fallback;
  if (/^[0-9]/.test(name)) name = `${fallback}_${name}`;
  return name.slice(0, 120);
}

/** Makes names unique by adding _2, _3 … to repeats. */
export function uniqueNames(names) {
  const used = new Set();
  return names.map((n) => {
    let name = n;
    for (let k = 2; used.has(name); k++) name = `${n}_${k}`;
    used.add(name);
    return name;
  });
}

/** Column names for a parsed file: from the header row, or column_1, column_2 … */
export function columnNames(headerRow, width, hasHeader) {
  const names = Array.from({ length: width }, (_, i) =>
    hasHeader ? sanitizeName(headerRow?.[i], `column_${i + 1}`) : `column_${i + 1}`,
  );
  return uniqueNames(names.map((n) => (n.startsWith('_') ? n.replace(/^_+/, '') || 'column' : n)));
}

export const suggestTableName = (fileName) => sanitizeName(String(fileName).replace(/\.[^.]+$/, ''), 'upload');

export const NAME_RE = /^[a-z_][a-z0-9_]*$/;
export const RESERVED_COLUMNS = ['_source_file', '_ingested_at', '_ingested_by', '_load_id'];

/** Problems with the chosen column names, keyed by column index. */
export function nameProblems(names) {
  const problems = new Map();
  const counts = new Map();
  names.forEach((n) => counts.set(n, (counts.get(n) ?? 0) + 1));
  names.forEach((n, i) => {
    if (!n) problems.set(i, 'Give this column a name');
    else if (!NAME_RE.test(n)) problems.set(i, 'Use lower-case letters, numbers and _ only, not starting with a number');
    else if (RESERVED_COLUMNS.includes(n)) problems.set(i, 'This name is used for load tracking');
    else if (counts.get(n) > 1) problems.set(i, 'Another column has this name');
  });
  return problems;
}

/** A friendly hint at what a column holds. Bronze stores everything as text either way. */
export function guessKind(values) {
  const present = values.map((v) => v.trim()).filter(Boolean);
  if (!present.length) return 'Empty';
  const all = (re) => present.every((v) => re.test(v));
  if (all(/^(y|n|yes|no|true|false|t|f)$/i)) return 'Yes / No';
  if (all(/^-?[\d,]*\.?\d+$/)) return 'Number';
  if (all(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/) || all(/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}( \d{1,2}:\d{2})?/)) {
    return 'Date';
  }
  return 'Text';
}

export const formatBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
