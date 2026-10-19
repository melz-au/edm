# Sample billing customer extract (with data quality issues)

`CUSTOMER_MASTER.csv` is a **fictional** raw customer extract from a legacy
billing system ("HydroBill"). It's the second source for the same water utility
as `../crm/CUSTOMER.csv`. It looks the way legacy extracts usually do: inconsistent,
duplicated and partly wrong. Use it to test profiling, PII detection, reference
data (code mapping), matching and data quality rules.

| File | Contents |
| --- | --- |
| `CUSTOMER_MASTER.csv` | 1,047 rows, 30 columns, all text, Windows line endings |
| `DQ_ISSUES.csv` | Ground truth: every injected issue (`cust_no`, `column`, `issue`, `detail`), 2,519 rows |
| `generate_billing_customers.py` | Seeded generator that builds the extract from `../crm/CUSTOMER.csv` |
| `load_lakebase.sql`, `load_unity_catalog.sql` | Loaders (raw landing table, all columns as text, no primary key) |

## How it relates to the CRM

- About 880 rows are CRM customers. Prospects never reach billing, and about 6%
  of billed CRM customers are missing.
- 120 rows are **billing-only** customers that don't exist in the CRM.
- **Linking key:** `ACCT_NUM` corresponds to CRM `customer_account_no`, but it
  comes in different formats: `WC-2514886`, `WC2514886`, `2514886` and
  ` wc-2514886 `. To normalise it, trim, uppercase, and remove `WC` and `-`
  from both sides before joining.
- Codes differ from the CRM, so they need reference data mappings:

  | Field | Billing codes | CRM values |
  | --- | --- | --- |
  | Status | `A`/`I`/`C` | `ACTIVE`/`INACTIVE`/`CLOSED` |
  | Type | `RES`/`BUS` | `RESIDENTIAL`/`BUSINESS` |
  | Payment | `DD`, `BPAY`, `CC`, `CP`, `CHQ` | `DIRECT DEBIT`, `BPAY`, `CARD`, `CENTREPAY`, `CHEQUE` |

## Injected data quality issues

| Category | Issues (column) |
| --- | --- |
| **Formats** | Dates in four formats: `dd/mm/yyyy`, ISO, `DD-MON-YY` with an ambiguous century, and some `mm/dd/yyyy` with day and month swapped (`DOB`, `CONNECT_DATE`, …). The legacy timestamp format is `yyyymmddHHMMSS`. Phones appear as `0491570018`, `+61491570018`, `61 491 …`, with the leading zero lost, or without an area code. Postcodes appear as `5066.0`. Bank accounts appear in scientific notation (`3.74235E+7`). Balances appear as `$1,234.50` or `(45.00)`. |
| **Codes** | Non-standard values (`Active`, `act`, `CLOSED `, `R`, `Commercial`, `Direct Debit`, `D/D`, `S.A.`, `South Australia`, `sa`, `Male`, `1`, `TRUE`, `yes`) |
| **Missing values** | Empty strings plus tokens `NULL`, `N/A`, `-`, `UNKNOWN`, and a single space |
| **Placeholders** | DOB `01/01/1900`, mobile `0400000000`, email `noemail@example.com` |
| **Invalid values** | Emails without `@` or with `@@`, domain typos (`example.con`), future DOBs, truncated postcodes |
| **Text quality** | Names as `SURNAME, FIRST`, `First Last`, `MR F SURNAME`, or swapped. Extra or trailing whitespace. Mojibake (`Oâ€™Connor`). Suburb typos and abbreviations (`GLENLEG`, `NTH ADELAIDE`, `MT BARKER`). Street-type variants (`RD`, `RD.`, `ROAD`). |
| **Consistency** | `STATE` = `NSW` with SA postcodes. Postcodes that don't match the suburb. `CONC_FLAG = N` while a concession card is present. Disconnect dates before connect dates. Status conflicting with the CRM. |
| **Duplicates** | 10 exact duplicate rows (a re-run extract), 40 fuzzy duplicates (same customer under a new `CUST_NO`), and meters shared by two customers |
| **PII leakage** | Dates of birth written into free-text `COMMENTS` |

`DQ_ISSUES.csv` lists each one, so you can score data quality checks for
recall and precision.

## Load

**Lakebase:**
```bash
cd sample-data/billing
psql "host=<lakebase-host> dbname=databricks_postgres user=<you> sslmode=require" -f load_lakebase.sql
```
This creates `billing.customer_master` and `billing.dq_issues`.

**Unity Catalog (UI):**
1. **Catalog → + Add data → Create or modify table**, then upload `CUSTOMER_MASTER.csv`.
2. Under advanced attributes, turn off column type inference so every column
   stays a string.
3. Name the table `customer_master` in a schema such as `main.billing`.
4. Upload `DQ_ISSUES.csv` the same way if you want the ground truth there.

The table has no primary key on purpose, because of the exact duplicates. That
means ERD Explorer shows it read-only for master data editing.

Regenerate it with `python3 generate_billing_customers.py`. It reads `../crm/CUSTOMER.csv`.
