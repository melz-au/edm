-- Unity Catalog: upload CUSTOMER_MASTER.csv with the Create or modify table UI
-- (see README.md). Turn OFF schema inference so every column stays STRING, as
-- a raw landing table should. Then run this in the SQL editor (replace main.billing).
COMMENT ON TABLE main.billing.customer_master IS
  'Fictional raw extract from the legacy HydroBill billing system, with injected data quality issues';

-- Alternative: copy the CSV into a volume and read it with every column as STRING.
-- CREATE TABLE main.billing.customer_master AS
-- SELECT * FROM read_files('/Volumes/main/billing/raw/CUSTOMER_MASTER.csv',
--   format => 'csv', header => true, inferSchema => false);
