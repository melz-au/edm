// Shared ERD model helpers.
//
// Model shape:
//   {
//     tables: [{ id, name, schema, catalog?, type, comment, external?,
//                columns: [{ name, type, nullable, comment, pk, fk }] }],
//     relationships: [{ id, name, from: { table, columns }, to: { table, columns }, inferred }]
//   }
// `from` is the referencing (child) table, `to` the referenced (parent) table.

function singularCandidates(base) {
  const out = new Set([base, `${base}s`, `${base}es`]);
  if (base.endsWith('y')) out.add(`${base.slice(0, -1)}ies`);
  if (base.endsWith('s')) out.add(base.slice(0, -1));
  return out;
}

/**
 * Unity Catalog constraints are informational and often absent, so this adds
 * relationships guessed from naming conventions: a column `customer_id`
 * points at a table `customer`/`customers` whose primary key (or `id`
 * column) it matches. Declared relationships always win.
 */
export function inferRelationships(model) {
  const byName = new Map();
  for (const t of model.tables) {
    const key = t.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, t);
  }

  const declared = new Set(
    model.relationships.map((r) => `${r.from.table}|${r.from.columns.join(',')}`),
  );

  const inferred = [];
  for (const table of model.tables) {
    if (table.external) continue;
    for (const col of table.columns) {
      const match = /^(.+?)_?id$/i.exec(col.name);
      if (!match || col.name.toLowerCase() === 'id') continue;
      if (declared.has(`${table.id}|${col.name}`)) continue;

      const base = match[1].replace(/_$/, '').toLowerCase();
      let parent = null;
      for (const cand of singularCandidates(base)) {
        if (byName.has(cand)) {
          parent = byName.get(cand);
          break;
        }
      }
      if (!parent) continue;

      const pkCols = parent.columns.filter((c) => c.pk);
      const target =
        (pkCols.length === 1 && pkCols[0]) ||
        parent.columns.find((c) => c.name.toLowerCase() === 'id') ||
        parent.columns.find((c) => c.name.toLowerCase() === col.name.toLowerCase());
      if (!target) continue;
      if (parent.id === table.id && target.name === col.name) continue;

      inferred.push({
        id: `${table.id}:inferred:${col.name}`,
        name: `${col.name} → ${parent.name}.${target.name}`,
        from: { table: table.id, columns: [col.name] },
        to: { table: parent.id, columns: [target.name] },
        inferred: true,
      });
    }
  }

  return { ...model, relationships: [...model.relationships, ...inferred] };
}

const col = (name, type, opts = {}) => ({
  name,
  type,
  nullable: opts.nullable ?? !opts.pk,
  comment: opts.comment ?? null,
  pk: Boolean(opts.pk),
  fk: Boolean(opts.fk),
});

const rel = (from, fromCols, to, toCols) => ({
  id: `${from}:fk_${fromCols.join('_')}`,
  name: `fk_${from.split('.').pop()}_${fromCols.join('_')}`,
  from: { table: from, columns: fromCols },
  to: { table: to, columns: toCols },
  inferred: false,
});

/** Sample retail schema so the app is usable before any connection is set up. */
export function demoModel() {
  const s = 'demo.retail';
  const t = (name, comment, columns) => ({
    id: `${s}.${name}`,
    name,
    catalog: 'demo',
    schema: 'retail',
    type: 'TABLE',
    comment,
    columns,
  });
  return {
    tables: [
      t('customers', 'Registered customers', [
        col('customer_id', 'bigint', { pk: true }),
        col('email', 'string', { nullable: false }),
        col('full_name', 'string'),
        col('region_id', 'int', { fk: true }),
        col('created_at', 'timestamp'),
      ]),
      t('regions', 'Sales regions', [
        col('region_id', 'int', { pk: true }),
        col('name', 'string'),
        col('country_code', 'string'),
      ]),
      t('orders', 'Customer orders', [
        col('order_id', 'bigint', { pk: true }),
        col('customer_id', 'bigint', { fk: true, nullable: false }),
        col('store_id', 'int', { fk: true }),
        col('status', 'string'),
        col('ordered_at', 'timestamp'),
        col('total_amount', 'decimal(12,2)'),
      ]),
      t('order_items', 'Line items for each order', [
        col('order_id', 'bigint', { pk: true, fk: true }),
        col('line_no', 'int', { pk: true }),
        col('product_id', 'bigint', { fk: true, nullable: false }),
        col('quantity', 'int'),
        col('unit_price', 'decimal(12,2)'),
      ]),
      t('products', 'Product catalog', [
        col('product_id', 'bigint', { pk: true }),
        col('sku', 'string', { nullable: false }),
        col('name', 'string'),
        col('category_id', 'int', { fk: true }),
        col('list_price', 'decimal(12,2)'),
      ]),
      t('categories', 'Product categories (hierarchical)', [
        col('category_id', 'int', { pk: true }),
        col('parent_category_id', 'int', { fk: true }),
        col('name', 'string'),
      ]),
      t('stores', 'Physical and online stores', [
        col('store_id', 'int', { pk: true }),
        col('region_id', 'int', { fk: true }),
        col('name', 'string'),
        col('is_online', 'boolean'),
      ]),
      t('payments', 'Payments captured against orders', [
        col('payment_id', 'bigint', { pk: true }),
        col('order_id', 'bigint', { fk: true, nullable: false }),
        col('method', 'string'),
        col('amount', 'decimal(12,2)'),
        col('paid_at', 'timestamp'),
      ]),
      t('inventory', 'Stock on hand per store and product', [
        col('store_id', 'int', { pk: true, fk: true }),
        col('product_id', 'bigint', { pk: true, fk: true }),
        col('on_hand', 'int'),
        col('updated_at', 'timestamp'),
      ]),
    ],
    relationships: [
      rel(`${s}.customers`, ['region_id'], `${s}.regions`, ['region_id']),
      rel(`${s}.orders`, ['customer_id'], `${s}.customers`, ['customer_id']),
      rel(`${s}.orders`, ['store_id'], `${s}.stores`, ['store_id']),
      rel(`${s}.order_items`, ['order_id'], `${s}.orders`, ['order_id']),
      rel(`${s}.order_items`, ['product_id'], `${s}.products`, ['product_id']),
      rel(`${s}.products`, ['category_id'], `${s}.categories`, ['category_id']),
      rel(`${s}.categories`, ['parent_category_id'], `${s}.categories`, ['category_id']),
      rel(`${s}.stores`, ['region_id'], `${s}.regions`, ['region_id']),
      rel(`${s}.payments`, ['order_id'], `${s}.orders`, ['order_id']),
      rel(`${s}.inventory`, ['store_id'], `${s}.stores`, ['store_id']),
      rel(`${s}.inventory`, ['product_id'], `${s}.products`, ['product_id']),
    ],
  };
}
