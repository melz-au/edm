-- Unity Catalog: upload ASSET_HIERARCHY.csv (and optionally ASSET_GOLDEN.csv,
-- ASSET_MATCH.csv, DQ_ISSUES.csv) with Catalog -> + Add data -> Create or modify
-- table. Turn OFF schema inference so every column stays STRING, as a raw
-- landing table should. Then run this in the SQL editor (replace main.assets).
COMMENT ON TABLE main.assets.asset_hierarchy IS
  'Fictional legacy asset register for a water utility (facility > system > equipment), with duplicate records and broken parent links';

-- Optional: declare the golden hierarchy's keys so the ERD draws parent -> asset.
-- ALTER TABLE main.assets.asset_golden ALTER COLUMN golden_id SET NOT NULL;
-- ALTER TABLE main.assets.asset_golden ADD CONSTRAINT pk_asset_golden PRIMARY KEY (golden_id);
-- ALTER TABLE main.assets.asset_golden ADD CONSTRAINT fk_asset_golden_parent
--   FOREIGN KEY (parent_golden_id) REFERENCES main.assets.asset_golden (golden_id);

-- Alternative: copy the CSV into a volume and read it with every column as STRING.
-- CREATE TABLE main.assets.asset_hierarchy AS
-- SELECT * FROM read_files('/Volumes/main/assets/raw/ASSET_HIERARCHY.csv',
--   format => 'csv', header => true, inferSchema => false);
