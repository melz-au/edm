// Detects columns holding personal data (PII).
//
// Two kinds of evidence:
//   name   — the column name matches a known pattern (email, first_name, dob,
//            tfn, created_by, ...). Applies to every column.
//   values — sampled values match a format (email address, phone number,
//            card number passing the Luhn check, IP address, IBAN, SSN/TFN).
//
// Each PII type has a sensitivity:
//   high   — identity documents, financial, credentials, special categories, birth date
//   medium — direct contact details and names, user/person identifiers
//   low    — quasi-identifiers such as precise location or postcode
//
// Sample values of PII columns are masked before they leave the server.

export const VALUE_SAMPLE_PER_COLUMN = 100;
const VALUE_MATCH_THRESHOLD = 0.6;

export const PII_TYPES = {
  email: { label: 'Email address', sensitivity: 'medium' },
  phone: { label: 'Phone number', sensitivity: 'medium' },
  person_name: { label: 'Person name', sensitivity: 'medium' },
  address: { label: 'Postal address', sensitivity: 'medium' },
  person_id: { label: 'Person / user identifier', sensitivity: 'medium' },
  ip_address: { label: 'IP / device address', sensitivity: 'medium' },
  date_of_birth: { label: 'Date of birth', sensitivity: 'high' },
  government_id: { label: 'Government ID (TFN, SSN, passport, licence, Medicare)', sensitivity: 'high' },
  financial: { label: 'Financial account / card', sensitivity: 'high' },
  credential: { label: 'Password / secret', sensitivity: 'high' },
  special_category: { label: 'Sensitive attribute (health, gender, ethnicity, ...)', sensitivity: 'high' },
  location: { label: 'Precise location / postcode', sensitivity: 'low' },
};

/** Types that only count as personal data in a table describing people. */
export const QUASI_IDENTIFIERS = new Set(['location']);
/** Types that show a table describes people (audit "changed by" columns don't). */
export const DIRECT_IDENTIFIERS = new Set([
  'email', 'phone', 'person_name', 'address', 'date_of_birth', 'government_id', 'financial', 'special_category',
]);

// Matched against the column name lower-cased with separators removed
// ("First_Name" → "firstname"), so snake_case, camelCase and SHOUTING all work.
const NAME_PATTERNS = [
  ['credential', /(password|passwd|pwd$|secret|apikey|accesstoken|authtoken|privatekey)/],
  ['government_id', /(ssn$|socialsecurity|^tfn|taxfile|taxid|medicare|passport|licen[cs]eno|licen[cs]enum|driverslicen|driverlicen|nationalid|^nino?$|concessioncard|pensioncard|healthcarecard|centrelink|^crn$|veteranscard|dvacard)/],
  ['financial', /(creditcard|cardnumber|cardno|cardnum|^ccn$|^pan$|iban|^bsb|bankaccount|accountnumber|^accountno|routingnumber|sortcode)/],
  ['date_of_birth', /(^dob$|dateofbirth|birthdate|birthday|^dob[a-z]*$)/],
  ['special_category', /(gender|^sex$|ethnic|^race$|religio|health|diagnos|disabilit|sexualorient|medicalcond|criminal)/],
  ['email', /(e?mail(address)?$|^email)/],
  ['phone', /(phone|mobile|cellno|^cell$|^tel$|telephone|^fax)/],
  ['person_name', /(firstname|lastname|surname|givenname|fullname|middlename|maidenname|forename|familyname|preferredname|nickname|(contact|customer|employee|person|patient|student|staff|member)name$)/],
  ['address', /(address(line)?\d?$|^addr|street|suburb|postaladdr|homeaddr|residential)/],
  ['location', /(^latitude|^longitude|^lat$|^lon$|^lng$|latitude[xy]?$|longitude[xy]?$|geolocation|coordinates|postcode|zipcode|^zip$|postalcode)/],
  ['ip_address', /(ipaddr|^ip$|ipv4|ipv6|macaddr|deviceid)/],
  [
    'person_id',
    /(username|^login|^userid$|^user$|employeeid|^empno|personid|staffid|customerid|patientid|studentid|(created|changed|modified|updated|requested|approved|entered|reported|assigned)by$|^changeby$|^createby$|^owner$|ownedby|assignedto|(account|relationship|case)manager$)/,
  ],
];

const flat = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

export function detectByName(name) {
  const n = flat(name);
  for (const [type, re] of NAME_PATTERNS) if (re.test(n)) return type;
  return null;
}

// --- value formats --------------------------------------------------------

const digitsOf = (v) => v.replace(/\D/g, '');

export function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function validTfn(digits) {
  if (digits.length !== 9) return false;
  const w = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  return [...digits].reduce((s, d, i) => s + Number(d) * w[i], 0) % 11 === 0;
}

function validIban(v) {
  const s = v.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const n = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

const VALUE_TESTS = [
  ['email', (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)],
  [
    'financial',
    (v) => {
      if (!/^[\d\s-]{13,23}$/.test(v)) return false;
      const d = digitsOf(v);
      return d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d);
    },
  ],
  ['financial', validIban],
  ['government_id', (v) => /^\d{3}-\d{2}-\d{4}$/.test(v)], // US SSN
  ['government_id', (v) => /^\d{3} \d{3} \d{3}$/.test(v) && validTfn(digitsOf(v))], // AU TFN, formatted
  [
    'ip_address',
    (v) => /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((p) => Number(p) <= 255),
  ],
  // IPv6 or MAC address; times like 10:30:00 have only two colons and no '::'.
  ['ip_address', (v) => /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i.test(v) && (v.includes('::') || (v.match(/:/g) ?? []).length >= 5)],
  [
    'phone',
    (v) => {
      if (!/^\+?[\d\s\-().]{8,20}$/.test(v)) return false;
      const d = digitsOf(v);
      if (d.length < 8 || d.length > 15) return false;
      // Needs a phone-like shape: international prefix, trunk 0, or separators.
      return v.startsWith('+') || /^0\d/.test(d) || /[\s\-()]/.test(v.trim());
    },
  ],
];

/** Fraction of sampled values matching each PII value format. */
export function detectByValues(values) {
  const vals = values.map((v) => String(v).trim()).filter(Boolean);
  if (vals.length < 3) return null;
  let best = null;
  for (const [type, test] of VALUE_TESTS) {
    const rate = vals.filter((v) => test(v)).length / vals.length;
    if (rate >= VALUE_MATCH_THRESHOLD && (!best || rate > best.rate)) best = { type, rate };
  }
  return best;
}

// --- masking ----------------------------------------------------------------

export function mask(value, type) {
  if (value === null || value === undefined) return value;
  const v = String(value);
  if (type === 'email' && v.includes('@')) {
    const [user, domain] = v.split('@');
    return `${user.slice(0, 1)}•••@${domain}`;
  }
  if (['phone', 'financial', 'government_id'].includes(type)) {
    const d = digitsOf(v);
    return d.length > 4 ? `•••• ${d.slice(-(type === 'financial' ? 4 : 2))}` : '••••';
  }
  if (v.length <= 3) return '•••';
  return `${v[0]}•••${v[v.length - 1]}`;
}

// --- assessment -------------------------------------------------------------

/**
 * Combines name and value evidence for one column. Returns null when the
 * column doesn't look like PII.
 */
export function assess(name, values = []) {
  const byName = detectByName(name);
  const byValues = values.length ? detectByValues(values) : null;
  if (!byName && !byValues) return null;

  const type = byValues?.type ?? byName;
  const evidence = [];
  if (byName) evidence.push('column name');
  if (byValues) evidence.push(`${Math.round(byValues.rate * 100)}% of sampled values look like ${PII_TYPES[byValues.type].label.toLowerCase()}`);
  const agree = byName && byValues && byName === byValues.type;
  const strongName = ['credential', 'government_id', 'financial', 'date_of_birth', 'email'].includes(byName);
  const confidence = agree || (byValues && byValues.rate >= 0.8) || strongName ? 'high' : 'medium';

  const examples = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))]
    .slice(0, 3)
    .map((v) => mask(v, type));

  return {
    type,
    label: PII_TYPES[type].label,
    sensitivity: PII_TYPES[type].sensitivity,
    confidence,
    evidence: evidence.join('; '),
    examples,
  };
}

// --- SQL --------------------------------------------------------------------

const TEXTUAL = /char|text|string|citext|^name$|bigint|int8|long|numeric\(\d+,\s*0\)|decimal\(\d+,\s*0\)|inet|cidr|macaddr/i;

/** Columns whose values are worth sampling for PII formats. */
export function valueColumns(columns) {
  return columns.filter((c) => TEXTUAL.test(String(c.type ?? '')));
}

/** Up to `perColumn` non-null values per column index, as rows (i, v). */
export function samplesSql(dialect, ref, columns, sample, perColumn = VALUE_SAMPLE_PER_COLUMN) {
  const q = (n) => (dialect === 'spark' ? `\`${String(n).replace(/`/g, '``')}\`` : `"${String(n).replace(/"/g, '""')}"`);
  const text = dialect === 'spark' ? 'STRING' : 'TEXT';
  const branches = columns.map(
    ({ name, index }) => `SELECT ${index} AS i, CAST(${q(name)} AS ${text}) AS v FROM s WHERE ${q(name)} IS NOT NULL`,
  );
  return `WITH s AS (SELECT * FROM ${ref} LIMIT ${sample}),
v AS (${branches.join('\nUNION ALL ')}),
r AS (SELECT i, v, row_number() OVER (PARTITION BY i ORDER BY i) AS rn FROM v)
SELECT i, v FROM r WHERE rn <= ${perColumn}`;
}
