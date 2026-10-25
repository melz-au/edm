import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStarFix,
  checkStarSchema,
  roleSuggestions,
  scd2Columns,
  starTemplate,
  suggestRole,
  surrogateOf,
} from './star.js';
import { applyProposals, renameStarColumns, removeEntity, upsertEntity, validateProposal } from './proposals.js';
import { generateDdl } from './ddl.js';

const S = 'gold';
const id = (n) => `${S}.${n}`;
const col = (name, type, extra = {}) => ({ name, type, nullable: true, pk: false, ...extra });

// A small proposed star: one fact, a customer dimension (SCD2) and a date dimension.
const goodContent = () => ({
  tables: [
    {
      name: 'dim_customer',
      columns: [
        col('customer_sk', 'bigint', { pk: true }),
        col('customer_id', 'text', { nullable: false }),
        col('name', 'text'),
        col('effective_from', 'timestamptz', { nullable: false }),
        col('effective_to', 'timestamptz'),
        col('is_current', 'boolean', { nullable: false }),
      ],
    },
    { name: 'dim_date', columns: [col('date_sk', 'integer', { pk: true }), col('full_date', 'date', { nullable: false })] },
    {
      name: 'fact_sales',
      columns: [
        col('customer_sk', 'bigint', { nullable: false, references: { table: id('dim_customer'), column: 'customer_sk' } }),
        col('date_sk', 'integer', { nullable: false, references: { table: id('dim_date'), column: 'date_sk' } }),
        col('order_no', 'text'),
        col('amount', 'numeric(18,2)'),
      ],
    },
  ],
  star: {
    [id('dim_customer')]: { role: 'dimension', scd: 2, surrogate: 'customer_sk', business: ['customer_id'] },
    [id('dim_date')]: { role: 'dimension', surrogate: 'date_sk', business: ['full_date'], identity: false },
    [id('fact_sales')]: { role: 'fact', grain: 'One row per order line' },
  },
});

const merged = (content) => {
  const proposal = validateProposal(content);
  return { proposal, model: applyProposals({ tables: [], relationships: [] }, { source: 'lakebase', scope: S, proposal }).model };
};
const rules = (issues) => issues.map((i) => `${i.severity}:${i.rule}:${i.table.split('.').pop()}${i.column ? `.${i.column}` : ''}`);

test('suggestRole from common naming conventions', () => {
  assert.equal(suggestRole('dim_customer'), 'dimension');
  assert.equal(suggestRole('customer_dim'), 'dimension');
  assert.equal(suggestRole('fact_sales'), 'fact');
  assert.equal(suggestRole('fct_orders'), 'fact');
  assert.equal(suggestRole('bridge_account_customer'), 'bridge');
  assert.equal(suggestRole('customer'), null);
  assert.equal(suggestRole('different'), null, 'd_ prefix only, not any word starting with d');
});

test('a well-formed star has no errors or warnings', () => {
  const { proposal, model } = merged(goodContent());
  assert.deepEqual(rules(checkStarSchema(model, proposal.star)), []);
  assert.deepEqual(scd2Columns(model.tables[0]), { from: 'effective_from', to: 'effective_to', current: 'is_current' });
});

test('dimension checks: surrogate, business key, SCD2 columns, direction, snowflaking', () => {
  const c = goodContent();
  c.tables[0].columns = [col('customer_id', 'text', { pk: true }), col('name', 'text')]; // natural key as PK, no SCD2 columns
  c.star[id('dim_customer')] = { role: 'dimension', scd: 2, business: [] };
  c.tables.push({ name: 'dim_region', columns: [col('region_sk', 'bigint', { pk: true })] });
  c.star[id('dim_region')] = { role: 'dimension', surrogate: 'region_sk', business: ['region_sk'] };
  c.tables[1].columns.push(col('region_sk', 'bigint', { references: { table: id('dim_region'), column: 'region_sk' } }));
  c.tables[1].columns.push(col('sale_ref', 'bigint', { references: { table: id('fact_sales'), column: 'order_no' } }));
  const { proposal, model } = merged(c);
  const issues = checkStarSchema(model, proposal.star);
  const got = rules(issues);
  for (const expected of [
    'error:dim-no-surrogate:dim_customer',
    'error:scd2-missing-columns:dim_customer',
    'warning:dim-no-business-key:dim_customer',
    'error:dim-references-fact:dim_date',
    'info:snowflake:dim_date',
  ]) {
    assert.ok(got.includes(expected), `${expected} in ${got.join(', ')}`);
  }
  assert.equal(got[0].split(':')[0], 'error', 'errors come first');
  const noSk = issues.find((i) => i.rule === 'dim-no-surrogate');
  assert.deepEqual(noSk.fix, { type: 'add-surrogate', table: id('dim_customer') });
});

test('fact checks: no dimensions, nullable and mistyped keys, no grain, fact-to-fact, measures', () => {
  const c = goodContent();
  c.tables[2].columns[0] = col('customer_sk', 'integer', { references: { table: id('dim_customer'), column: 'customer_sk' } });
  c.star[id('fact_sales')] = { role: 'fact' };
  c.tables[2].columns.push(col('customer_bk', 'text', { nullable: false, references: { table: id('dim_customer'), column: 'customer_id' } }));
  c.tables.push({ name: 'fact_returns', columns: [col('qty', 'integer'), col('sale', 'text', { references: { table: id('fact_sales'), column: 'order_no' } })] });
  c.star[id('fact_returns')] = { role: 'fact', grain: 'One row per return' };
  const { proposal, model } = merged(c);
  const got = rules(checkStarSchema(model, proposal.star));
  for (const expected of [
    'warning:fact-fk-nullable:fact_sales.customer_sk',
    'warning:fact-fk-type:fact_sales.customer_sk',
    'warning:fact-no-grain:fact_sales',
    'error:fact-no-dimensions:fact_returns',
    'warning:fact-to-fact:fact_returns',
    'error:fact-fk-not-surrogate:fact_sales.customer_bk',
  ]) {
    assert.ok(got.includes(expected), `${expected} in ${got.join(', ')}`);
  }
  assert.ok(!got.some((g) => g.startsWith('info:fact-no-measures:fact_sales')), 'amount is a measure');
});

test('existing tables: roles from annotations, surrogate assumed from an integer PK', () => {
  const model = {
    tables: [
      { id: 'main.gold.dim_product', name: 'dim_product', columns: [col('product_key', 'BIGINT', { pk: true }), col('sku', 'STRING')] },
      { id: 'main.gold.fct_orders', name: 'fct_orders', columns: [col('product_key', 'BIGINT', { nullable: false }), col('qty', 'INT')] },
    ],
    relationships: [{ id: 'r', from: { table: 'main.gold.fct_orders', columns: ['product_key'] }, to: { table: 'main.gold.dim_product', columns: ['product_key'] } }],
  };
  assert.deepEqual(roleSuggestions(model, {}).map((s) => s.role), ['dimension', 'fact']);
  const star = { 'main.gold.dim_product': { role: 'dimension', business: ['sku'] }, 'main.gold.fct_orders': { role: 'fact', grain: 'order line' } };
  assert.equal(surrogateOf(model.tables[0], star['main.gold.dim_product']).assumed, true);
  const got = rules(checkStarSchema(model, star));
  assert.deepEqual(got, ['warning:dim-business-nullable:dim_product.sku'], 'fix offered only for proposed tables');
  assert.equal(checkStarSchema(model, star)[0].fix, null);
  assert.deepEqual(roleSuggestions(model, star), []);
});

test('templates and fixes', () => {
  let { proposal, model } = merged({ tables: [] });
  const date = starTemplate('date', { source: 'uc', scope: S, model, star: {} });
  assert.equal(date.entity.name, 'dim_date');
  assert.equal(date.entity.columns[0].type, 'INT');
  assert.equal(date.star.identity, false);
  proposal = validateProposal({ ...upsertEntity(proposal, S, date.entity), star: { [id('dim_date')]: date.star } });
  model = applyProposals({ tables: [], relationships: [] }, { source: 'uc', scope: S, proposal }).model;
  const fact = starTemplate('fact', { source: 'uc', scope: S, model, star: proposal.star });
  assert.deepEqual(fact.entity.columns[0].references, { table: id('dim_date'), column: 'date_sk' }, 'a new fact references the date dimension');
  const dim = starTemplate('dimension', { source: 'lakebase', scope: S, model, star: proposal.star });
  assert.deepEqual([dim.entity.name, dim.star.surrogate, dim.star.business], ['dim_new', 'new_sk', ['new_bk']]);

  // add-surrogate turns the natural PK into the business key
  let p = validateProposal({ tables: [{ name: 'dim_site', columns: [col('site_code', 'text', { pk: true }), col('name', 'text')] }], star: { [id('dim_site')]: { role: 'dimension' } } });
  p = applyStarFix(p, S, { type: 'add-surrogate', table: id('dim_site') }, { source: 'lakebase' });
  assert.deepEqual(p.tables[0].columns.map((c) => [c.name, c.type, c.pk]), [['site_sk', 'bigint', true], ['site_code', 'text', false], ['name', 'text', false]]);
  assert.deepEqual([p.star[id('dim_site')].surrogate, p.star[id('dim_site')].business], ['site_sk', ['site_code']]);
  p = applyStarFix({ ...p, star: { [id('dim_site')]: { ...p.star[id('dim_site')], scd: 2 } } }, S, { type: 'add-scd2', table: id('dim_site') }, { source: 'lakebase' });
  assert.deepEqual(p.tables[0].columns.slice(-3).map((c) => c.name), ['effective_from', 'effective_to', 'is_current']);
  const m = applyProposals({ tables: [], relationships: [] }, { source: 'lakebase', scope: S, proposal: validateProposal(p) }).model;
  assert.deepEqual(rules(checkStarSchema(m, p.star)).filter((r) => !r.startsWith('info')), [], 'fixed dimension passes');
});

test('star annotations follow renames and removals', () => {
  let p = validateProposal(goodContent());
  p = upsertEntity(p, S, { ...p.tables[0], name: 'dim_client' }, 'dim_customer');
  assert.ok(p.star[id('dim_client')] && !p.star[id('dim_customer')]);
  const renamed = renameStarColumns(p.star, id('dim_client'), { customer_sk: 'client_sk' }, new Set(['client_sk', 'name']));
  assert.deepEqual([renamed[id('dim_client')].surrogate, renamed[id('dim_client')].business], ['client_sk', []]);
  assert.equal(removeEntity(p, S, 'dim_client').star[id('dim_client')], undefined);
  assert.throws(() => validateProposal({ star: { x: { role: 'dimension', surrogate: 'bad name' } } }), /valid column name/);
  assert.deepEqual(validateProposal({ star: { x: { role: 'nonsense' } } }).star, {}, 'unknown roles are dropped');
});

test('DDL: identity surrogate keys, business key constraints, grain', () => {
  const { proposal, model } = merged(goodContent());
  const pg = generateDdl(model, { source: 'lakebase', star: proposal.star });
  assert.match(pg, /-- Dimension \(SCD type 2\)\nCREATE TABLE IF NOT EXISTS "gold"\."dim_customer" \(\n  "customer_sk" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,/);
  assert.match(pg, /CONSTRAINT "uq_dim_customer_business_key" UNIQUE \("customer_id", "effective_from"\)/);
  assert.match(pg, /"date_sk" integer NOT NULL,\n/, 'smart keys are not generated');
  assert.match(pg, /CONSTRAINT "uq_dim_date_business_key" UNIQUE \("full_date"\)/);
  assert.match(pg, /COMMENT ON TABLE "gold"\."fact_sales" IS 'Grain: One row per order line';/);

  const ucModel = applyProposals({ tables: [], relationships: [] }, { source: 'uc', scope: 'main.gold', proposal: validateProposal({
    tables: [{ name: 'dim_x', columns: [col('x_sk', 'BIGINT', { pk: true }), col('code', 'STRING', { nullable: false })] }, { name: 'dim_y', columns: [col('y_sk', 'INT', { pk: true })] }],
  }) }).model;
  const uc = generateDdl(ucModel, { source: 'uc', star: {
    'main.gold.dim_x': { role: 'dimension', surrogate: 'x_sk', business: ['code'] },
    'main.gold.dim_y': { role: 'dimension', surrogate: 'y_sk', business: [] },
  } });
  assert.match(uc, /`x_sk` BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY/);
  assert.match(uc, /-- Business key \(keep unique in the load; Unity Catalog doesn't enforce it\): code/);
  assert.doesNotMatch(uc, /UNIQUE/);
  assert.match(uc, /-- Surrogate key y_sk is INT; make it BIGINT to generate it as an identity column\./);
});
