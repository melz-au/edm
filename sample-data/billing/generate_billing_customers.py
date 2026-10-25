"""Generates CUSTOMER_MASTER.csv: a fictional customer extract from a legacy
billing system ("HydroBill"), with realistic data quality problems.

It is built from ../crm/CUSTOMER.csv so the two sources overlap. Most billed
CRM customers appear here too, linkable by account number, but formats and
values differ between the systems. The extract also has billing-only
customers, duplicates, and many injected data quality issues.

Every injected issue is logged to DQ_ISSUES.csv (cust_no, column, issue,
detail) as ground truth for testing data quality checks.

All data is fictional (see ../crm/README.md for the reserved ranges used).

Usage: python3 generate_billing_customers.py
"""
import csv
import random
from datetime import date, datetime, timedelta
from pathlib import Path



def _here():
    """This script's folder. Databricks runs .py files from a Git folder as notebooks,
    where __file__ isn't set but the working directory is the script's folder."""
    try:
        return Path(__file__).resolve().parent
    except NameError:
        for candidate in (Path.cwd(), Path.cwd() / "sample-data" / "billing"):
            if (candidate / "generate_billing_customers.py").exists():
                return candidate
        raise SystemExit("Run this from its own folder, sample-data/billing.")


HERE = _here()
rng = random.Random(20261021)
issues = []


def log(cust_no, column, issue, detail=""):
    issues.append({"cust_no": cust_no, "column": column, "issue": issue, "detail": detail})


def chance(p):
    return rng.random() < p


MISSING_TOKENS = ["NULL", "N/A", "-", " ", "UNKNOWN"]
POSTCODES = ["5000", "5006", "5082", "5067", "5061", "5045", "5022", "5043", "5108", "5112", "5092", "5015"]
SUBURB_TYPOS = {
    "GLENELG": "GLENLEG", "NORWOOD": "NORWOD", "NORTH ADELAIDE": "NTH ADELAIDE", "SALISBURY": "SALSIBURY",
    "PORT ADELAIDE": "PT ADELAIDE", "MOUNT BARKER": "MT BARKER", "HENLEY BEACH": "HENLEY BCH",
    "CAMPBELLTOWN": "CAMPBELTOWN", "BURNSIDE": "BURNSDE", "MAWSON LAKES": "MAWSON LKS",
}
STREET_VARIANTS = [(" Rd", [" ROAD", " RD", " RD."]), (" St", [" STREET", " ST", " ST."]),
                   (" Ave", [" AVENUE", " AVE"]), (" Dr", [" DRIVE", " DR"]), (" Ct", [" COURT", " CT"]),
                   (" Cres", [" CRESCENT", " CRES"]), (" Ln", [" LANE", " LN"]), (" Pl", [" PLACE", " PL"])]
EXTRA_FIRST = ["Barry", "Shirley", "Graham", "Dulcie", "Neville", "Beryl", "Kevin", "Joan", "Trevor", "Noelene"]
EXTRA_LAST = ["Pearce", "Fitzgerald", "Hogan", "McDonald", "Kowalski", "Schultz", "Vlahos", "Duong", "Ibrahim"]


def fmt_date(d, cust_no, column, allow_issues=True):
    """Mixed formats, as different load programs wrote them over the years."""
    style = rng.choices(["dmy", "iso", "dmon", "mdy"], [55, 25, 17, 3])[0]
    if not allow_issues and style == "mdy":
        style = "dmy"
    if style == "dmy":
        return d.strftime("%d/%m/%Y")
    if style == "iso":
        return d.isoformat()
    if style == "dmon":
        log(cust_no, column, "two_digit_year", d.isoformat())
        return d.strftime("%d-%b-%y").upper()
    log(cust_no, column, "month_day_swapped", d.isoformat())
    return d.strftime("%m/%d/%Y")


def legacy_ts(dt):
    return dt.strftime("%Y%m%d%H%M%S")


def street_variant(street):
    s = street.upper()
    for short, longs in STREET_VARIANTS:
        if s.endswith(short.upper()):
            return s[: -len(short)] + rng.choice(longs)
    return s


def name_variant(cust_no, first, last, title, business, company):
    if business:
        name = company.upper() if chance(0.7) else f"{company} Pty Ltd"
        return name
    f, l = first, last
    if "'" in l and chance(0.4):
        l2 = l.replace("'", "â€™")  # UTF-8 ’ read as Windows-1252
        log(cust_no, "CUST_NAME", "mojibake", f"{l} -> {l2}")
        l = l2
    style = rng.choices(["last_comma_first", "first_last", "title_initial", "swapped"], [45, 30, 20, 5])[0]
    if style == "last_comma_first":
        name = f"{l.upper()}, {f.upper()}"
    elif style == "first_last":
        name = f"{f} {l}"
    elif style == "title_initial":
        name = f"{(title or 'MR').upper()} {f[0].upper()} {l.upper()}"
    else:
        name = f"{l} {f}"
        log(cust_no, "CUST_NAME", "first_last_swapped", f"{first} {last}")
    if chance(0.04):
        name = name.replace(" ", "  ", 1) + " "
        log(cust_no, "CUST_NAME", "extra_whitespace")
    return name


def mobile_variant(cust_no, mobile):
    if not mobile:
        return ""
    d = mobile.replace(" ", "")
    r = rng.random()
    if r < 0.30:
        return d
    if r < 0.55:
        return mobile
    if r < 0.70:
        return "+61" + d[1:]
    if r < 0.78:
        return "61 " + mobile[1:]
    if r < 0.83:
        log(cust_no, "PH_MOB", "leading_zero_lost", mobile)
        return d[1:]
    if r < 0.86:
        log(cust_no, "PH_MOB", "placeholder_value", mobile)
        return "0400000000"
    return mobile


def home_variant(cust_no, home):
    if not home:
        return ""
    digits = home.replace("(", "").replace(")", "").replace(" ", "")
    r = rng.random()
    if r < 0.10:
        log(cust_no, "PH_HOME", "missing_area_code", home)
        return digits[2:]
    if r < 0.50:
        return "08 " + digits[2:6] + " " + digits[6:]
    return home


def email_variant(cust_no, email):
    if chance(0.10):
        log(cust_no, "EMAIL_ADDR", "missing_value", email)
        return ""
    r = rng.random()
    if r < 0.05:
        log(cust_no, "EMAIL_ADDR", "inconsistent_case", email)
        return email.upper()
    if r < 0.065:
        bad = email.replace("@", ".")
        log(cust_no, "EMAIL_ADDR", "invalid_email", f"missing @: {bad}")
        return bad
    if r < 0.075:
        bad = email.replace(".com", ".con").replace(".org", ".ogr").replace(".net", ".nte")
        log(cust_no, "EMAIL_ADDR", "domain_typo", bad)
        return bad
    if r < 0.095:
        log(cust_no, "EMAIL_ADDR", "placeholder_value", email)
        return "noemail@example.com"
    if r < 0.10:
        log(cust_no, "EMAIL_ADDR", "invalid_email", "double @")
        return email.replace("@", "@@")
    if r < 0.13:
        log(cust_no, "EMAIL_ADDR", "trailing_whitespace")
        return email + " "
    return email


def money(cust_no, amount):
    r = rng.random()
    if r < 0.45:
        return f"{amount:.2f}"
    if r < 0.65:
        log(cust_no, "BALANCE", "currency_formatting", f"{amount:.2f}")
        return f"${amount:,.2f}" if amount >= 0 else f"-${-amount:,.2f}"
    if r < 0.72 and amount < 0:
        log(cust_no, "BALANCE", "accounting_negative", f"{amount:.2f}")
        return f"({-amount:,.2f})"
    if r < 0.80:
        return f"{amount:g}"
    return f"{amount:.2f}"


def code(cust_no, column, canonical, variants, p=0.10):
    if chance(p):
        v = rng.choice(variants)
        log(cust_no, column, "non_standard_code", f"{canonical} as {v!r}")
        return v
    return canonical


STATUS_CODES = {"ACTIVE": ("A", ["Active", "ACTIVE", "act", "a"]), "INACTIVE": ("I", ["Inactive", "INACT", "i"]),
                "CLOSED": ("C", ["Closed ", "CLOSED", "CLS", "c"])}
TYPE_CODES = {"RESIDENTIAL": ("RES", ["R", "Residential", "RESI"]), "BUSINESS": ("BUS", ["B", "COM", "Commercial"])}
PAY_CODES = {"DIRECT DEBIT": ("DD", ["Direct Debit", "direct debit", "D/D"]), "BPAY": ("BPAY", ["BPay", "B-PAY"]),
             "CARD": ("CC", ["Credit Card", "CARD"]), "CENTREPAY": ("CP", ["Centrepay", "CTP"]), "CHEQUE": ("CHQ", ["Cheque"])}


def build_from_crm(c, cust_no):
    business = c["customer_type"] == "BUSINESS"
    rec = {"CUST_NO": cust_no}
    acct = c["customer_account_no"]
    r = rng.random()
    if r < 0.5:
        rec["ACCT_NUM"] = acct.replace("-", "")
    elif r < 0.8:
        rec["ACCT_NUM"] = acct
    elif r < 0.95:
        rec["ACCT_NUM"] = acct.split("-")[1]
    else:
        rec["ACCT_NUM"] = f" {acct.lower()} "
        log(cust_no, "ACCT_NUM", "inconsistent_case", acct)

    rec["CUST_NAME"] = name_variant(cust_no, c["first_name"], c["last_name"], c["title"], business, c["company_name"])
    rec["CONTACT_NAME"] = f"{c['first_name']} {c['last_name']}".upper() if business else ""

    dob = date.fromisoformat(c["date_of_birth"]) if c["date_of_birth"] else None
    if dob is None or chance(0.08):
        rec["DOB"] = ""
    elif chance(0.03):
        rec["DOB"] = "01/01/1900"
        log(cust_no, "DOB", "placeholder_value", c["date_of_birth"])
    elif chance(0.005):
        future = date(2031, rng.randint(1, 12), rng.randint(1, 28))
        rec["DOB"] = future.strftime("%d/%m/%Y")
        log(cust_no, "DOB", "future_date", c["date_of_birth"])
    else:
        rec["DOB"] = fmt_date(dob, cust_no, "DOB")

    g = c["gender"]
    rec["SEX"] = code(cust_no, "SEX", g if g in ("M", "F") else "U" if g else "",
                      {"M": ["Male", "m", "1"], "F": ["Female", "f", "2"]}.get(g, ["Unknown", "9"]), 0.06)

    rec["PH_MOB"] = mobile_variant(cust_no, c["mobile_phone"])
    rec["PH_HOME"] = home_variant(cust_no, c["home_phone"])
    rec["EMAIL_ADDR"] = email_variant(cust_no, c["email"])

    street = c["street_address"]
    if chance(0.06):
        street = f"U{rng.randint(1, 12)}/{street}"
    if chance(0.01):
        street = street.split(" ", 1)[1]
        log(cust_no, "SUPPLY_ADDR_1", "missing_street_number", c["street_address"])
    rec["SUPPLY_ADDR_1"] = street_variant(street)
    rec["SUPPLY_ADDR_2"] = ""
    suburb = c["suburb"].upper()
    if suburb in SUBURB_TYPOS and chance(0.12):
        log(cust_no, "SUBURB_TOWN", "typo_or_abbreviation", f"{suburb} -> {SUBURB_TYPOS[suburb]}")
        suburb = SUBURB_TYPOS[suburb]
    if chance(0.03):
        suburb += " "
        log(cust_no, "SUBURB_TOWN", "trailing_whitespace")
    rec["SUBURB_TOWN"] = suburb

    r = rng.random()
    if r < 0.05:
        rec["STATE"] = "S.A."
    elif r < 0.09:
        rec["STATE"] = "South Australia"
    elif r < 0.12:
        rec["STATE"] = "sa"
    elif r < 0.14:
        rec["STATE"] = ""
        log(cust_no, "STATE", "missing_value")
    elif r < 0.15:
        rec["STATE"] = "NSW"
        log(cust_no, "STATE", "inconsistent_with_postcode", f"NSW with SA postcode {c['postcode']}")
    else:
        rec["STATE"] = "SA"
    if rec["STATE"] in ("S.A.", "South Australia", "sa"):
        log(cust_no, "STATE", "non_standard_code", rec["STATE"])

    pc = c["postcode"]
    r = rng.random()
    if r < 0.03:
        rec["PCODE"] = ""
        log(cust_no, "PCODE", "missing_value", pc)
    elif r < 0.05:
        wrong = rng.choice([p for p in POSTCODES if p != pc])
        rec["PCODE"] = wrong
        log(cust_no, "PCODE", "inconsistent_with_suburb", f"{c['suburb']} should be {pc}")
    elif r < 0.06:
        rec["PCODE"] = pc[:3]
        log(cust_no, "PCODE", "truncated", pc)
    elif r < 0.08:
        rec["PCODE"] = pc + ".0"
        log(cust_no, "PCODE", "excel_number_format", pc)
    else:
        rec["PCODE"] = pc
    rec["MAIL_ADDR"] = "SAME" if chance(0.8) else f"PO BOX {rng.randint(1, 9999)}, {c['suburb'].upper()} SA {pc}"

    status = c["customer_status"]
    if status == "ACTIVE" and chance(0.04):
        status = "CLOSED"
        log(cust_no, "ACCT_STATUS", "conflicts_with_crm", "CRM says ACTIVE")
    canonical, variants = STATUS_CODES[status]
    rec["ACCT_STATUS"] = code(cust_no, "ACCT_STATUS", canonical, variants)
    canonical, variants = TYPE_CODES[c["customer_type"]]
    rec["ACCT_TYPE"] = code(cust_no, "ACCT_TYPE", canonical, variants)

    has_conc = c["concession_type"] not in ("NONE", "")
    flag = "Y" if has_conc else "N"
    if has_conc and chance(0.05):
        flag = "N"
        log(cust_no, "CONC_FLAG", "contradicts_conc_card", "card present but flag N")
    rec["CONC_FLAG"] = code(cust_no, "CONC_FLAG", flag, ["1", "0", "TRUE", "yes", ""] if flag == "Y" else ["0", "false", "no", ""], 0.12)
    card = c["concession_card_number"]
    rec["CONC_CARD"] = (card.replace("-", "").lower() if chance(0.3) else card) if card else ""

    canonical, variants = PAY_CODES[c["payment_method"]]
    rec["PAY_METHOD"] = code(cust_no, "PAY_METHOD", canonical, variants, 0.08)
    bsb, acct_no = c["bsb"], c["bank_account_number"]
    rec["BSB_NO"] = bsb.replace("-", "") if bsb and chance(0.4) else bsb
    if acct_no and chance(0.03):
        rec["BANK_ACCT"] = f"{int(acct_no):.5E}".replace("E+0", "E+")
        log(cust_no, "BANK_ACCT", "excel_scientific_notation", acct_no)
    else:
        rec["BANK_ACCT"] = acct_no
    if rec["PAY_METHOD"] in ("DD", "Direct Debit", "direct debit", "D/D") and not bsb:
        log(cust_no, "BSB_NO", "missing_value", "direct debit without bank details")

    balance = round(rng.choice([0, 0, 0]) if chance(0.3) else rng.uniform(-150, 900), 2)
    rec["BALANCE"] = money(cust_no, balance)

    connect = datetime.fromisoformat(c["created_date"]).date() - timedelta(days=rng.randint(0, 30))
    rec["CONNECT_DATE"] = fmt_date(connect, cust_no, "CONNECT_DATE")
    if status == "CLOSED":
        disc = connect + timedelta(days=rng.randint(30, 2000))
        if chance(0.1):
            disc = connect - timedelta(days=rng.randint(1, 200))
            log(cust_no, "DISCONNECT_DATE", "before_connect_date")
        rec["DISCONNECT_DATE"] = fmt_date(disc, cust_no, "DISCONNECT_DATE")
    else:
        rec["DISCONNECT_DATE"] = ""
    rec["LAST_READ_DATE"] = fmt_date(date(2026, rng.randint(7, 10), rng.randint(1, 28)), cust_no, "LAST_READ_DATE")
    rec["METER_NO"] = f"MTR{rng.randint(10000000, 99999999)}"
    rec["LAST_UPD_USER"] = rng.choice(["BATCH", "SYSADMIN", "JSMITH", "AKUMAR", "TPAPADOP", "CONV2009"])
    rec["LAST_UPD_TS"] = legacy_ts(datetime(2026, rng.randint(1, 10), rng.randint(1, 28), rng.randint(0, 23), rng.randint(0, 59)))
    rec["COMMENTS"] = rng.choice(["", "", "", "", "CONVERTED FROM LEGACY SYSTEM 2009", "HARDSHIP - SEE FILE",
                                  "DO NOT DISCONNECT - LIFE SUPPORT", "PAYMENT ARRANGEMENT $20/FN", "OWNER OCCUPIER",
                                  "TENANT - BILL OWNER", f"CUST DOB {c['date_of_birth']}" if c["date_of_birth"] else ""])
    if rec["COMMENTS"].startswith("CUST DOB"):
        log(cust_no, "COMMENTS", "pii_in_free_text", "date of birth in comments")
    return rec


def blank_out(rec):
    """Sprinkle the various 'missing' tokens legacy systems use."""
    for col in ("PH_HOME", "PH_MOB", "EMAIL_ADDR", "SEX", "SUPPLY_ADDR_2", "MAIL_ADDR", "CONC_CARD"):
        if chance(0.03):
            tok = rng.choice(MISSING_TOKENS)
            if rec.get(col):
                log(rec["CUST_NO"], col, "missing_value_token", f"{tok!r} replaced a value")
            else:
                log(rec["CUST_NO"], col, "missing_value_token", repr(tok))
            rec[col] = tok


crm = list(csv.DictReader(open(HERE.parent / "crm" / "CUSTOMER.csv", encoding="utf-8")))
billed = [c for c in crm if c["customer_status"] != "PROSPECT"]  # prospects never reach billing
rng.shuffle(billed)
billed = billed[: int(len(billed) * 0.94)]  # some CRM customers missing from billing

records = []
next_no = 3_000_000
for c in billed:
    next_no += rng.randint(1, 7)
    rec = build_from_crm(c, f"C{next_no}")
    blank_out(rec)
    records.append(rec)

# Billing-only customers (never set up in the CRM).
for _ in range(120):
    next_no += rng.randint(1, 7)
    first, last = rng.choice(EXTRA_FIRST), rng.choice(EXTRA_LAST)
    fake = dict(rng.choice(crm))
    fake.update({
        "customer_account_no": f"WC-{rng.randint(1000000, 9999999)}", "first_name": first, "last_name": last,
        "customer_type": "RESIDENTIAL", "company_name": "", "title": rng.choice(["Mr", "Mrs", "Ms", ""]),
        "email": f"{first}.{last}{rng.randint(1, 99)}@example.net".lower() if chance(0.4) else "",
        "customer_status": rng.choice(["ACTIVE", "ACTIVE", "INACTIVE", "CLOSED"]),
    })
    rec = build_from_crm(fake, f"C{next_no}")
    log(rec["CUST_NO"], "*", "not_in_crm", "billing-only customer")
    records.append(rec)

# Fuzzy duplicates: the same customer set up twice under a new CUST_NO.
for src in rng.sample(records[:800], 40):
    next_no += rng.randint(1, 7)
    dup = dict(src)
    dup["CUST_NO"] = f"C{next_no}"
    dup["CUST_NAME"] = src["CUST_NAME"].title() if chance(0.5) else src["CUST_NAME"].replace(",", "")
    dup["EMAIL_ADDR"] = src["EMAIL_ADDR"].upper() if src["EMAIL_ADDR"] else ""
    dup["ACCT_STATUS"] = rng.choice(["A", "I"])
    dup["METER_NO"] = src["METER_NO"]
    dup["LAST_UPD_TS"] = legacy_ts(datetime(2026, rng.randint(1, 10), rng.randint(1, 28)))
    log(dup["CUST_NO"], "*", "duplicate_customer", f"same customer as {src['CUST_NO']}")
    records.append(dup)

# Meter assigned to two unrelated customers.
for a, b in [rng.sample(records, 2) for _ in range(8)]:
    b["METER_NO"] = a["METER_NO"]
    log(b["CUST_NO"], "METER_NO", "shared_with_other_customer", f"also on {a['CUST_NO']}")

rng.shuffle(records)

# Exact duplicate rows from a re-run extract.
for src in rng.sample(records, 10):
    records.insert(rng.randrange(len(records)), dict(src))
    log(src["CUST_NO"], "*", "exact_duplicate_row")

cols = ["CUST_NO", "ACCT_NUM", "CUST_NAME", "CONTACT_NAME", "DOB", "SEX", "PH_HOME", "PH_MOB", "EMAIL_ADDR",
        "SUPPLY_ADDR_1", "SUPPLY_ADDR_2", "SUBURB_TOWN", "STATE", "PCODE", "MAIL_ADDR", "ACCT_STATUS", "ACCT_TYPE",
        "CONC_FLAG", "CONC_CARD", "PAY_METHOD", "BSB_NO", "BANK_ACCT", "BALANCE", "CONNECT_DATE", "DISCONNECT_DATE",
        "LAST_READ_DATE", "METER_NO", "LAST_UPD_USER", "LAST_UPD_TS", "COMMENTS"]
with open(HERE / "CUSTOMER_MASTER.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=cols, lineterminator="\r\n")  # Windows line endings, as legacy exports have
    w.writeheader()
    w.writerows(records)
with open(HERE / "DQ_ISSUES.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["cust_no", "column", "issue", "detail"], lineterminator="\n")
    w.writeheader()
    w.writerows(sorted(issues, key=lambda i: (i["cust_no"], i["column"])))
print(f"{len(records)} rows, {len(issues)} logged issues")
