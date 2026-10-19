import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landingVolume, loadSql, loadUpload, safeFileName, sqlString, validateLoad } from './ingest.js';

const LOAD_ID = '0b6c1f9e-1d2a-4c3b-9e8f-123456789abc';
const request = (over = {}) => ({
  catalog: 'main',
  schema: 'bronze',
  table: 'customer',
  loadId: LOAD_ID,
  path: `/Volumes/main/bronze/landing/uploads/2026-10-19/${LOAD_ID}_customers.csv`,
  columns: ['customer_id', 'first_name', 'email'],
  delimiter: ',',
  header: true,
  mode: 'create',
  fileName: 'customers.csv',
  ...over,
});

test('sqlString escapes quotes and backslashes', () => {
  assert.equal(sqlString("O'Brien\\x"), "'O\\'Brien\\\\x'");
});

test('safeFileName strips directories and unsafe characters', () => {
  assert.equal(safeFileName('../../etc/My File (1).csv'), 'My_File_1_.csv');
  assert.equal(safeFileName('C:\\Users\\me\\data.csv'), 'data.csv');
  assert.equal(safeFileName(''), 'upload.csv');
});

test('landingVolume defaults to <catalog>.<schema>.landing and honours ERD_UPLOAD_VOLUME', () => {
  assert.deepEqual(landingVolume('main', 'bronze'), { parts: ['main', 'bronze', 'landing'], managed: true });
  process.env.ERD_UPLOAD_VOLUME = '/Volumes/ops/raw/drop';
  try {
    assert.deepEqual(landingVolume('main', 'bronze'), { parts: ['ops', 'raw', 'drop'], managed: false });
  } finally {
    delete process.env.ERD_UPLOAD_VOLUME;
  }
});

test('validateLoad rejects bad names, duplicates, reserved columns and foreign paths', () => {
  assert.equal(validateLoad(request()).table, 'customer');
  assert.throws(() => validateLoad(request({ table: 'Customer List' })), /Table names/);
  assert.throws(() => validateLoad(request({ columns: ['a', 'a'] })), /used twice/);
  assert.throws(() => validateLoad(request({ columns: ['a', '_load_id'] })), /reserved/);
  assert.throws(() => validateLoad(request({ columns: ['a b'] })), /not allowed/);
  assert.throws(() => validateLoad(request({ path: `/Volumes/other/x/y/uploads/${LOAD_ID}_a.csv` })), /upload area/);
  assert.throws(() => validateLoad(request({ path: '/Volumes/main/bronze/landing/uploads/../../secret.csv' })), /upload area/);
  assert.throws(() => validateLoad(request({ delimiter: 'x' })), /separator/);
  assert.throws(() => validateLoad(request({ mode: 'merge' })), /mode/);
});

test('loadSql reads columns by position as STRING and adds lineage columns', () => {
  const sql = loadSql({ ...validateLoad(request()), user: 'ann@example.com', fileName: 'customers.csv' });
  assert.match(sql, /^CREATE TABLE `main`\.`bronze`\.`customer`/);
  assert.match(sql, /'quality' = 'bronze'/);
  assert.match(sql, /header => false,\n  skipRows => 1/);
  assert.match(sql, /schema => '`customer_id` STRING, `first_name` STRING, `email` STRING'/);
  assert.match(sql, /_metadata\.file_name AS _source_file/);
  assert.match(sql, /'ann@example\.com' AS _ingested_by/);
  assert.match(sql, new RegExp(`'${LOAD_ID}' AS _load_id`));

  const noHeader = loadSql({ ...validateLoad(request({ header: false, delimiter: '\t' })), user: 'u' });
  assert.match(noHeader, /skipRows => 0/);
  assert.match(noHeader, /sep => '\t'/);
  assert.match(loadSql({ ...validateLoad(request({ mode: 'replace' })), user: 'u' }), /^CREATE OR REPLACE TABLE/);
  assert.match(loadSql({ ...validateLoad(request({ mode: 'append' })), user: 'u' }), /^INSERT INTO `main`\.`bronze`\.`customer` BY NAME/);
});

test('loadUpload checks the target table against the mode and reports the row count', async () => {
  const statements = [];
  const runSql = async (sql) => {
    statements.push(sql);
    return /count\(\*\)/.test(sql) ? [{ row_count: '1000' }] : [];
  };
  const existing = { columns: ['customer_id', 'first_name', 'email', '_source_file', '_ingested_at', '_ingested_by', '_load_id'].map((name) => ({ name })) };

  await assert.rejects(loadUpload(request(), { user: 'u', existing, runSql }), /already exists/);
  await assert.rejects(loadUpload(request({ mode: 'append' }), { user: 'u', existing: null, runSql }), /does not exist/);
  await assert.rejects(
    loadUpload(request({ mode: 'append', columns: ['customer_id', 'phone'] }), { user: 'u', existing, runSql }),
    /no column phone/,
  );
  assert.equal(statements.length, 0);

  const result = await loadUpload(request({ mode: 'append' }), { user: 'u', existing, runSql });
  assert.deepEqual(result, {
    table: 'main.bronze.customer',
    mode: 'append',
    rows: 1000,
    path: request().path,
    loadId: LOAD_ID,
  });
  assert.equal(statements.length, 2);
  assert.match(statements[1], new RegExp(`WHERE _load_id = '${LOAD_ID}'`));
});
