import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDdl } from './ddl.js';
import { applyProposals, validateProposal } from './proposals.js';

const existing = (catalog, schema) => ({
  tables: [
    {
      id: [catalog, schema, 'asset'].filter(Boolean).join('.'),
      name: 'asset',
      catalog,
      schema,
      columns: [
        { name: 'assetnum', type: 'text', nullable: false, pk: true },
        { name: 'siteid', type: 'text', nullable: true, pk: false },
      ],
    },
  ],
  relationships: [],
});

const proposal = (scope) =>
  validateProposal({
    tables: [
      {
        name: 'work_task',
        columns: [
          { name: 'task_id', type: 'bigint', pk: true },
          { name: 'request_id', type: 'bigint', references: { table: `${scope}.work_request`, column: 'request_id' } },
        ],
      },
      {
        name: 'work_request',
        comment: "Customer's request",
        columns: [
          { name: 'request_id', type: 'bigint', pk: true, comment: 'Surrogate key' },
          { name: 'assetnum', type: 'text', nullable: false, references: { table: `${scope}.asset`, column: 'assetnum' } },
          { name: 'site', type: 'text', references: { table: `${scope}.asset`, column: 'siteid' } },
          { name: 'parent_id', type: 'bigint', references: { table: `${scope}.work_request`, column: 'request_id' } },
        ],
      },
    ],
  });

test('Postgres DDL for Lakebase: tables, keys, comments, then foreign keys', () => {
  const { model } = applyProposals(existing(undefined, 'maximo'), { source: 'lakebase', scope: 'maximo', proposal: proposal('maximo') });
  const sql = generateDdl(model, { source: 'lakebase', header: ['Data model: Work (version 2)'] });
  assert.match(sql, /^-- Data model: Work \(version 2\)\n-- Dialect: Postgres/);
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS "maximo"\."work_request" \(\n  "request_id" bigint NOT NULL,\n  "assetnum" text NOT NULL,\n  "site" text,\n  "parent_id" bigint,\n  CONSTRAINT "pk_work_request" PRIMARY KEY \("request_id"\)\n\);/,
  );
  assert.match(sql, /COMMENT ON TABLE "maximo"\."work_request" IS 'Customer''s request';/);
  assert.match(sql, /COMMENT ON COLUMN "maximo"\."work_request"\."request_id" IS 'Surrogate key';/);
  // Foreign keys come after every CREATE TABLE, so work_task can reference work_request.
  const lastCreate = sql.lastIndexOf('CREATE TABLE');
  const firstFk = sql.indexOf('ALTER TABLE');
  assert.ok(firstFk > lastCreate);
  assert.match(sql, /ALTER TABLE "maximo"\."work_task" ADD CONSTRAINT "fk_work_task_request_id" FOREIGN KEY \("request_id"\) REFERENCES "maximo"\."work_request" \("request_id"\);/);
  assert.match(sql, /\nALTER TABLE "maximo"\."work_request" ADD CONSTRAINT "fk_work_request_parent_id" FOREIGN KEY \("parent_id"\) REFERENCES "maximo"\."work_request" \("request_id"\);/);
  // siteid isn't asset's key, so that relationship can't be a foreign key.
  assert.match(sql, /-- asset\.siteid isn't asset's single-column primary key; declare one first[^\n]*\n-- ALTER TABLE "maximo"\."work_request" ADD CONSTRAINT "fk_work_request_site"/);
});

test('Databricks SQL DDL for Unity Catalog: three-part names, inline comments, escaping', () => {
  const { model } = applyProposals(existing('main', 'ops'), { source: 'uc', scope: 'main.ops', proposal: proposal('main.ops') });
  const sql = generateDdl(model, { source: 'uc', ifNotExists: false });
  assert.match(sql, /Dialect: Databricks SQL/);
  assert.match(sql, /CREATE TABLE `main`\.`ops`\.`work_request` \(\n  `request_id` bigint NOT NULL COMMENT 'Surrogate key',/);
  assert.match(sql, /\)\nCOMMENT 'Customer\\'s request';/);
  assert.doesNotMatch(sql, /COMMENT ON/);
  assert.match(sql, /REFERENCES `main`\.`ops`\.`asset` \(`assetnum`\);/);
});

test('only: one entity, with references to proposals left out written as comments', () => {
  const { model } = applyProposals(existing(undefined, 'maximo'), { source: 'lakebase', scope: 'maximo', proposal: proposal('maximo') });
  const sql = generateDdl(model, { source: 'lakebase', only: ['maximo.work_task'] });
  assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, 1);
  assert.match(sql, /-- work_task\.request_id → work_request\.request_id: create the proposed work_request first, then:\n-- ALTER TABLE/);
  assert.match(generateDdl(model, { source: 'lakebase', only: [] }), /No proposed entities/);
});

test('quoted identifiers are escaped and long constraint names fit Postgres', () => {
  const long = 'x'.repeat(60);
  const p = validateProposal({ tables: [{ name: long, columns: [{ name: 'id', type: 'int', pk: true }] }] });
  const { model } = applyProposals({ tables: [], relationships: [] }, { source: 'lakebase', scope: 'we"ird', proposal: p });
  const sql = generateDdl(model, { source: 'lakebase' });
  assert.match(sql, /"we""ird"\."x{60}"/);
  const name = /CONSTRAINT "([^"]+)"/.exec(sql)[1];
  assert.equal(name.length, 63);
});
