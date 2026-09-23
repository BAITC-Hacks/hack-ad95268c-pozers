const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/server');
const { EktApiError } = require('../src/services/ektApi');

// Только искусственные данные. SDK и каталог всегда замоканы.
const product = { id: 515279, name: 'Legrand 40A', article: 'ABC-123', price: 42, image: null, url: 'https://ekt.kz/catalog/test', offers: [] };
const second = { ...product, id: 515280, article: 'ABC-124' };
const tool = (name, args) => ({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_' + name, name, arguments: JSON.stringify(args) }] });
const plan = (ids = [product.id], fields = [], kind = 'products') => ({ status: 'completed', output: [], output_text: JSON.stringify({ kind, product_ids: ids, fields }) });

async function setup(t, responses, options = {}) {
  const calls = [];
  const details = [];
  const searches = [];
  const aiClient = { responses: { create: async params => {
    calls.push(structuredClone(params));
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'Unexpected OpenAI request');
    return response;
  } } };
  const catalog = {
    getProducts: async page => ({ page: Number(page || 1), per_page: 20, count: 1, items: [product] }),
    getProductById: async id => {
      details.push(id);
      if (options.detailError) throw options.detailError;
      return options.detail || { ...product, quantity: 0, description: 'Описание из API', properties: { NOMINALNYY_TOK: '40' }, stores: [{ id: 1, name: 'Склад', quantity: 0 }] };
    },
  };
  const app = createApp({ catalog, aiClient, ...(options.useRealSearch ? {} : { searchProducts: async q => {
    searches.push(q);
    return { query: q, count: (options.items || [product]).length, items: options.items || [product] };
  } }) });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async body => {
    const response = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { post, calls, details, searches, base };
}

test('POST /api/chat rejects empty and invalid messages before calling OpenAI', async t => {
  const { post, calls } = await setup(t, []);
  for (const body of [{}, { message: '' }, { message: '   ' }, { message: 123 }, { message: 'a'.repeat(2001) }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('chat uses Responses function outputs and returns source-only cards and price', async t => {
  const { post, calls, searches } = await setup(t, [tool('search_products', { query: 'ABC-123' }), plan([product.id], ['price'])]);
  const response = await post({ message: 'Цена ABC-123?' });
  assert.equal(response.status, 200);
  assert.match(response.body.message, /42/);
  const { offers, ...card } = product;
  assert.deepEqual(response.body.products, [card]);
  assert.deepEqual(searches, ['ABC-123']);
  assert.equal(calls[0].model, 'gpt-5.6-luna');
  assert.equal(calls[0].store, false);
  assert.equal(calls[0].tools.length, 2);
  assert.equal(calls[1].input.at(-1).type, 'function_call_output');
});

test('unknown product returns the exact honest fallback', async t => {
  const { post } = await setup(t, [tool('search_products', { query: 'XYZ123NOTFOUND' }), plan([], [], 'not_found')], { items: [] });
  assert.deepEqual((await post({ message: 'XYZ123NOTFOUND' })).body, {
    message: 'Не удалось найти подходящий товар в доступной части каталога.', products: [],
  });
});

test('multiple matching products are shown with a clarification request', async t => {
  const { post } = await setup(t, [tool('search_products', { query: 'Legrand' }), plan([product.id, second.id])], { items: [product, second] });
  const { body } = await post({ message: 'Найди Legrand' });
  assert.equal(body.products.length, 2);
  assert.match(body.message, /Уточните артикул/);
});

test('availability forces real detail even if model skips the detail call', async t => {
  const { post, details } = await setup(t, [tool('search_products', { query: 'ABC-123' }), plan()]);
  const { body } = await post({ message: 'Сколько осталось ABC-123?' });
  assert.deepEqual(details, ['515279']);
  assert.equal(body.products[0].quantity, 0);
  assert.match(body.message, /Доступное количество: 0/);
});

test('detail tool is called directly for an explicit ID and source properties are used', async t => {
  const { post, details } = await setup(t, [tool('get_product_detail', { id: product.id }), plan([product.id], ['properties'])]);
  const { body } = await post({ message: 'Какие характеристики у товара 515279?' });
  assert.deepEqual(details, ['515279']);
  assert.match(body.message, /NOMINALNYY_TOK: 40/);
});

test('missing quantity and certificates are never invented', async t => {
  const { post } = await setup(t, [tool('search_products', { query: 'ABC-123' }), plan([product.id], ['quantity'], 'missing')], { detail: product });
  const { body } = await post({ message: 'Наличие и сертификат ABC-123' });
  assert.match(body.message, /В полученных данных эта информация не указана\./);
  assert.equal(Object.hasOwn(body.products[0], 'quantity'), false);
});

test('untrusted free-form AI claims are not forwarded', async t => {
  const { post } = await setup(t, [tool('search_products', { query: 'ABC-123' }), { status: 'completed', output: [], output_text: 'На складе 999999 товаров, есть сертификат!' }]);
  const response = await post({ message: 'Наличие ABC-123' });
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(response.body), /999999|сертификат/);
});

test('invented product IDs are rejected', async t => {
  const { post } = await setup(t, [tool('search_products', { query: 'ABC-123' }), plan([123456])]);
  const response = await post({ message: 'ABC-123' });
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'AI_UNGROUNDED_ID');
});

test('AI cannot fetch arbitrary detail IDs that were not in search or the request', async t => {
  const { post, details } = await setup(t, [tool('get_product_detail', { id: 123456 })]);
  assert.equal((await post({ message: 'Найди Legrand' })).status, 502);
  assert.deepEqual(details, []);
});

test('OpenAI errors return safe HTTP 502/503 without upstream text', async t => {
  for (const status of [401, 429, 500, undefined]) {
    const error = Object.assign(new Error('private-upstream-text'), { status });
    const { post } = await setup(t, [error]);
    const response = await post({ message: 'Legrand' });
    assert.ok([502, 503].includes(response.status));
    assert.doesNotMatch(JSON.stringify(response.body), /private-upstream-text|stack|Authorization/);
  }
});

test('catalog outage remains an error, not a successful empty search', async t => {
  const { post } = await setup(t, [tool('get_product_detail', { id: product.id })], { detailError: new EktApiError('API ekt.kz вернул ошибку.', 502, 'EKT_HTTP_ERROR', 500) });
  const response = await post({ message: 'Товар 515279' });
  assert.equal(response.status, 502);
  assert.equal(response.body.error.upstreamStatus, 500);
});

test('nonexistent detail returns not found, never a product card', async t => {
  const { post } = await setup(t, [tool('get_product_detail', { id: 99999 }), plan([], [], 'not_found')], { detailError: new EktApiError('Товар не найден.', 404, 'PRODUCT_NOT_FOUND', 404) });
  const response = await post({ message: 'Товар 99999' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.products, []);
});

test('greeting needs no catalogue and cannot return model-written product facts', async t => {
  const { post, searches, details } = await setup(t, [plan([], [], 'greeting')]);
  const { body } = await post({ message: 'Привет' });
  assert.match(body.message, /Помогу найти товары/);
  assert.deepEqual(body.products, []);
  assert.deepEqual(searches, []);
  assert.deepEqual(details, []);
});

test('products cannot be answered without a catalogue call', async t => {
  const { post } = await setup(t, [plan([product.id])]);
  const response = await post({ message: 'Цена Legrand' });
  assert.equal(response.body.error.code, 'AI_CATALOG_REQUIRED');
});

test('tool call loop is bounded', async t => {
  const { post, calls } = await setup(t, Array.from({ length: 7 }, () => tool('search_products', { query: 'Legrand' })));
  const response = await post({ message: 'Legrand' });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'AI_TOOL_LIMIT');
  assert.equal(calls.length, 7);
});

test('old HTTP endpoints and search cache continue to work without OpenAI', async t => {
  const { base, calls } = await setup(t, [], { useRealSearch: true });
  for (const path of ['/api/health', '/api/products', '/api/products?page=2', '/api/products/search?q=Legrand', '/api/products/515279']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    const body = await response.json();
    if (path === '/api/health') assert.deepEqual(body, { ok: true });
    if (path.endsWith('page=2')) assert.equal(body.page, 2);
    if (path.includes('search')) assert.equal(body.items[0].id, product.id);
    if (path.endsWith('/515279')) assert.equal(body.id, product.id);
  }
  assert.equal(calls.length, 0);
  assert.equal((await fetch(base + '/api/products/search?q=')).status, 400);
});

test('missing OpenAI key does not prevent startup or health checks', async t => {
  const original = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original; });
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/health')).status, 200);
  const response = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Legrand' }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'OPENAI_NOT_CONFIGURED');
});
