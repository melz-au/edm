# Sample water utility star schema

A **fictional** reporting warehouse for the sample water utility. There are
three fact tables and eight conformed dimensions, built from the other samples:
- customers from `../crm`
- sites and equipment from `../assets`
- site codes that match `LOCATIONS.csv` in the repository root

It is clean by design, so ERD Explorer's star schema checks pass. Use it to try
star schema modelling, or as a starting point for dashboards.

```
                      dim_date (read, raised, completed, sample dates)
                          │
 dim_customer (SCD2) ─┐   │   ┌─ dim_asset
 dim_meter ───────────┼─ fact_meter_read          fact_work_order ─┼─ dim_site ─┐
 dim_tariff ──────────┘                                            └─ dim_work_type
                                                                            │
                                     fact_water_quality ─┬─ dim_site ───────┘
                                                         └─ dim_wq_parameter
```

## Facts

| Table | Grain | Measures | Rows |
| --- | --- | --- | --- |
| `fact_meter_read` | One row per meter read: a customer's quarterly reading of one meter | `days_in_period`, `consumption_kl`, `usage_charge`, `supply_charge` | 9,494 |
| `fact_work_order` | One row per completed work order | `labour_hours`, `labour_cost`, `material_cost`, `downtime_hours` | 2,805 |
| `fact_water_quality` | One row per lab result (one parameter of one sample) | `result_value`, `exceedance_count` (0/1, so it sums) | 3,304 |

`read_no`, `work_order_no` and `sample_no` are degenerate dimensions.
`fact_work_order` uses `dim_date` twice: raised date and completed date.

## Dimensions

| Table | Surrogate key | Business key | Type | Rows |
| --- | --- | --- | --- | --- |
| `dim_date` | `date_sk` (smart key `yyyymmdd`) | `full_date` | Calendar plus Australian financial year (`FY2024` = July 2023 to June 2024) and southern hemisphere season, 2023–2025 | 1,097 |
| `dim_customer` | `customer_sk` | `customer_id` (CRM) | **SCD type 2**: 161 customers moved suburb or changed concession, so they have two versions (`effective_from`, `effective_to`, `is_current`) | 1,096 |
| `dim_meter` | `meter_sk` | `meter_no` | SCD type 1 | 935 |
| `dim_tariff` | `tariff_sk` | `tariff_code` | Residential standard/concession, business standard/large meter; two-tier usage rates (fictional) | 5 |
| `dim_site` | `site_sk` | `site_code` | Treatment plants, pump stations, reservoir | 10 |
| `dim_asset` | `asset_sk` | `asset_tag` | Equipment, flattened with its system and facility (no snowflaking) | 219 |
| `dim_work_type` | `work_type_sk` | `work_type_code` | Preventive, corrective, emergency, inspection, calibration | 6 |
| `dim_wq_parameter` | `parameter_sk` | `parameter_code` | E. coli, turbidity, free chlorine, pH, fluoride, with guideline limits (illustrative) | 6 |

Every dimension has an **unknown member** with key `-1`, so fact keys are
never NULL. Each meter read joins the `dim_customer` version that was current
on the read date.

The data has realistic shapes:
- residential use averages about 0.5 kL a day and peaks in summer
- business meters use more
- critical equipment gets more frequent preventive work orders
- emergency work costs more and causes downtime
- a few results exceed the guideline limits, mostly low free chlorine at the reservoir

## Files

| File | Contents |
| --- | --- |
| `DIM_*.csv`, `FACT_*.csv` | One CSV per table |
| `load_lakebase.sql` | Creates schema `water_star` in Lakebase/Postgres with primary keys, business-key `UNIQUE` constraints, foreign keys and comments, then loads the CSVs |
| `load_model_lakebase.sql` | Saves an ERD Explorer data model, **Water utility star schema**, with every table's role, surrogate and business keys, SCD type and grain |
| `load_unity_catalog.sql` | Creates the tables in `main.water_star` with informational keys and loads the CSVs from a volume |
| `generate_star.py` | Seeded generator that rebuilds all of the above |

## Load

**Lakebase:**
```bash
cd sample-data/star
psql "host=<lakebase-host> dbname=databricks_postgres user=<you> sslmode=require" -f load_lakebase.sql
# optional: the annotated data model (open ERD Explorer once first so it creates its tables)
psql "host=<lakebase-host> dbname=databricks_postgres user=<you> sslmode=require" -f load_model_lakebase.sql
```

In ERD Explorer, choose **Lakebase**, schema **water_star**, then choose the
data model **Water utility star schema**. The tables show FACT/DIM badges and
SK/BK keys, and the **Star schema** panel reports 0 errors and 0 warnings.
Without the saved model, **Classify them** in the Star schema panel sets every
role from the table names; then tick each dimension's business key, set
`dim_customer` to SCD type 2, and write each fact's grain.

**Unity Catalog:** create the schema and a volume, upload the CSV files to
`/Volumes/main/water_star/raw/`, then run `load_unity_catalog.sql` in the SQL
editor. The steps are at the top of the file, which can be re-run.

Regenerate with `python3 generate_star.py`. It reads `../crm/CUSTOMER.csv` and
`../assets/ASSET_GOLDEN.csv`.

## Example questions

```sql
-- Billed consumption by financial year and season
SELECT d.financial_year, d.season, sum(f.consumption_kl) AS kl, sum(f.usage_charge + f.supply_charge) AS billed
FROM water_star.fact_meter_read f JOIN water_star.dim_date d ON d.date_sk = f.read_date_sk
GROUP BY 1, 2 ORDER BY 1, 3 DESC;

-- Planned vs unplanned maintenance cost by site
SELECT s.site_name, w.is_planned, sum(f.labour_cost + f.material_cost) AS cost, sum(f.downtime_hours) AS downtime
FROM water_star.fact_work_order f
JOIN water_star.dim_site s USING (site_sk) JOIN water_star.dim_work_type w USING (work_type_sk)
GROUP BY 1, 2 ORDER BY 1, 2;

-- Guideline exceedances by site and parameter
SELECT s.site_name, p.parameter_name, sum(f.exceedance_count) AS exceedances, count(*) AS results
FROM water_star.fact_water_quality f
JOIN water_star.dim_site s USING (site_sk) JOIN water_star.dim_wq_parameter p USING (parameter_sk)
GROUP BY 1, 2 HAVING sum(f.exceedance_count) > 0;
```
