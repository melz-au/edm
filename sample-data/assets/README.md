# Sample asset hierarchy (with duplicate and inconsistent records)

`ASSET_HIERARCHY.csv` is a **fictional** extract from a water utility's legacy
asset register. The register was merged over the years from Hansen, GIS,
spreadsheets and a Maximo migration, so the same physical asset was often
entered more than once, each time a little differently. Use it to test
profiling, reference data (code mapping), matching and survivorship (master
data), hierarchy checks and data quality rules.

The hierarchy has three levels:

| Level | What it is | Examples | Real assets |
| --- | --- | --- | --- |
| 1 · Facility | A site | Dunmore Wastewater Treatment Plant, Hartley Water Treatment Plant, Ashford Sewage Pump Station, Torrens Storage Reservoir | 9 |
| 2 · System | A process area within a facility | Inlet Works, Aeration System, Filtration, Chlorine Disinfection, Wet Well, Pump Set, Electrical & Control | 46 |
| 3 · Equipment | A maintainable item | Aeration Blower No. 2, Submersible Pump, Blower VSD, Chlorine Residual Analyser, Butterfly Valve, Main Switchboard, SCADA RTU | 218 |

Each record's parent is held in `PARENT_ASSET_ID`: equipment points to its
system, and a system points to its facility. Facilities, `SITE_CODE`s and
classes follow the fictional Maximo sample in the repository root, so
`SITE_CODE` joins to `LOCATIONS.LOCATION` (e.g. `ME-WWTP-006`) and the canonical
classes match `CLASSSTRUCTURE.CLASSIFICATIONID` (e.g. `PUMP\SUB`).

| File | Contents |
| --- | --- |
| `ASSET_HIERARCHY.csv` | The raw register: 545 rows, 21 columns, all text, Windows line endings |
| `ASSET_GOLDEN.csv` | Ground truth: 273 real assets with clean values and the correct parent |
| `ASSET_MATCH.csv` | Ground truth: which real asset (`golden_id`) each raw `ASSET_ID` describes |
| `DQ_ISSUES.csv` | Ground truth: every injected issue (`asset_id`, `column`, `issue`, `detail`), 2,633 rows |
| `generate_asset_hierarchy.py` | Seeded generator; rerun it to rebuild all four files |
| `load_lakebase.sql`, `load_unity_catalog.sql` | Loaders |

## How the duplicates look

Every facility has 2–4 records, and so do almost two thirds of the systems and
the equipment. Each copy was typed differently. Here is one blower drive at
Dunmore:

| ASSET_ID | ASSET_TAG | ASSET_DESC | ASSET_LEVEL | ASSET_CLASS | MANUFACTURER | SERIAL_NO | RATING |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `H081046` | `dun-aer-vsd-01` | Blower Variable Speed Drive No. 1 | `3` | `ELEC\VSD` | A.B.B. | `30553321` | `132kW` |
| `201992` | `DUN-AER-VSD-01` | BLOWER VARIABLE SPEED DRIVE #1 | `3` | `VSD` | A.B.B. | `S/N 30553321` | `132kW` |
| `GIS-89639` | `DUN-AER-VSD-01` | Blower VSD 1 | `3` | `VSD` | ABB | `S/N 30553321` | `132kW` |

The strongest match keys are a cleaned `ASSET_TAG` (uppercase, no separators)
and the digits of `SERIAL_NO`. The weaker ones are description similarity
within the same `SITE_CODE` and class, and the parent.

## Injected data quality issues

| Category | Issues (column) |
| --- | --- |
| **Duplicates** | 264 extra records for assets already in the register, from different source systems. Facility and system names vary (`Dunmore WWTP`, `DUNMORE W.W.T.P.`, `Dunmore Sewage Treatment Works`; `Aeration`, `Bioreactor - Aeration`, `DUN Aeration System`), and so do equipment names (`Pump Variable Speed Drive No. 1`, `PUMP VARIABLE SPEED DRIVE #1`, `Drive 1`). Tags lose their dashes, change case or get an `OLD-` prefix. 8 exact duplicate rows come from a re-run load. |
| **Codes** | 16 spellings of `ASSET_LEVEL` (`3`, `L3`, `Equipment`, `3.0`, `EQUIP`), 80 of `ASSET_CLASS` (`PUMP\SUB`, `PUMP/SUB`, `SUB PUMP`, `Submersible Pump`, `PUMP`), 16 of `STATUS` (`OPERATING`, `In Service`, `IN SVC`, `Op`), 16 of `REGION` (`METRO`, `Metro`, `MET`), and `CRITICALITY` as `1`–`5` or `High`/`H`/`A` |
| **Manufacturers** | about 80 spellings of 21 makers (`Flygt`, `FLYGT`, `Xylem Flygt`, `ITT Flygt`, `Fligt`; `Endress+Hauser`, `E+H`, `Endress & Hauser`) |
| **Hierarchy** | Children are spread across their parent's duplicate records (337 links). Parents are missing (17), point at an ID that doesn't exist (12), are entered as a tag instead of an ID (20), or skip a level, with equipment linked straight to the facility (13). There are 2 circular references, where a system's parent is its own equipment. |
| **Conflicts between duplicates** | One copy is `Decommissioned` while another is operating (a replacement that was never linked), with different install dates, criticality, ratings, models or serial numbers |
| **Formats** | `INSTALL_DATE` as `dd/mm/yyyy`, ISO, `DD-MON-YY`, a year only, an Excel serial (`36639`) or `mm/dd/yyyy`. Ratings as `45kW`, `45 KW`, `45`, `0.045 MW`. Serials as `SN12345678`, `S/N …`, `sn…`, digits only, or truncated. |
| **Coordinates** | Latitude and longitude swapped, `0,0`, latitude with its minus sign lost, or blank in spreadsheet records |
| **Missing values** | Empty strings plus `NULL`, `N/A`, `-`, `TBA`, `UNKNOWN` and a single space |

`DQ_ISSUES.csv` lists each one, so you can score data quality checks and
matching for recall and precision. `ASSET_MATCH.csv` is the answer key for
de-duplication.

## Load

**Lakebase:**
```bash
cd sample-data/assets
psql "host=<lakebase-host> dbname=databricks_postgres user=<you> sslmode=require" -f load_lakebase.sql
```
This creates these tables in schema `assets`:
- `asset_hierarchy`: the raw register, all text, with no primary key.
- `asset_golden`: typed, with a primary key and a parent → asset foreign key,
  so ERD Explorer draws the self-referencing hierarchy.
- `asset_match`: references `asset_golden`.
- `dq_issues`.

**Unity Catalog (UI):** upload `ASSET_HIERARCHY.csv` with **Catalog → + Add
data → Create or modify table**, with column type inference turned off, as
table `asset_hierarchy` in a schema such as `main.assets`. Upload the
ground-truth files the same way if you want them. `load_unity_catalog.sql`
adds the table comment, and optional keys for the golden hierarchy.

## Things to try in ERD Explorer

- **Profile data** on `asset_hierarchy`. `ASSET_LEVEL`, `STATUS`, `REGION`
  and `CRITICALITY` show up as categorical fields. Create code sets for them,
  then **Map to code set** to fold `L3`/`Equipment`/`3.0` into one code.
- **Data quality → Suggest rules**, then run them. Compare the failing counts
  with `DQ_ISSUES.csv`.
- On `asset_golden`, select a facility to see its systems through the
  self-reference, and switch to the logical or conceptual view.
