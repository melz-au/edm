"""Generates a fictional star schema for the sample water utility: three fact
tables and eight dimensions, conformed with the other samples in this folder.

  fact_meter_read      one row per quarterly meter read (billing consumption)
  fact_work_order      one row per completed maintenance work order
  fact_water_quality   one row per drinking water quality lab result

Dimensions have integer surrogate keys (smart key yyyymmdd for dim_date), a
business key from the source system and an "unknown" member with key -1, so
fact keys are never NULL. dim_customer is SCD type 2: a customer who moves or
whose concession changes gets a new version, and each read joins the version
in force on the read date.

Sources: customers from ../crm/CUSTOMER.csv, sites and equipment from
../assets/ASSET_GOLDEN.csv (site codes match LOCATIONS.csv in the repository
root). Everything is fictional.

Writes one CSV per table plus load_lakebase.sql and load_unity_catalog.sql,
both generated from the column definitions below.

Usage: python3 generate_star.py
"""
import csv
import math
import random
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
rng = random.Random(20261025)
START, END = date(2023, 1, 1), date(2025, 12, 31)
SCHEMA = "water_star"

# --- table definitions: (column, postgres type, databricks type, nullable, comment)

T = {}


def table(name, comment, columns, pk, business=None, refs=None):
    T[name] = {"comment": comment, "columns": columns, "pk": pk, "business": business or [], "refs": refs or {}, "rows": []}


def c(name, pg, uc, nullable=False, comment=None):
    return (name, pg, uc, nullable, comment)


table("dim_date", "Date dimension: one row per calendar day, smart key yyyymmdd", [
    c("date_sk", "integer", "INT", comment="Smart key yyyymmdd; -1 is unknown"),
    c("full_date", "date", "DATE"),
    c("year", "integer", "INT"),
    c("quarter", "integer", "INT"),
    c("month", "integer", "INT"),
    c("month_name", "text", "STRING"),
    c("day_of_month", "integer", "INT"),
    c("day_of_week", "integer", "INT", comment="1 = Monday"),
    c("day_name", "text", "STRING"),
    c("is_weekend", "boolean", "BOOLEAN"),
    c("financial_year", "text", "STRING", comment="Australian financial year, July to June, e.g. FY2024"),
    c("season", "text", "STRING", comment="Southern hemisphere season"),
], pk="date_sk", business=["full_date"])

table("dim_customer", "Customer dimension, SCD type 2: a new version when the customer moves or their concession changes", [
    c("customer_sk", "bigint", "BIGINT", comment="Surrogate key; -1 is unknown"),
    c("customer_id", "text", "STRING", comment="Business key: CRM customer_id"),
    c("account_no", "text", "STRING"),
    c("customer_type", "text", "STRING"),
    c("customer_name", "text", "STRING"),
    c("suburb", "text", "STRING"),
    c("postcode", "text", "STRING"),
    c("concession_type", "text", "STRING"),
    c("segment", "text", "STRING"),
    c("effective_from", "date", "DATE"),
    c("effective_to", "date", "DATE", nullable=True, comment="NULL while current"),
    c("is_current", "boolean", "BOOLEAN"),
], pk="customer_sk", business=["customer_id", "effective_from"])

table("dim_meter", "Water meter dimension (SCD type 1)", [
    c("meter_sk", "bigint", "BIGINT", comment="Surrogate key; -1 is unknown"),
    c("meter_no", "text", "STRING", comment="Business key: meter serial number"),
    c("meter_size_mm", "integer", "INT"),
    c("meter_type", "text", "STRING"),
    c("manufacturer", "text", "STRING"),
    c("install_date", "date", "DATE", nullable=True),
], pk="meter_sk", business=["meter_no"])

table("dim_tariff", "Water tariff dimension (SCD type 1); rates are fictional", [
    c("tariff_sk", "bigint", "BIGINT", comment="Surrogate key; -1 is unknown"),
    c("tariff_code", "text", "STRING", comment="Business key"),
    c("tariff_name", "text", "STRING"),
    c("customer_type", "text", "STRING"),
    c("tier1_rate_per_kl", "numeric(8,4)", "DECIMAL(8,4)"),
    c("tier1_limit_kl_per_day", "numeric(6,3)", "DECIMAL(6,3)"),
    c("tier2_rate_per_kl", "numeric(8,4)", "DECIMAL(8,4)"),
    c("supply_charge_per_quarter", "numeric(8,2)", "DECIMAL(8,2)"),
], pk="tariff_sk", business=["tariff_code"])

table("dim_site", "Operational site dimension: treatment plants, pump stations, reservoirs", [
    c("site_sk", "bigint", "BIGINT", comment="Surrogate key; -1 is unknown"),
    c("site_code", "text", "STRING", comment="Business key: matches LOCATIONS.LOCATION"),
    c("site_name", "text", "STRING"),
    c("site_type", "text", "STRING"),
    c("region", "text", "STRING"),
    c("is_drinking_water", "boolean", "BOOLEAN"),
], pk="site_sk", business=["site_code"])

table("dim_asset", "Maintainable equipment dimension (SCD type 1), flattened with its system and facility", [
    c("asset_sk", "bigint", "BIGINT", comment="Surrogate key; -1 is unknown"),
    c("asset_tag", "text", "STRING", comment="Business key: matches ASSET_GOLDEN.asset_tag"),
    c("asset_name", "text", "STRING"),
    c("asset_class", "text", "STRING"),
    c("system_name", "text", "STRING"),
    c("facility_name", "text", "STRING"),
    c("manufacturer", "text", "STRING", nullable=True),
    c("criticality", "integer", "INT", nullable=True),
    c("install_date", "date", "DATE", nullable=True),
], pk="asset_sk", business=["asset_tag"])

table("dim_work_type", "Maintenance work type dimension", [
    c("work_type_sk", "bigint", "BIGINT", comment="Surrogate key; -1 is unknown"),
    c("work_type_code", "text", "STRING", comment="Business key"),
    c("work_type_name", "text", "STRING"),
    c("is_planned", "boolean", "BOOLEAN"),
], pk="work_type_sk", business=["work_type_code"])

table("dim_wq_parameter", "Drinking water quality parameter dimension; limits are illustrative", [
    c("parameter_sk", "bigint", "BIGINT", comment="Surrogate key; -1 is unknown"),
    c("parameter_code", "text", "STRING", comment="Business key"),
    c("parameter_name", "text", "STRING"),
    c("unit", "text", "STRING"),
    c("guideline_min", "numeric(10,3)", "DECIMAL(10,3)", nullable=True),
    c("guideline_max", "numeric(10,3)", "DECIMAL(10,3)", nullable=True),
], pk="parameter_sk", business=["parameter_code"])

table("fact_meter_read", "Billing consumption. Grain: one row per meter read (a customer's quarterly reading of one meter)", [
    c("read_date_sk", "integer", "INT"),
    c("customer_sk", "bigint", "BIGINT", comment="The customer version in force on the read date"),
    c("meter_sk", "bigint", "BIGINT"),
    c("tariff_sk", "bigint", "BIGINT"),
    c("read_no", "text", "STRING", comment="Degenerate dimension: billing read number"),
    c("read_type", "text", "STRING", comment="ACTUAL or ESTIMATED"),
    c("days_in_period", "integer", "INT"),
    c("consumption_kl", "numeric(10,2)", "DECIMAL(10,2)"),
    c("usage_charge", "numeric(12,2)", "DECIMAL(12,2)"),
    c("supply_charge", "numeric(12,2)", "DECIMAL(12,2)"),
], pk=None, refs={"read_date_sk": "dim_date", "customer_sk": "dim_customer", "meter_sk": "dim_meter", "tariff_sk": "dim_tariff"})

table("fact_work_order", "Maintenance. Grain: one row per completed work order", [
    c("raised_date_sk", "integer", "INT"),
    c("completed_date_sk", "integer", "INT"),
    c("asset_sk", "bigint", "BIGINT"),
    c("site_sk", "bigint", "BIGINT"),
    c("work_type_sk", "bigint", "BIGINT"),
    c("work_order_no", "text", "STRING", comment="Degenerate dimension"),
    c("labour_hours", "numeric(8,2)", "DECIMAL(8,2)"),
    c("labour_cost", "numeric(12,2)", "DECIMAL(12,2)"),
    c("material_cost", "numeric(12,2)", "DECIMAL(12,2)"),
    c("downtime_hours", "numeric(8,2)", "DECIMAL(8,2)"),
], pk=None, refs={"raised_date_sk": "dim_date", "completed_date_sk": "dim_date", "asset_sk": "dim_asset", "site_sk": "dim_site", "work_type_sk": "dim_work_type"})

table("fact_water_quality", "Drinking water quality. Grain: one row per lab result (one parameter of one sample)", [
    c("sample_date_sk", "integer", "INT"),
    c("site_sk", "bigint", "BIGINT"),
    c("parameter_sk", "bigint", "BIGINT"),
    c("sample_no", "text", "STRING", comment="Degenerate dimension: lab sample number"),
    c("result_value", "numeric(10,3)", "DECIMAL(10,3)"),
    c("exceedance_count", "integer", "INT", comment="1 when outside the guideline, else 0, so it sums"),
], pk=None, refs={"sample_date_sk": "dim_date", "site_sk": "dim_site", "parameter_sk": "dim_wq_parameter"})


def add(name, **row):
    T[name]["rows"].append(row)


def sk(d):
    return int(d.strftime("%Y%m%d"))


# --- dim_date -------------------------------------------------------------------------

SEASONS = {12: "Summer", 1: "Summer", 2: "Summer", 3: "Autumn", 4: "Autumn", 5: "Autumn",
           6: "Winter", 7: "Winter", 8: "Winter", 9: "Spring", 10: "Spring", 11: "Spring"}
add("dim_date", date_sk=-1, full_date="1900-01-01", year=1900, quarter=0, month=0, month_name="Unknown",
    day_of_month=0, day_of_week=0, day_name="Unknown", is_weekend=False, financial_year="Unknown", season="Unknown")
d = START
while d <= END:
    add("dim_date", date_sk=sk(d), full_date=d.isoformat(), year=d.year, quarter=(d.month - 1) // 3 + 1, month=d.month,
        month_name=d.strftime("%B"), day_of_month=d.day, day_of_week=d.isoweekday(), day_name=d.strftime("%A"),
        is_weekend=d.isoweekday() >= 6, financial_year=f"FY{d.year + 1 if d.month >= 7 else d.year}", season=SEASONS[d.month])
    d += timedelta(days=1)

# --- dim_tariff, dim_work_type, dim_wq_parameter ----------------------------------------------

TARIFFS = [
    ("RES-STD", "Residential standard", "RESIDENTIAL", 2.4210, 0.520, 3.4580, 82.50),
    ("RES-CONC", "Residential concession", "RESIDENTIAL", 2.4210, 0.520, 3.4580, 41.25),
    ("BUS-STD", "Business standard", "BUSINESS", 3.4580, 99.000, 3.4580, 128.40),
    ("BUS-LRG", "Business large meter", "BUSINESS", 3.4580, 99.000, 3.4580, 512.80),
]
add("dim_tariff", tariff_sk=-1, tariff_code="UNKNOWN", tariff_name="Unknown", customer_type="UNKNOWN",
    tier1_rate_per_kl=0, tier1_limit_kl_per_day=0, tier2_rate_per_kl=0, supply_charge_per_quarter=0)
for i, (code, name, ctype, r1, lim, r2, supply) in enumerate(TARIFFS, 1):
    add("dim_tariff", tariff_sk=i, tariff_code=code, tariff_name=name, customer_type=ctype, tier1_rate_per_kl=r1,
        tier1_limit_kl_per_day=lim, tier2_rate_per_kl=r2, supply_charge_per_quarter=supply)
tariff_sk = {t[0]: i for i, t in enumerate(TARIFFS, 1)}

WORK_TYPES = [("PM", "Preventive maintenance", True), ("CM", "Corrective maintenance", False),
              ("EM", "Emergency repair", False), ("INSP", "Inspection", True), ("CAL", "Calibration", True)]
add("dim_work_type", work_type_sk=-1, work_type_code="UNKNOWN", work_type_name="Unknown", is_planned=False)
for i, (code, name, planned) in enumerate(WORK_TYPES, 1):
    add("dim_work_type", work_type_sk=i, work_type_code=code, work_type_name=name, is_planned=planned)
work_type_sk = {w[0]: i for i, w in enumerate(WORK_TYPES, 1)}

PARAMS = [("ECOLI", "E. coli", "MPN/100mL", None, 0.0), ("TURB", "Turbidity", "NTU", None, 1.0),
          ("CL_FREE", "Free chlorine", "mg/L", 0.2, 5.0), ("PH", "pH", "pH units", 6.5, 8.5),
          ("FLUORIDE", "Fluoride", "mg/L", None, 1.5)]
add("dim_wq_parameter", parameter_sk=-1, parameter_code="UNKNOWN", parameter_name="Unknown", unit="n/a", guideline_min=None, guideline_max=None)
for i, (code, name, unit, lo, hi) in enumerate(PARAMS, 1):
    add("dim_wq_parameter", parameter_sk=i, parameter_code=code, parameter_name=name, unit=unit, guideline_min=lo, guideline_max=hi)
param_sk = {p[0]: i for i, p in enumerate(PARAMS, 1)}

# --- dim_site and dim_asset from the asset hierarchy ------------------------------------------

golden = list(csv.DictReader(open(HERE.parent / "assets" / "ASSET_GOLDEN.csv")))
by_gid = {g["golden_id"]: g for g in golden}
SITE_TYPES = {"WWTP": "Wastewater treatment plant", "WTP": "Water treatment plant", "SPS": "Sewage pump station",
              "WPS": "Water pump station", "RES": "Storage reservoir"}
add("dim_site", site_sk=-1, site_code="UNKNOWN", site_name="Unknown", site_type="Unknown", region="UNKNOWN", is_drinking_water=False)
site_sk = {}
for g in [g for g in golden if g["asset_level"] == "1"]:
    kind = g["site_code"].split("-")[1]
    site_sk[g["site_code"]] = len(site_sk) + 1
    add("dim_site", site_sk=site_sk[g["site_code"]], site_code=g["site_code"], site_name=g["asset_name"], site_type=SITE_TYPES[kind],
        region=g["region"], is_drinking_water=kind in ("WTP", "WPS", "RES"))

add("dim_asset", asset_sk=-1, asset_tag="UNKNOWN", asset_name="Unknown", asset_class="UNKNOWN", system_name="Unknown",
    facility_name="Unknown", manufacturer=None, criticality=None, install_date=None)
equipment = [g for g in golden if g["asset_level"] == "3"]
asset_sk = {}
for g in equipment:
    system = by_gid[g["parent_golden_id"]]
    facility = by_gid[system["parent_golden_id"]]
    asset_sk[g["golden_id"]] = len(asset_sk) + 1
    add("dim_asset", asset_sk=asset_sk[g["golden_id"]], asset_tag=g["asset_tag"], asset_name=g["asset_name"], asset_class=g["asset_class"],
        system_name=system["asset_name"], facility_name=facility["asset_name"], manufacturer=g["manufacturer"] or None,
        criticality=int(g["criticality"]) if g["criticality"] else None, install_date=g["install_date"] or None)

# --- dim_customer (SCD2) and dim_meter from the CRM ---------------------------------------------

crm = [r for r in csv.DictReader(open(HERE.parent / "crm" / "CUSTOMER.csv")) if r["customer_status"] != "PROSPECT"]
SUBURBS = [("Norwood", "5067"), ("Unley", "5061"), ("Glenelg", "5045"), ("Prospect", "5082"), ("Salisbury", "5108"),
           ("Henley Beach", "5022"), ("Mawson Lakes", "5095"), ("Mount Barker", "5251"), ("Burnside", "5066")]
add("dim_customer", customer_sk=-1, customer_id="UNKNOWN", account_no="UNKNOWN", customer_type="UNKNOWN", customer_name="Unknown",
    suburb="Unknown", postcode="UNKNOWN", concession_type="NONE", segment="UNKNOWN", effective_from="1900-01-01", effective_to=None, is_current=True)
add("dim_meter", meter_sk=-1, meter_no="UNKNOWN", meter_size_mm=0, meter_type="UNKNOWN", manufacturer="Unknown", install_date=None)

customers = []  # per customer: versions [(sk, from, to, concession, type)], meter, tariff, active window
next_sk = 1
for i, r in enumerate(crm, 1):
    name = r["company_name"] or f"{r['first_name']} {r['last_name']}"
    versions = []
    current = dict(suburb=r["suburb"], postcode=r["postcode"], concession=r["concession_type"])
    start = START
    # About 18% of customers change once during the period: a move or a concession change.
    changes = []
    if rng.random() < 0.18:
        changes.append(START + timedelta(days=rng.randint(120, (END - START).days - 120)))
    for change_at in changes + [None]:
        versions.append({"sk": next_sk, "from": start, "to": change_at - timedelta(days=1) if change_at else None, **current})
        add("dim_customer", customer_sk=next_sk, customer_id=r["customer_id"], account_no=r["customer_account_no"],
            customer_type=r["customer_type"], customer_name=name, suburb=current["suburb"], postcode=current["postcode"],
            concession_type=current["concession"], segment=r["segment"], effective_from=start.isoformat(),
            effective_to=(change_at - timedelta(days=1)).isoformat() if change_at else None, is_current=change_at is None)
        next_sk += 1
        if change_at:
            if r["customer_type"] == "RESIDENTIAL" and rng.random() < 0.5:
                current = {**current, "concession": "NONE" if current["concession"] != "NONE" else rng.choice(["PENSIONER", "HEALTH CARE CARD"])}
            else:
                suburb, pc = rng.choice([s for s in SUBURBS if s[0] != current["suburb"]])
                current = {**current, "suburb": suburb, "postcode": pc}
            start = change_at
    business = r["customer_type"] == "BUSINESS"
    size = rng.choice([40, 50, 100]) if business and rng.random() < 0.3 else rng.choice([20, 20, 20, 25]) if not business else rng.choice([25, 40])
    meter_no = f"WM{rng.randint(1_000_000, 9_999_999)}"
    add("dim_meter", meter_sk=i, meter_no=meter_no, meter_size_mm=size, meter_type="Commercial" if business else "Residential",
        manufacturer=rng.choice(["Elster", "Itron", "Kamstrup", "Sensus"]),
        install_date=(date(2005, 1, 1) + timedelta(days=rng.randint(0, 6500))).isoformat())
    # Accounts that are closed or inactive stop being read part-way through.
    ends = END if r["customer_status"] == "ACTIVE" else START + timedelta(days=rng.randint(150, (END - START).days - 30))
    customers.append({"crm": r, "versions": versions, "meter_sk": i, "size": size, "business": business, "end": ends,
                      "base": rng.lognormvariate(math.log(1.8 if business and size >= 40 else 0.9 if business else 0.48), 0.35)})

# --- fact_meter_read ------------------------------------------------------------------------------

SEASON_FACTOR = {12: 1.45, 1: 1.55, 2: 1.45, 3: 1.15, 4: 0.9, 5: 0.75, 6: 0.7, 7: 0.68, 8: 0.72, 9: 0.85, 10: 1.0, 11: 1.2}
read_no = 5_000_000
for cust in customers:
    offset = rng.randint(0, 89)  # reading cycle: each customer is read on their own day of the quarter
    prev = START + timedelta(days=offset)
    while True:
        read = prev + timedelta(days=rng.randint(86, 95))
        if read > cust["end"]:
            break
        days = (read - prev).days
        version = next(v for v in cust["versions"] if v["from"] <= read and (v["to"] is None or read <= v["to"]))
        if cust["business"]:
            tcode = "BUS-LRG" if cust["size"] >= 40 else "BUS-STD"
        else:
            tcode = "RES-CONC" if version["concession"] != "NONE" else "RES-STD"
        tariff = TARIFFS[tariff_sk[tcode] - 1]
        mid = prev + timedelta(days=days // 2)
        per_day = cust["base"] * SEASON_FACTOR[mid.month] * rng.uniform(0.85, 1.15)
        kl = round(per_day * days, 2)
        tier1 = min(kl, tariff[4] * days)
        usage = round(tier1 * tariff[3] + (kl - tier1) * tariff[5], 2)
        estimated = rng.random() < 0.04
        read_no += rng.randint(1, 9)
        add("fact_meter_read", read_date_sk=sk(read), customer_sk=version["sk"], meter_sk=cust["meter_sk"], tariff_sk=tariff_sk[tcode],
            read_no=f"R{read_no}", read_type="ESTIMATED" if estimated else "ACTUAL", days_in_period=days, consumption_kl=kl,
            usage_charge=usage, supply_charge=round(tariff[6] * days / 91, 2))
        prev = read

# --- fact_work_order --------------------------------------------------------------------------------

wo_no = 400_000
for g in equipment:
    site = site_sk[g["site_code"]]
    crit = int(g["criticality"] or 3)
    plan_every = {1: 60, 2: 91, 3: 120, 4: 182, 5: 365}[crit]
    events = []
    t = START + timedelta(days=rng.randint(0, plan_every))
    while t <= END:
        events.append((t, rng.choices(["PM", "INSP", "CAL"], [70, 20, 10])[0]))
        t += timedelta(days=plan_every + rng.randint(-10, 10))
    for _ in range(rng.choices([0, 1, 2, 3, 4], [30, 30, 20, 12, 8])[0] + (2 if crit <= 2 else 0)):
        events.append((START + timedelta(days=rng.randint(0, (END - START).days)), "EM" if rng.random() < 0.15 else "CM"))
    for raised, wtype in sorted(events):
        planned = wtype in ("PM", "INSP", "CAL")
        completed = raised + timedelta(days=rng.randint(0, 3) if wtype == "EM" else rng.randint(1, 21 if planned else 45))
        if completed > END:
            continue
        hours = round(rng.uniform(1, 6) if planned else rng.uniform(2, 24) * (1.6 if wtype == "EM" else 1), 2)
        rate = rng.choice([118.0, 126.5, 142.0]) * (1.5 if wtype == "EM" else 1)
        material = round(0 if wtype in ("INSP", "CAL") else rng.uniform(20, 400) if planned else rng.lognormvariate(math.log(900), 0.9), 2)
        downtime = round(0 if planned and rng.random() < 0.7 else hours * rng.uniform(0.5, 2.5), 2)
        wo_no += rng.randint(1, 5)
        add("fact_work_order", raised_date_sk=sk(raised), completed_date_sk=sk(completed), asset_sk=asset_sk[g["golden_id"]],
            site_sk=site, work_type_sk=work_type_sk[wtype], work_order_no=f"WO{wo_no}", labour_hours=hours,
            labour_cost=round(hours * rate, 2), material_cost=material, downtime_hours=downtime)

# --- fact_water_quality -------------------------------------------------------------------------------

sample_no = 9_000_000
drinking = [s for s in T["dim_site"]["rows"] if s["is_drinking_water"]]
for s in drinking:
    t = START + timedelta(days=rng.randint(0, 6))
    while t <= END:
        sample_no += 1
        for code, name, unit, lo, hi in PARAMS:
            if code == "FLUORIDE" and t.day > 7:  # fluoride is sampled monthly
                continue
            v = {
                "ECOLI": 0.0 if rng.random() > 0.004 else float(rng.randint(1, 4)),
                "TURB": round(rng.lognormvariate(math.log(0.18 if s["site_type"] != "Storage reservoir" else 0.3), 0.6), 3),
                "CL_FREE": round(max(0.0, rng.gauss(0.75 if s["site_type"] == "Water treatment plant" else 0.45, 0.2)), 3),
                "PH": round(rng.gauss(7.6, 0.25), 3),
                "FLUORIDE": round(rng.gauss(0.85, 0.08), 3),
            }[code]
            exceed = (lo is not None and v < lo) or (hi is not None and v > hi)
            add("fact_water_quality", sample_date_sk=sk(t), site_sk=s["site_sk"], parameter_sk=param_sk[code],
                sample_no=f"S{sample_no}", result_value=v, exceedance_count=int(exceed))
        t += timedelta(days=7)

# --- write CSVs and loaders --------------------------------------------------------------------------------


def fmt(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    return v


for name, t in T.items():
    cols = [col[0] for col in t["columns"]]
    with open(HERE / f"{name.upper()}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for row in t["rows"]:
            w.writerow([fmt(row.get(col)) for col in cols])

order = [n for n in T if n.startswith("dim_")] + [n for n in T if n.startswith("fact_")]
q = lambda s: s.replace("'", "''")

pg = [
    "-- Loads the sample water utility star schema into Lakebase (or any Postgres), schema water_star.",
    "-- Generated by generate_star.py. Run from this folder:",
    '--   psql "host=<lakebase-host> dbname=databricks_postgres user=<you> sslmode=require" -f load_lakebase.sql',
    f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE;",
    f"CREATE SCHEMA {SCHEMA};",
    "",
]
for name in order:
    t = T[name]
    lines = [f"  {col} {pgt}{'' if nullable else ' NOT NULL'}" for col, pgt, _, nullable, _ in t["columns"]]
    if t["pk"]:
        lines.append(f"  CONSTRAINT pk_{name} PRIMARY KEY ({t['pk']})")
    if t["business"]:
        lines.append(f"  CONSTRAINT uq_{name}_business_key UNIQUE ({', '.join(t['business'])})")
    for col, ref in t["refs"].items():
        lines.append(f"  CONSTRAINT fk_{name}_{col} FOREIGN KEY ({col}) REFERENCES {SCHEMA}.{ref} ({T[ref]['pk']})")
    pg.append(f"CREATE TABLE {SCHEMA}.{name} (\n" + ",\n".join(lines) + "\n);")
    pg.append(f"COMMENT ON TABLE {SCHEMA}.{name} IS '{q(t['comment'])}';")
    for col, _, _, _, comment in t["columns"]:
        if comment:
            pg.append(f"COMMENT ON COLUMN {SCHEMA}.{name}.{col} IS '{q(comment)}';")
    pg.append(f"\\copy {SCHEMA}.{name} FROM '{name.upper()}.csv' WITH (FORMAT csv, HEADER true)")
    pg.append("")
pg.append("SELECT " + ",\n       ".join(f"(SELECT count(*) FROM {SCHEMA}.{n}) AS {n}" for n in order) + ";")
(HERE / "load_lakebase.sql").write_text("\n".join(pg) + "\n")

uc = [
    "-- Loads the sample water utility star schema into Unity Catalog. Generated by generate_star.py.",
    "-- 1. Create the schema and a volume, then upload the CSV files to it (Catalog Explorer → the volume → Upload):",
    "--      CREATE SCHEMA IF NOT EXISTS main.water_star;",
    "--      CREATE VOLUME IF NOT EXISTS main.water_star.raw;",
    "-- 2. Run this in the SQL editor. Replace main.water_star if you use another catalog or schema.",
    "-- Primary and foreign keys are informational in Unity Catalog: they document the star and drive the ERD.",
    "-- Safe to re-run: facts are dropped before the dimensions they reference.",
    "",
    *[f"DROP TABLE IF EXISTS main.{SCHEMA}.{n};" for n in reversed(order)],
    "",
]
for name in order:
    t = T[name]
    lines = [f"  {col} {uct}{'' if nullable else ' NOT NULL'}" + (f" COMMENT '{q(cm)}'" if cm else "") for col, _, uct, nullable, cm in t["columns"]]
    if t["pk"]:
        lines.append(f"  CONSTRAINT pk_{name} PRIMARY KEY ({t['pk']})")
    uc.append(f"CREATE OR REPLACE TABLE main.{SCHEMA}.{name} (\n" + ",\n".join(lines) + f"\n) COMMENT '{q(t['comment'])}';")
    schema_str = ", ".join(f"{col} {uct}" for col, _, uct, _, _ in t["columns"])
    uc.append(f"INSERT INTO main.{SCHEMA}.{name}\nSELECT * FROM read_files('/Volumes/main/{SCHEMA}/raw/{name.upper()}.csv',\n"
              f"  format => 'csv', header => true, schema => '{schema_str}');")
    uc.append("")
for name in order:
    for col, ref in T[name]["refs"].items():
        uc.append(f"ALTER TABLE main.{SCHEMA}.{name} ADD CONSTRAINT fk_{name}_{col} FOREIGN KEY ({col}) REFERENCES main.{SCHEMA}.{ref} ({T[ref]['pk']});")
(HERE / "load_unity_catalog.sql").write_text("\n".join(uc) + "\n")

# A saved ERD Explorer data model with the star annotations (roles, business
# keys, SCD type, grain), so opening it in the app shows the classified star.
import json

GRAINS = {
    "fact_meter_read": "One row per meter read (a customer's quarterly reading of one meter)",
    "fact_work_order": "One row per completed work order",
    "fact_water_quality": "One row per lab result (one parameter of one sample)",
}
star = {}
for name in order:
    t = T[name]
    if name.startswith("dim_"):
        business = [b for b in t["business"] if b != "effective_from"]
        star[f"{SCHEMA}.{name}"] = {"role": "dimension", "scd": 2 if name == "dim_customer" else 1, "surrogate": t["pk"],
                                    "business": business, "grain": None, "identity": name != "dim_date"}
    else:
        star[f"{SCHEMA}.{name}"] = {"role": "fact", "scd": None, "surrogate": None, "business": [], "grain": GRAINS[name], "identity": True}
content = json.dumps({"tables": [], "positions": {}, "relationships": [], "cardinality": {}, "star": star})
model_sql = f"""-- Saves an ERD Explorer data model, "Water utility star schema", with the star schema
-- annotations for the water_star tables (Lakebase source). Generated by generate_star.py.
-- Open ERD Explorer once first so it creates its refdata tables, then run:
--   psql "host=<lakebase-host> dbname=databricks_postgres user=<you> sslmode=require" -f load_model_lakebase.sql
-- In the app: Lakebase, schema water_star, Data model: Water utility star schema.
DO $$ BEGIN
  IF to_regclass('refdata.data_model') IS NULL THEN
    RAISE EXCEPTION 'refdata.data_model does not exist yet: open ERD Explorer once, then run this again';
  END IF;
END $$;
DELETE FROM refdata.data_model WHERE source_system = 'lakebase' AND scope = '{SCHEMA}' AND lower(name) = 'water utility star schema';
WITH m AS (
  INSERT INTO refdata.data_model (name, description, source_system, scope, content, created_by, updated_by)
  VALUES ('Water utility star schema', 'Facts and dimensions of the sample water utility warehouse',
          'lakebase', '{SCHEMA}', '{q(content)}'::jsonb, 'sample-data', 'sample-data')
  RETURNING *
)
INSERT INTO refdata.data_model_version (model_id, version, name, description, content, saved_by)
SELECT id, version, name, description, content, 'sample-data' FROM m;
"""
(HERE / "load_model_lakebase.sql").write_text(model_sql)

for name in order:
    print(f"{name:20} {len(T[name]['rows']):6} rows")
