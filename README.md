# ERD Explorer

A Databricks App that draws an interactive **entity relationship diagram** for a
**Unity Catalog** schema or a **Lakebase** (Postgres) schema. You can pan, zoom,
search and click through tables. A built-in demo schema works with no
configuration.

- Pan by dragging or scrolling, and zoom with pinch or ctrl+scroll. There are also
  a minimap and fit/re-layout controls.
- Tables are laid out automatically, with primary and foreign keys marked and
  crow's-foot relationship lines. The layout fills the browser window: groups
  of related tables and unrelated tables are packed into rows sized to the
  window's shape. With columns hidden, long chains can flow top-to-bottom. Use
  the re-layout button (⟲) after resizing the window.
- Hover or select a table to highlight its relationships. The details panel lists
  its columns, the tables it references and the tables that reference it.
- You can show all columns, keys only, or table names only.
- **Three model levels**, switchable at any time:
  - **Physical:** tables, columns and database types exactly as stored.
  - **Logical:** business names (`order_items` → *Order Item*, `customer_id`
    → *Customer ID*), generic data types (*Integer*, *Text*, *Timestamp* and
    so on), keys and cardinality.
  - **Conceptual:** entities and relationships only. Pure junction tables
    (whose primary key is made up of foreign keys to exactly two other tables)
    collapse into many-to-many relationships.
- Cardinality comes from the keys at every level. A nullable foreign key is an
  optional relationship (○), and a foreign key that is also the child's
  primary key is one-to-one.
- Optional **relationship inference** from column names (`customer_id` →
  `customers.id`). Unity Catalog foreign keys are informational and often not
  declared, so this helps there. Inferred links are drawn dashed.
- Tables referenced from outside the selected schema appear as dashed "REF" nodes.

## Categorical fields, reference data and master data

**Detect categorical fields.** *Detect categorical fields* (sidebar, or per
table in the details panel) samples up to 10,000 rows of each table. It flags
columns with few distinct values relative to their rows, such as `STATUS`,
`ASSETTYPE`, `SITEID` or Y/N flags, and shows each one's top values; flagged
columns get a purple **CAT** badge in the diagram. Keys, foreign keys,
mostly-unique text, amounts, coordinates and dates are skipped. Names like
*status*, *type* and *code* raise confidence. Lakebase tables are profiled
directly; Unity Catalog tables need a SQL warehouse (see below). The limit on
distinct values is 50, configurable with `ERD_CATEGORICAL_MAX_DISTINCT`.

**Detect personal data (PII).** The same profiling pass (sidebar **Profile
data**) flags columns holding personal data with a red **PII** badge. It uses
two kinds of evidence:

- **Column name:** `email`, `first_name`, `mobile`, `dob`, `tfn`/`ssn`/
  `passport`/`medicare`, `credit_card`/`bsb`/`bank_account`, `password`,
  `gender`, `address`, and audit columns such as `created_by`/`CHANGEBY`.
- **Sampled values** (up to 100 per text column): email addresses, phone
  numbers, card numbers that pass the Luhn check, IP/MAC addresses, IBANs, US
  SSNs and formatted AU TFNs (with checksum). A column named `contact` that
  holds email addresses is still caught.
- **Free text** (notes, comments): values are scanned for embedded email
  addresses, phone numbers, card numbers and "DOB …" mentions. The finding
  only says what kind of data was found, with no examples.

Each finding has a type, a **sensitivity** and a **confidence**. High
sensitivity covers IDs, financial data, credentials, birth dates and special
categories. Medium covers contact details, names and user IDs. Low covers
location. Coordinates and postcodes are only flagged in tables that also hold
direct personal details, so asset and site locations aren't. Values from PII
columns are **masked on the server** (`j•••@example.com`, `•••• 1111`) in the
profile, in categorical top values and in the distinct-values endpoint, and
PII columns aren't offered as code sets. Detection is a heuristic aid, not a
compliance guarantee: review the results.

**Data quality checks.** In a table's details panel, **Data quality →
Suggest rules** profiles the table and proposes checks. Each comes with the
reason it was suggested:

| Rule | Suggested when |
| --- | --- |
| Unique | Primary keys, and identifier-like columns (`*_NO`, `*_ID`, email) that are at least 90% distinct, so the repeats get caught |
| Not null | Primary keys, and columns at least 95% filled. Blanks and tokens like `N/A`, `NULL` and `-` count as missing |
| Allowed values | Categorical columns. Values come from the linked code set, the approved code mappings, or the dominant values. In a clean list every value stays allowed; in a dirty one, spelling variants fold into the main spelling (`S.A.`, `sa` → `SA`) and the variants fail |
| Format | The dominant value shape (`AA9999999`, `99/99/9999`, `999-999`) for structured columns, plus email and Australian phone formats for detected PII |
| Not in the future | Date columns for past events (birth, created, install, connect, …) |
| References | Declared foreign keys: the value must exist in the parent table. This is useful for Unity Catalog, where keys aren't enforced |

You pick which suggestions to add, then **Run checks**. Each rule shows its pass
rate, failing row count and most common failing values (masked for PII). Rules
other than not null judge present values only. The table gets an overall score,
also shown as a **DQ %** badge on the diagram. Rules and their latest results are
stored in `refdata.dq_rule` in Lakebase. Checks run directly on Lakebase, or
through the SQL warehouse for Unity Catalog tables.

On `sample-data/billing` the suggested rules catch the injected issues, for
example:

- the 10 exact duplicate rows
- duplicate account numbers and shared meters
- every non-standard `STATE`, `ACCT_TYPE` and `CONC_FLAG` value
- the 27 home phones without an area code
- the 16 bank accounts in scientific notation
- invalid and badly formatted emails
- mixed date formats

**Reference data.** Any categorical field can become a managed **code set**:
*Create code set* reads all of the column's distinct values. Review the codes,
add labels and descriptions, and submit. The **Reference data** tab lists code
sets, where codes can be added, edited, deactivated and reactivated.

**Code mapping.** Other systems often use different codes for the same thing,
such as billing `A`, `act` and `Active` versus CRM `ACTIVE`. To standardise
them, use *Map to code set* on a categorical field from the other source. This
loads every distinct value with its row count and suggests a target code for
each one:

- exact match, ignoring case, spaces and punctuation (`Closed ` → CLOSED, `S.A.` → SA)
- abbreviation (`act` → ACTIVE)
- initials (`DD` → Direct Debit)
- a word of the value (`Credit Card` → CARD)
- letters in order (`CHQ` → CHEQUE)
- small typos
- missing-value tokens (`N/A`, `NULL`, `-` → *treat as missing*)
- earlier decisions for the same value in another source

Ties and anything without a match are left for you to decide, and a coverage
bar shows the share of rows mapped. The result is submitted for approval like
any other change, with a conflict check on approval. Approved mappings live in
`refdata.code_mapping`. The **Source mappings** tab of each code set lists
them, and the view `refdata.code_mapping_v` (raw value → code, label,
`maps_to_missing`) is ready for pipelines to join.

**Sync to Unity Catalog.** Reference data is managed in Lakebase, and there
are two ways to make it available in Unity Catalog.

1. **Publish as Delta tables (built in).** On the **Reference data** page, a
   steward sets a target `catalog.schema` (e.g. `main.refdata`) in the **Unity
   Catalog sync** panel, then clicks **Publish now**, or turns on *Publish
   automatically after each approved change*. The app writes three Delta
   tables through its SQL warehouse:

   | Table | Contents |
   | --- | --- |
   | `code_set` | Code sets and their source column |
   | `code_value` | Codes, labels, order and active flag, with the set name |
   | `code_mapping` | `source_system`, `source_table`, `source_column`, `source_value` → `code`, `label`, `maps_to_missing` |

   Each table is replaced in a single `CREATE OR REPLACE TABLE … AS SELECT`, so
   readers never see a half-written table. Delta history keeps every published
   version (`DESCRIBE HISTORY`, `VERSION AS OF`). Runs are serialised, logged
   in `refdata.publish_log`, and shown in the panel. The service principal
   needs these grants on the target schema:
   ```sql
   GRANT USE CATALOG ON CATALOG main TO `<sp-application-id>`;
   GRANT USE SCHEMA, CREATE TABLE, MODIFY, SELECT ON SCHEMA main.refdata TO `<sp-application-id>`;
   ```
   Standardise source codes in a notebook or pipeline:
   ```sql
   SELECT b.*, coalesce(m.code, CASE WHEN m.maps_to_missing THEN NULL ELSE 'UNMAPPED' END) AS account_status
   FROM main.billing.customer_master b
   LEFT JOIN main.refdata.code_mapping m
     ON  m.source_table = 'billing.customer_master' AND m.source_column = 'ACCT_STATUS'
     AND m.source_value = b.ACCT_STATUS;
   ```
   The defaults can also be set with `ERD_UC_REFDATA_TARGET` and
   `ERD_UC_AUTO_PUBLISH=true`.

2. **Register the Lakebase database in Unity Catalog (no copy, read-only).**
   In Catalog Explorer, create a catalog of type *Lakebase Postgres* for your
   database. The `refdata` tables and the `code_mapping_v` view can then be
   queried live from Databricks SQL. This needs a serverless SQL warehouse; see
   [Register a Lakebase database in Unity Catalog](https://docs.databricks.com/aws/en/oltp/projects/register-uc).
   Option 1 suits pipelines that want versioned Delta tables, and option 2
   suits live lookups.

**Master data.** For Lakebase tables with a primary key, *Edit master data* in
the details panel opens a row browser with search and paging. You can propose
new rows, edits and deletes.

**Approval workflow.** Every change, whether to code sets, codes or master data
rows, becomes a *change request*:

1. Anyone proposes a change. It waits as **pending**, and the **Approvals** tab
   shows the field-by-field before/after.
2. A **data steward** (`ERD_STEWARDS`) approves or rejects it, with an optional
   comment. Stewards can't approve their own requests, and requesters can
   cancel theirs.
3. On approval the change is applied in the same transaction and written to the
   **change history** (audit log) with before and after images, who requested
   it and who approved it.
4. If the data changed between request and approval (someone else edited the
   row), the request is marked **failed** rather than overwriting that edit.

Everything is stored in Lakebase, in the `refdata` schema (`ERD_REFDATA_SCHEMA`),
which is created on first use:

| Table | Holds |
| --- | --- |
| `code_set` | Named code lists, optionally linked to the source column |
| `code_value` | Codes with label, description, sort order and active flag |
| `code_mapping` | Raw source values (system, table, column, value) mapped to a code, or to *missing* |
| `code_mapping_v` | View joining the mappings to set name, code and label, for pipelines |
| `setting`, `publish_log` | Unity Catalog publish settings and run history |
| `dq_rule` | Data quality rules per table, with their latest result |
| `change_request` | Every proposed change, its status and review |
| `audit_log` | Every applied change with before/after JSON |

Users are identified by the email Databricks Apps forwards for the signed-in
user (`X-Forwarded-Email`). Outside Databricks Apps that header is just a
request header, so don't expose a locally run server to other people.

## Upload a CSV to a bronze table

The **Upload CSV** tab lets anyone, without writing SQL, turn a spreadsheet
export into a **bronze** Unity Catalog table: a raw copy of the file that data
engineers clean up into silver later.

1. **Choose your file:** drag a `.csv`, `.tsv` or `.txt` file onto the page (or
   browse). It is read in the browser first: the separator (comma, semicolon,
   tab or pipe) is detected, and rows are counted.
2. **Check your data:** each column gets a database-safe name (`Customer ID`
   → `customer_id`, duplicates get `_2`), with a hint of what it holds
   (number, date, yes/no, text) and example values. Any name can be changed,
   and problems such as rows with a different number of values are explained in
   plain language.
3. **Choose where to save it:** pick a catalog and schema (`bronze` is
   preselected when it exists) and a table name (suggested from the file name).
   To put the table in a new schema, choose **+ Create a new schema…** and type
   its name; it is created when the file is loaded. A catalog with no schemas
   starts in this mode with `bronze` filled in.
   If the table exists, choose to **add the rows** to it (only offered when its
   columns match) or **replace** it.

On **Load to bronze table** the file is uploaded unchanged to a landing volume,
`/Volumes/<catalog>/<schema>/landing/uploads/<date>/<load id>_<file>`, and a
SQL warehouse writes the table with `read_files()`:

- Every column is `STRING`, exactly as in the file. Columns are read by
  position, so the chosen names replace the file's header.
- Four lineage columns are added: `_source_file`, `_ingested_at`,
  `_ingested_by` (the signed-in user) and `_load_id`.
- The table gets the property `quality = bronze` and a comment naming the file
  and uploader.

The result page shows how many rows were loaded and the query for that load.


`sample-data/` has two fictional sources for the same water utility, for trying
the features end to end:

- `crm/`: a clean CRM customer table (1,000 rows).
- `billing/`: a legacy billing extract of the same customers, with injected
  data quality issues and a ground-truth issue list.

Each folder has a README with load steps for Lakebase and Unity Catalog.

## Architecture

```
src/      React + Vite + React Flow (@xyflow/react) + dagre layout
server/   Express: serves dist/ and the /api endpoints
  databricks.js    REST client (OAuth M2M → PAT; user token if opted in)
  unityCatalog.js  /api/2.1/unity-catalog/{catalogs,schemas,tables}
  lakebase.js      pg_catalog queries for columns, PKs and FKs
  model.js         shared ERD model, relationship inference, demo data
  profile.js       categorical field detection (SQL for Postgres and Databricks SQL)
  pii.js           personal data detection (name patterns, value formats, masking)
  warehouse.js     Statement Execution API client for Unity Catalog profiling
  refdata.js       code sets, mappings, change requests, approvals and audit log (Lakebase)
  mapping.js       suggests standard codes for raw source values
  ingest.js        CSV upload to a landing volume and bronze table load
  ucpublish.js     publishes reference data to Unity Catalog as Delta tables
  dq.js            data quality rule suggestions and check SQL (Postgres and Databricks SQL)
  dqstore.js       stores data quality rules and runs them
src/lib/modelLevels.js  physical → logical → conceptual transforms
app.yaml  Databricks Apps entry point (npm run start)
```

| Endpoint | Description |
| --- | --- |
| `GET /api/config` | Which sources are configured, plus defaults |
| `GET /api/uc/catalogs`, `/api/uc/schemas?catalog=` | Unity Catalog pickers |
| `GET /api/uc/erd?catalog=&schema=&infer=true` | ERD model for a UC schema |
| `GET /api/lakebase/schemas` | Lakebase schemas |
| `GET /api/lakebase/erd?schema=&infer=true` | ERD model for a Lakebase schema |
| `GET /api/demo/erd` | Sample retail schema |
| `GET /api/{lakebase,uc}/profile?…&table=` | Categorical field profile of one table |
| `GET /api/{lakebase,uc}/values?…&column=` | All distinct values of a column |
| `GET /api/lakebase/rows?schema=&table=` | A page of rows for master data editing |
| `GET /api/me` | Signed-in user and steward status |
| `GET /api/refdata/code-sets[/:id]` | Code sets and their values |
| `GET /api/refdata/changes?status=` · `POST /api/refdata/changes` | List or propose change requests |
| `POST /api/refdata/changes/:id/review` · `…/cancel` | Approve/reject (`{decision, comment}`) or cancel |
| `GET /api/refdata/code-sets/:id/mappings` · `GET /api/refdata/mappings?system=&table=` | Mappings by code set or by source table |
| `POST /api/refdata/code-sets/:id/suggest` | Suggested codes for `{values: [...]}` |
| `GET /api/refdata/publish` · `PUT …/publish/settings` · `POST /api/refdata/publish` | Unity Catalog publish status, settings and run (stewards) |
| `GET /api/dq/suggest?system=&schema=&table=` | Profile a table and suggest data quality rules |
| `GET/POST /api/dq/rules` · `DELETE /api/dq/rules/:id` | List, add or remove a table's rules |
| `POST /api/dq/run` · `GET /api/dq/summary?system=&prefix=` | Run a table's rules; scores per table |
| `GET /api/refdata/audit` | Change history |
| `GET /api/ingest/table?catalog=&schema=&table=` | Whether an upload's target table exists, and its columns |
| `POST /api/ingest/schema` | Create a schema for uploads (`{catalog, schema}`) |
| `PUT /api/ingest/upload?catalog=&schema=&fileName=` | Store a raw CSV (request body) in the landing volume |
| `POST /api/ingest/load` | Write a stored upload to a bronze table (`{catalog, schema, table, path, loadId, columns, delimiter, header, mode}`) |

## Deploy as a Databricks App

1. Get the code into your workspace, either through a Git folder or with the CLI:
   ```bash
   databricks sync . /Workspace/Users/<you>/edm-erd
   databricks apps create edm-erd
   databricks apps deploy edm-erd --source-code-path /Workspace/Users/<you>/edm-erd
   ```
   Databricks runs `npm install` and `npm run build`, then the `command` from
   `app.yaml`.
2. **Unity Catalog:** grant the app's service principal `USE CATALOG`,
   `USE SCHEMA` and `SELECT` (or `BROWSE`) on the schemas it should show.
   By default the app always queries Unity Catalog as this service principal.
   To make each viewer see only what they can access, enable **user
   authorization** on the app with the `catalog.catalogs:read`,
   `catalog.schemas:read` and `catalog.tables:read` scopes, and set
   `ERD_USE_USER_TOKEN=true` in `app.yaml`. Without those scopes the user's
   token is rejected with "invalid scope".
3. **Lakebase:** add a **Database** resource to the app (permission *Can
   connect and create*). Databricks injects `PGHOST`, `PGPORT`, `PGDATABASE`,
   `PGUSER` and `PGSSLMODE`, and the app uses the service principal's OAuth
   token as the Postgres password.
4. Optional defaults in `app.yaml`: `ERD_DEFAULT_SOURCE` (`uc` | `lakebase` |
   `demo`), `ERD_DEFAULT_CATALOG`, `ERD_DEFAULT_SCHEMA`.
5. **Profiling Unity Catalog tables:** add a **SQL warehouse** resource with
   permission *Can use*, such as the *Serverless Starter Warehouse*. The app
   finds it automatically: it prefers a running warehouse, then serverless,
   then one named "Starter". To pin one, set `ERD_WAREHOUSE_NAME`, or
   `DATABRICKS_WAREHOUSE_ID` via `valueFrom`. Profiling reads rows, so the service principal needs `SELECT`
   on those tables; `BROWSE` alone only covers the diagram.
6. **Reference and master data:** this needs the Lakebase resource from step 3.
   The app creates the `refdata` schema itself, using the *create* permission.
   To edit existing master tables, the service principal needs table grants:
   ```sql
   GRANT USAGE ON SCHEMA maximo TO "<sp-client-id>";
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA maximo TO "<sp-client-id>";
   ```
   Set `ERD_STEWARDS` to the emails of the people who approve changes.
7. **CSV upload:** this needs the SQL warehouse from step 5. Grant the service
   principal, on each schema people upload into:
   ```sql
   GRANT USE CATALOG ON CATALOG main TO `<sp-client-id>`;
   GRANT USE SCHEMA, CREATE TABLE, CREATE VOLUME, SELECT, MODIFY
     ON SCHEMA main.bronze TO `<sp-client-id>`;
   ```
   The app creates the `landing` volume on first use. To use an existing volume
   instead, set `ERD_UPLOAD_VOLUME=catalog.schema.volume` and grant
   `READ VOLUME` and `WRITE VOLUME` on it (then `CREATE VOLUME` isn't needed).
   `ERD_BRONZE_CATALOG` and `ERD_BRONZE_SCHEMA` (default `bronze`) preselect
   the target, and `ERD_UPLOAD_MAX_MB` (default 100) caps the file size.
   To let people create schemas from the upload page, also grant
   `USE CATALOG, CREATE SCHEMA ON CATALOG main`; set
   `ERD_UPLOAD_CREATE_SCHEMA=false` to hide the option. A schema the app
   creates is owned by its service principal, which then has full rights on it.
   Tables are created as the service principal, so anyone who can open the app
   can write to those schemas: grant only the schemas meant for uploads.

To declare keys in Unity Catalog so they show up as solid relationships:

```sql
ALTER TABLE main.sales.customers ADD CONSTRAINT customers_pk PRIMARY KEY (customer_id);
ALTER TABLE main.sales.orders ADD CONSTRAINT orders_customers_fk
  FOREIGN KEY (customer_id) REFERENCES main.sales.customers;
```

## Local development

```bash
npm install
# Unity Catalog (either OAuth M2M or a personal access token)
export DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
export DATABRICKS_TOKEN=<pat>
# Lakebase or any Postgres
export PGHOST=<host> PGUSER=<user> PGPASSWORD=<password-or-token> PGDATABASE=databricks_postgres
npm run dev    # API on :8000, Vite on :5173 with /api proxied
npm test       # server unit tests
```

With no environment variables set, only the demo source is enabled.
