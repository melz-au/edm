-- Loads the asset hierarchy sample into Lakebase (or any Postgres), in schema "assets":
--   asset_hierarchy  the raw legacy register: every column text, exactly as
--                    extracted, no primary key (it holds exact duplicate rows)
--   asset_golden     the clean truth, one row per real asset, with a primary key
--                    and a parent → asset foreign key (draws the hierarchy in the ERD)
--   asset_match      which golden asset each raw record is
--   dq_issues        every injected data quality issue
-- Run from this folder:
--   psql "host=<lakebase-host> dbname=databricks_postgres user=<you> sslmode=require" -f load_lakebase.sql
CREATE SCHEMA IF NOT EXISTS assets;
DROP TABLE IF EXISTS assets.asset_match, assets.dq_issues, assets.asset_hierarchy, assets.asset_golden;

CREATE TABLE assets.asset_hierarchy (
  "ASSET_ID" text, "ASSET_TAG" text, "ASSET_DESC" text, "ASSET_LEVEL" text, "ASSET_CLASS" text,
  "PARENT_ASSET_ID" text, "SITE_CODE" text, "REGION" text, "STATUS" text, "MANUFACTURER" text,
  "MODEL" text, "SERIAL_NO" text, "INSTALL_DATE" text, "CRITICALITY" text, "RATING" text,
  "LATITUDE" text, "LONGITUDE" text, "SOURCE_SYSTEM" text, "CREATED_BY" text, "CREATED_DATE" text,
  "COMMENTS" text
);
COMMENT ON TABLE assets.asset_hierarchy IS
  'Fictional legacy asset register for a water utility (facility > system > equipment), with duplicate records and broken parent links (see sample-data/assets/README.md)';
-- Empty fields load as '' (not NULL), as a raw landing zone would keep them.
\copy assets.asset_hierarchy FROM 'ASSET_HIERARCHY.csv' WITH (FORMAT csv, HEADER true, NULL '\N')

CREATE TABLE assets.asset_golden (
  golden_id        text PRIMARY KEY,
  asset_level      int NOT NULL CHECK (asset_level BETWEEN 1 AND 3),
  asset_tag        text NOT NULL UNIQUE,
  asset_name       text NOT NULL,
  asset_class      text NOT NULL,
  parent_golden_id text REFERENCES assets.asset_golden (golden_id),
  site_code        text NOT NULL,
  region           text NOT NULL,
  status           text NOT NULL,
  manufacturer     text,
  model            text,
  serial_no        text,
  install_date     date,
  criticality      int,
  rating           text,
  latitude         numeric(9,6),
  longitude        numeric(9,6)
);
COMMENT ON TABLE assets.asset_golden IS 'Ground truth: one row per real asset in the sample hierarchy';
\copy assets.asset_golden FROM 'ASSET_GOLDEN.csv' WITH (FORMAT csv, HEADER true)

CREATE TABLE assets.asset_match (
  asset_id      text PRIMARY KEY,
  golden_id     text NOT NULL REFERENCES assets.asset_golden (golden_id),
  source_system text NOT NULL
);
COMMENT ON TABLE assets.asset_match IS 'Ground truth: the real asset each raw register record describes';
\copy assets.asset_match FROM 'ASSET_MATCH.csv' WITH (FORMAT csv, HEADER true)

CREATE TABLE assets.dq_issues (asset_id text, "column" text, issue text, detail text);
\copy assets.dq_issues FROM 'DQ_ISSUES.csv' WITH (FORMAT csv, HEADER true, NULL '\N')

SELECT (SELECT count(*) FROM assets.asset_hierarchy) AS raw_records,
       (SELECT count(*) FROM assets.asset_golden) AS real_assets,
       (SELECT count(*) FROM assets.dq_issues) AS known_issues;
