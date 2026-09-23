const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProductSearch } = require('../src/services/productSearch');

const items = [
  { id: 1, article: 'other', name: 'Legrand ABC-12' },
  { id: 2, article: 'ABC-123', name: 'Partial article' },
  { id: 3, article: 'AbC-12', name: 'Exact article', price: 42, image: null },
];
const page = async () => ({ page: 1, per_page: 20, count: items.length, items });

test('search ranks exact article before partial article before name', async () => {
  const search = createProductSearch(page);
  const result = await search('abc-12');
  assert.deepEqual(result.items.map(p => p.id), [3, 2, 1]);
  assert.equal(result.count, 3);
  assert.deepEqual(result.items[0], items[2]);
});

test('search matches names without case sensitivity and trims query', async () => {
  const result = await createProductSearch(page)('  lEgRaNd  ');
  assert.equal(result.query, 'lEgRaNd');
  assert.deepEqual(result.items, [items[0]]);
});

test('unknown search returns an empty array', async () => {
  assert.deepEqual(await createProductSearch(page)('missing'), { query: 'missing', count: 0, items: [] });
});

test('missing, empty, repeated and oversized queries fail before network access', async () => {
  const search = createProductSearch(() => assert.fail('Unexpected API request'));
  for (const q of [undefined, '', '   ', ['a', 'b'], {}, 'a'.repeat(201)]) {
    await assert.rejects(search(q), { status: 400, code: 'INVALID_SEARCH_QUERY' });
  }
});

test('search loads at most three pages and shares cache across queries', async () => {
  const calls = [];
  let now = 0;
  const search = createProductSearch(async pageNumber => {
    calls.push(pageNumber);
    return { count: 1, per_page: 1, items: [{ id: Number(pageNumber), article: pageNumber, name: 'Product' }] };
  }, () => now);
  const [first, second] = await Promise.all([search('product'), search('2')]);
  assert.equal(first.count, 3);
  assert.equal(second.items[0].id, 2);
  assert.deepEqual(calls, ['1', '2', '3']);
  await search('missing');
  assert.equal(calls.length, 3);
  now = 180001;
  await search('product');
  assert.equal(calls.length, 6);
});

test('empty page stops pagination without assuming count is total', async () => {
  const calls = [];
  const search = createProductSearch(async p => {
    calls.push(p);
    return { count: 1, per_page: 1, items: p === '1' ? [items[0]] : [] };
  });
  await search('Legrand');
  assert.deepEqual(calls, ['1', '2']);
});

test('failed loads are retried, not returned as an empty successful search', async () => {
  let attempts = 0;
  const search = createProductSearch(async () => {
    if (++attempts === 1) throw new Error('API unavailable');
    return page();
  });
  await assert.rejects(search('Legrand'));
  assert.equal((await search('Legrand')).count, 1);
});

test('unexpected catalog structure reports an upstream error', async () => {
  await assert.rejects(createProductSearch(async () => ({ items: null }))('Legrand'), { status: 502, code: 'EKT_INVALID_CATALOG' });
});
