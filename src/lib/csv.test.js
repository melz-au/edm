import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnNames, detectDelimiter, guessKind, nameProblems, parseCsv, sanitizeName, suggestTableName } from './csv.js';

test('parseCsv handles quotes, escaped quotes, embedded line breaks, CRLF and a BOM', () => {
  const text = '﻿id,name,note\r\n1,"Smith, Jo","said ""hi""\nthen left"\r\n2,Lee,\r\n';
  assert.deepEqual(parseCsv(text), [
    ['id', 'name', 'note'],
    ['1', 'Smith, Jo', 'said "hi"\nthen left'],
    ['2', 'Lee', ''],
  ]);
  assert.equal(parseCsv(text, ',', 2).length, 2);
  assert.deepEqual(parseCsv('a,b\n\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('detectDelimiter finds semicolon, tab and pipe files', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2,5;3\n'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2\n'), '\t');
  assert.equal(detectDelimiter('a|b|c\n1|2|3\n'), '|');
  assert.equal(detectDelimiter('a,b\n"x;y",2\n'), ',');
});

test('sanitizeName produces Unity Catalog friendly snake_case', () => {
  assert.equal(sanitizeName('Customer ID #'), 'customer_id');
  assert.equal(sanitizeName('firstName'), 'first_name');
  assert.equal(sanitizeName('Café Owner'), 'cafe_owner');
  assert.equal(sanitizeName('2024 Sales'), 'column_2024_sales');
  assert.equal(sanitizeName('***'), 'column');
  assert.equal(suggestTableName('Customer Master (v2).csv'), 'customer_master_v2');
});

test('columnNames de-duplicates and avoids the reserved underscore prefix', () => {
  assert.deepEqual(columnNames(['Name', 'name', '', '_load_id'], 4, true), ['name', 'name_2', 'column_3', 'load_id']);
  assert.deepEqual(columnNames(null, 2, false), ['column_1', 'column_2']);
});

test('nameProblems flags invalid, reserved and duplicate names', () => {
  const problems = nameProblems(['ok', 'Bad Name', '_load_id', 'dup', 'dup', '']);
  assert.deepEqual([...problems.keys()], [1, 2, 3, 4, 5]);
});

test('guessKind gives a friendly type hint', () => {
  assert.equal(guessKind(['1', '2.5', '-3']), 'Number');
  assert.equal(guessKind(['Y', 'n', '']), 'Yes / No');
  assert.equal(guessKind(['2024-01-31', '2024-02-01 10:00']), 'Date');
  assert.equal(guessKind(['31/01/2024']), 'Date');
  assert.equal(guessKind(['abc', '1']), 'Text');
  assert.equal(guessKind(['', ' ']), 'Empty');
});
