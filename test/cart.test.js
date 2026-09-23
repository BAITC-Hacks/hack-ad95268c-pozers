const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/server');
const { EktApiError } = require('../src/services/ektApi');

async function fixture(t, getDetail) {
  const state = { stock: 10, price: 100, calls: 0 };
  const catalog = {
    getProducts: async () => [],
    getProductById: async id => {
      state.calls++;
      if (getDetail) return getDetail(id, state);
      return { id: Number(id), name: 'Catalog product', article: 'REAL-123', quantity: state.stock, price: state.price };
    },
  };
  const server = createApp({ catalog }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/cart`;
  function client() {
    let cookie;
    return async (path = '', body) => {
      const response = await fetch(url + path, {
        headers: { ...(cookie && { Cookie: cookie }), 'Content-Type': 'application/json' },
        ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: response.status, body: await response.json() };
    };
  }
  return { state, client, request: client(), url };
}
const add = (request, quantity = 2, productId = 123) => request('/proposals', { productId, quantity });
const confirm = (request, proposal) => request('/confirm', { proposalId: proposal.body.proposalId });

test('cart proposal fetches detail but does not change server cart', async t => {
  const { request, state } = await fixture(t);
  const proposal = await add(request);
  assert.equal(proposal.status, 201);
  assert.equal(proposal.body.items[0].product.article, 'REAL-123');
  assert.equal(state.calls, 1);
  assert.equal((await request()).body.totalCount, 0);
});

test('cart confirm re-fetches detail and persists real product in the same session', async t => {
  const { request, state } = await fixture(t);
  const proposal = await request('/proposals', { productId: '123', quantity: 2, price: 1, stock: 999, name: 'Invented' });
  assert.equal((await confirm(request, proposal)).status, 200);
  const cart = (await request()).body;
  assert.equal(cart.totalCount, 2);
  assert.equal(cart.totalPrice, 200);
  assert.equal(cart.items[0].product.name, 'Catalog product');
  assert.equal(state.calls, 2);
});

test('cart blocks invalid quantities and stock overflow before proposal', async t => {
  const { request, state } = await fixture(t);
  for (const quantity of [0, -1, 1.5, null, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await add(request, quantity)).status, 400);
  }
  assert.equal(state.calls, 0);
  const overflow = await add(request, 11);
  assert.equal(overflow.status, 409);
  assert.equal(overflow.body.error.code, 'CART_STOCK_EXCEEDED');
  assert.equal((await request()).body.totalCount, 0);
});

test('cart counts existing items at both proposal and confirmation, rechecking reduced stock', async t => {
  const { request, state } = await fixture(t);
  await confirm(request, await add(request, 6));
  assert.equal((await add(request, 5)).status, 409);
  const proposal = await add(request, 4);
  state.stock = 9;
  assert.equal((await confirm(request, proposal)).status, 409);
  assert.equal((await request()).body.totalCount, 6);
});

test('concurrent and repeated confirmations of one proposal add exactly once', async t => {
  const { request, state } = await fixture(t);
  const proposal = await add(request, 3);
  const results = await Promise.all([confirm(request, proposal), confirm(request, proposal), confirm(request, proposal)]);
  assert.deepEqual(results.map(result => result.status), [200, 200, 200]);
  assert.equal((await request()).body.totalCount, 3);
  assert.equal(state.calls, 2);
});

test('concurrent distinct proposals cannot jointly exceed stock', async t => {
  const { request } = await fixture(t);
  const first = await add(request, 6);
  const second = await add(request, 6);
  const results = await Promise.all([confirm(request, first), confirm(request, second)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await request()).body.totalCount, 6);
});

test('cancellation is idempotent and cancelled proposals cannot be confirmed', async t => {
  const { request } = await fixture(t);
  const proposal = await add(request);
  const body = { proposalId: proposal.body.proposalId };
  assert.equal((await request('/cancel', body)).status, 200);
  assert.equal((await request('/cancel', body)).status, 200);
  assert.equal((await confirm(request, proposal)).body.error.code, 'CART_PROPOSAL_CANCELLED');
  assert.equal((await request()).body.totalCount, 0);
});

test('different sessions cannot read, confirm or cancel another session proposal', async t => {
  const { request, client } = await fixture(t);
  const stranger = client();
  const proposal = await add(request);
  assert.equal((await confirm(stranger, proposal)).status, 404);
  assert.equal((await stranger('/cancel', { proposalId: proposal.body.proposalId })).status, 404);
  await confirm(request, proposal);
  assert.equal((await stranger()).body.totalCount, 0);
  assert.equal((await request()).body.totalCount, 2);
});

test('detail failure on confirmation leaves cart unchanged with safe upstream status', async t => {
  const { request } = await fixture(t, (id, state) => {
    if (state.calls > 1) throw new EktApiError('Каталог недоступен.', 502, 'EKT_HTTP_ERROR', 503);
    return { id: Number(id), name: 'Product', quantity: 5, price: 10 };
  });
  const proposal = await add(request);
  const failure = await confirm(request, proposal);
  assert.equal(failure.status, 502);
  assert.equal(failure.body.error.upstreamStatus, 503);
  assert.equal((await request()).body.totalCount, 0);
});

test('unknown stock and missing products cannot produce a proposal', async t => {
  const { request } = await fixture(t, id => {
    if (id === '404') throw new EktApiError('Товар не найден.', 404, 'PRODUCT_NOT_FOUND');
    return { id: Number(id), name: 'Product', quantity: null };
  });
  assert.equal((await add(request)).body.error.code, 'CART_STOCK_UNKNOWN');
  assert.equal((await add(request, 1, 404)).status, 404);
  assert.equal((await request()).body.totalCount, 0);
});

test('batch proposal aggregates duplicates and confirms atomically', async t => {
  const { request, state } = await fixture(t, (id, state) => ({ id: Number(id), name: 'Product', quantity: id === '2' ? state.stock : 10, price: 10 }));
  const proposal = await request('/proposals', { items: [{ productId: 1, quantity: 2 }, { productId: 1, quantity: 3 }, { productId: 2, quantity: 3 }] });
  assert.equal(proposal.body.items.length, 2);
  assert.equal(proposal.body.items[0].quantity, 5);
  state.stock = 2;
  assert.equal((await confirm(request, proposal)).status, 409);
  assert.equal((await request()).body.totalCount, 0);
  state.stock = 3;
  assert.equal((await confirm(request, proposal)).status, 200);
  assert.equal((await request()).body.totalCount, 8);
});

test('price changes require a new proposal; confirmed proposal cannot be cancelled', async t => {
  const { request, state } = await fixture(t);
  const proposal = await add(request);
  state.price++;
  assert.equal((await confirm(request, proposal)).body.error.code, 'CART_PRICE_CHANGED');
  assert.equal((await request()).body.totalCount, 0);
  const fresh = await add(request);
  await confirm(request, fresh);
  assert.equal((await request('/cancel', { proposalId: fresh.body.proposalId })).status, 409);
  assert.equal((await request()).body.totalCount, 2);
});

test('existing remove action persists on server and confirmed proposals cannot restore a removed item', async t => {
  const { request } = await fixture(t);
  const proposal = await add(request);
  await confirm(request, proposal);
  assert.equal((await request('/remove', { productId: 123 })).status, 200);
  await confirm(request, proposal);
  assert.equal((await request()).body.totalCount, 0);
});

test('cart CORS permits credentials only for configured origin and uses a protected session cookie', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url, { headers: { Origin: 'http://localhost:4173' } });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:4173');
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict') && cookie.includes('Path=/api/cart'));
  assert.equal((await fetch(url, { headers: { Origin: 'http://localhost:9999' } })).status, 403);
  const preflight = await fetch(url + '/confirm', { method: 'OPTIONS', headers: { Origin: 'http://localhost:4173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), 'true');
});
