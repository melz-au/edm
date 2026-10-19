-- Unity Catalog: after uploading CUSTOMER.csv (see README.md), run this in the
-- SQL editor to add a primary key and comments. Replace main.crm with your
-- catalog and schema.
ALTER TABLE main.crm.customer ALTER COLUMN customer_id SET NOT NULL;
ALTER TABLE main.crm.customer ADD CONSTRAINT customer_pk PRIMARY KEY (customer_id);
COMMENT ON TABLE main.crm.customer IS 'Fictional CRM customer records for testing';

-- Alternative to the upload UI: copy the CSV into a volume, then
-- CREATE TABLE main.crm.customer AS
-- SELECT * FROM read_files('/Volumes/main/crm/raw/CUSTOMER.csv', format => 'csv', header => true, inferSchema => true);
