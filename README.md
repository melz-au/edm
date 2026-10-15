# ERD Explorer

A Databricks App that draws an interactive **entity relationship diagram** for a
**Unity Catalog** schema or a **Lakebase** (Postgres) schema. You can pan, zoom,
search and click through tables. A built-in demo schema works with no
configuration.

- Pan by dragging or scrolling, and zoom with pinch or ctrl+scroll. There are also
  a minimap and fit/re-layout controls.
- Tables are laid out automatically, with primary and foreign keys marked and
  crow's-foot relationship lines.
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

## Architecture

```
src/      React + Vite + React Flow (@xyflow/react) + dagre layout
server/   Express: serves dist/ and the /api endpoints
  databricks.js    REST client (OAuth M2M → PAT; user token if opted in)
  unityCatalog.js  /api/2.1/unity-catalog/{catalogs,schemas,tables}
  lakebase.js      pg_catalog queries for columns, PKs and FKs
  model.js         shared ERD model, relationship inference, demo data
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
