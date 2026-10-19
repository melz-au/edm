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

**Reference data.** Any categorical field can become a managed **code set**:
*Create code set* reads all of the column's distinct values. Review the codes,
add labels and descriptions, and submit. The **Reference data** tab lists code
sets, where codes can be added, edited, deactivated and reactivated.

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
| `change_request` | Every proposed change, its status and review |
| `audit_log` | Every applied change with before/after JSON |

Users are identified by the email Databricks Apps forwards for the signed-in
user (`X-Forwarded-Email`). Outside Databricks Apps that header is just a
request header, so don't expose a locally run server to other people.

## Architecture

```
src/      React + Vite + React Flow (@xyflow/react) + dagre layout
server/   Express: serves dist/ and the /api endpoints
  databricks.js    REST client (OAuth M2M → PAT; user token if opted in)
  unityCatalog.js  /api/2.1/unity-catalog/{catalogs,schemas,tables}
  lakebase.js      pg_catalog queries for columns, PKs and FKs
  model.js         shared ERD model, relationship inference, demo data
  profile.js       categorical field detection (SQL for Postgres and Databricks SQL)
  warehouse.js     Statement Execution API client for Unity Catalog profiling
  refdata.js       code sets, change requests, approvals and audit log (Lakebase)
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
| `GET /api/refdata/audit` | Change history |

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
