-- POSTGRES / LAKEBASE ONLY. Do not run this in the Databricks SQL editor: it uses Postgres types
-- and psql's \copy. For Unity Catalog see load_unity_catalog.sql and README.md instead.
--
-- Loads CUSTOMER_MASTER.csv into Lakebase (or any Postgres) as a raw landing
-- table: every column is text, exactly as extracted, and there is no primary
-- key because the extract contains exact duplicate rows.
-- Run from this folder:
--   psql "host=<lakebase-host> dbname=databricks_postgres user=<you> sslmode=require" -f load_lakebase.sql
CREATE SCHEMA IF NOT EXISTS billing;
DROP TABLE IF EXISTS billing.customer_master;
CREATE TABLE billing.customer_master (
  "CUST_NO" text, "ACCT_NUM" text, "CUST_NAME" text, "CONTACT_NAME" text, "DOB" text, "SEX" text,
  "PH_HOME" text, "PH_MOB" text, "EMAIL_ADDR" text, "SUPPLY_ADDR_1" text, "SUPPLY_ADDR_2" text,
  "SUBURB_TOWN" text, "STATE" text, "PCODE" text, "MAIL_ADDR" text, "ACCT_STATUS" text, "ACCT_TYPE" text,
  "CONC_FLAG" text, "CONC_CARD" text, "PAY_METHOD" text, "BSB_NO" text, "BANK_ACCT" text, "BALANCE" text,
  "CONNECT_DATE" text, "DISCONNECT_DATE" text, "LAST_READ_DATE" text, "METER_NO" text,
  "LAST_UPD_USER" text, "LAST_UPD_TS" text, "COMMENTS" text
);
COMMENT ON TABLE billing.customer_master IS
  'Fictional raw extract from the legacy HydroBill billing system, with injected data quality issues (see sample-data/billing/README.md)';
-- Empty fields load as '' (not NULL), as a raw landing zone would keep them.
\copy billing.customer_master FROM 'CUSTOMER_MASTER.csv' WITH (FORMAT csv, HEADER true, NULL '\N')

DROP TABLE IF EXISTS billing.dq_issues;
CREATE TABLE billing.dq_issues (cust_no text, "column" text, issue text, detail text);
\copy billing.dq_issues FROM 'DQ_ISSUES.csv' WITH (FORMAT csv, HEADER true)

SELECT (SELECT count(*) FROM billing.customer_master) AS rows_loaded,
       (SELECT count(*) FROM billing.dq_issues) AS known_issues;
