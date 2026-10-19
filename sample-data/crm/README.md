# Sample CRM customer data

`CUSTOMER.csv` holds 1,000 **fictional** customer records for a water utility,
as a CRM would hold them. It's meant for testing the ERD Explorer's profiling,
PII detection, reference data and master data features.

**What it contains:**

| Kind | Columns |
| --- | --- |
| Personal data (PII) | `first_name`, `last_name`, `preferred_name`, `date_of_birth`, `gender`, `email`, `mobile_phone`, `home_phone`, `street_address`, `latitude`/`longitude` (home location), `concession_card_number`, `bsb`, `bank_account_number`, `portal_username`, `last_login_ip`, `created_by`/`last_modified_by`/`account_manager` |
| Categorical | `customer_type`, `customer_status`, `segment`, `lead_source`, `preferred_contact_method`, `marketing_opt_in`, `concession_type`, `payment_method`, `title`, `state`, `suburb` |
| Other | `customer_id`, `customer_account_no`, `company_name`, `lifetime_value`, dates, and free-text `notes` (some notes contain a phone number, which column-level detection doesn't catch) |

**Nothing in it is real.** It comes from `generate_customers.py` with a fixed
seed, built from name lists, real Adelaide suburbs and postcodes, and random
street numbers. Contact details use ranges reserved for testing or fiction:

- emails on `example.com`, `example.net` and `example.org`
- phone numbers in the `(08) 5550 xxxx` and `0491 570 xxx` ranges
- IP addresses from the RFC 5737 documentation ranges
- bank and concession numbers that are random

To regenerate it, or make a different size:

```bash
python3 generate_customers.py 5000 > CUSTOMER.csv
```

## Load into Lakebase

```bash
cd sample-data/crm
psql "host=<lakebase-host> dbname=databricks_postgres user=<you> sslmode=require" -f load_lakebase.sql
```

This creates `crm.customer` with `customer_id` as the primary key. To edit rows
from the app, grant the app's service principal access:

```sql
GRANT USAGE ON SCHEMA crm TO "<sp-client-id>";
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.customer TO "<sp-client-id>";
```

## Load into Unity Catalog (UI)

1. **Catalog → + Add data → Create or modify table**, then upload `CUSTOMER.csv`.
2. Choose a catalog and schema (for example `main.crm`), set the table name to
   `customer`, check the preview, and click **Create table**.
3. Optionally run `load_unity_catalog.sql` in the SQL editor to add the primary
   key and a comment.
4. Grant the app's service principal `SELECT` on the schema. Profiling needs
   `SELECT`; `BROWSE` isn't enough.

Then, in ERD Explorer, open the schema, click **Profile data**, and select
`customer`.
