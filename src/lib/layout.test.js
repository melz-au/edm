import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, connectedComponents, shelfPack } from './layout.js';
import { deriveView } from './modelLevels.js';
import { demoModel } from '../../server/model.js';

const table = (name, cols = 4) => ({
  id: `s.${name}`,
  name,
  columns: Array.from({ length: cols }, (_, i) => ({ name: `c${i}`, type: 'int', pk: i === 0, fk: false, nullable: true })),
});

const bounds = (nodes, sizeOf) => {
  const xs = nodes.map((n) => n.position.x);
  const ys = nodes.map((n) => n.position.y);
  const right = Math.max(...nodes.map((n) => n.position.x + sizeOf(n).width));
  const bottom = Math.max(...nodes.map((n) => n.position.y + sizeOf(n).height));
  return { width: right - Math.min(...xs), height: bottom - Math.min(...ys) };
};

const overlaps = (nodes, w, h) =>
  nodes.some((a, i) =>
    nodes.slice(i + 1).some(
      (b) => Math.abs(a.position.x - b.position.x) < w(a, b) && Math.abs(a.position.y - b.position.y) < h(a, b),
    ),
  );

test('connectedComponents groups linked tables', () => {
  const groups = connectedComponents(['a', 'b', 'c', 'd'], [{ from: { table: 'a' }, to: { table: 'b' } }]);
  assert.deepEqual(groups.map((g) => g.sort()).sort(), [['a', 'b'], ['c'], ['d']]);
});

test('shelfPack wraps rows at the target width', () => {
  const items = Array.from({ length: 4 }, () => ({ width: 100, height: 50 }));
  const packed = shelfPack(items, 250, 10);
  assert.equal(packed.width, 210);
  assert.equal(packed.height, 110);
});

test('unrelated tables fill a landscape viewport instead of one column', () => {
  const model = { tables: Array.from({ length: 24 }, (_, i) => table(`t${i}`)), relationships: [] };
  const { nodes } = buildGraph(model, { viewport: { width: 1600, height: 900 } });
  const b = bounds(nodes, () => ({ width: 280, height: 40 + 4 * 26 + 8 }));
  const columns = new Set(nodes.map((n) => n.position.x)).size;
  assert.ok(columns >= 5, `expected several columns, got ${columns}`);
  assert.ok(b.width / b.height > 1, 'drawing should be landscape like the viewport');
  assert.ok(!overlaps(nodes, () => 280, () => 152));
});

test('a portrait viewport gives a taller arrangement', () => {
  const model = { tables: Array.from({ length: 24 }, (_, i) => table(`t${i}`)), relationships: [] };
  const wide = buildGraph(model, { viewport: { width: 1600, height: 900 } }).nodes;
  const tall = buildGraph(model, { viewport: { width: 600, height: 1200 } }).nodes;
  const cols = (nodes) => new Set(nodes.map((n) => n.position.x)).size;
  assert.ok(cols(tall) < cols(wide));
});

test('conceptual chains switch to top-to-bottom in a tall viewport', () => {
  const view = deriveView(demoModel(), 'conceptual');
  const { nodes, edges } = buildGraph(view, { viewport: { width: 500, height: 1400 } });
  assert.ok(edges.some((e) => e.sourceHandle === '__table-bottom' && e.targetHandle === '__table-top'));
  assert.ok(!overlaps(nodes, () => 180, () => 60));
});

test('physical view keeps left-to-right column-level edges', () => {
  const { nodes, edges } = buildGraph(deriveView(demoModel(), 'physical'), { viewport: { width: 500, height: 1400 } });
  assert.ok(edges.every((e) => e.sourceHandle !== '__table-bottom'));
  assert.ok(edges.some((e) => e.sourceHandle.endsWith('-out') && e.sourceHandle !== '__table-out'));
  assert.equal(nodes.length, 9);
});
