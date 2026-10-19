-- Loads CUSTOMER.csv into Lakebase (or any Postgres) as crm.customer.
-- Run from this folder with psql, e.g.:
--   psql "host=<lakebase-host> dbname=databricks_postgres user=<you> sslmode=require" -f load_lakebase.sql
CREATE SCHEMA IF NOT EXISTS crm;
DROP TABLE IF EXISTS crm.customer;
CREATE TABLE crm.customer (
  customer_id              integer PRIMARY KEY,
  customer_account_no      text NOT NULL UNIQUE,
  customer_type            text NOT NULL,
  company_name             text,
  title                    text,
  first_name               text NOT NULL,
  last_name                text NOT NULL,
  preferred_name           text,
  date_of_birth            date,
  gender                   text,
  email                    text,
  mobile_phone             text,
  home_phone               text,
  street_address           text,
  suburb                   text,
  state                    text,
  postcode                 text,
  latitude                 numeric(9,6),
  longitude                numeric(9,6),
  customer_status          text NOT NULL,
  segment                  text,
  lead_source              text,
  preferred_contact_method text,
  marketing_opt_in         char(1),
  concession_type          text,
  concession_card_number   text,
  payment_method           text,
  bsb                      text,
  bank_account_number      text,
  portal_username          text,
  last_login_ip            text,
  account_manager          text,
  lifetime_value           numeric(12,2),
  last_contact_date        date,
  created_date             timestamp,
  created_by               text,
  last_modified_date       timestamp,
  last_modified_by         text,
  notes                    text
);
COMMENT ON TABLE crm.customer IS 'Fictional CRM customer records for testing (see sample-data/crm/README.md)';
\copy crm.customer FROM 'CUSTOMER.csv' WITH (FORMAT csv, HEADER true, NULL '')
SELECT count(*) AS customers_loaded FROM crm.customer;
