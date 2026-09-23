import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDemoServer } from '../server-demo.mjs';

async function fixture(t) {
  const server = createDemoServer({ delay: 0 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function client() {
    const response = await fetch(`${url}/api/session`);
    const { csrf_token } = await response.json();
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return {
      cookie, token: csrf_token,
      async call(route, data = null, options = {}) {
        const response = await fetch(`${url}/api${route}`, {
          method: data ? 'POST' : 'GET',
          headers: { cookie, ...(data ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf_token } : {}), ...options.headers },
          ...(data ? { body: JSON.stringify({ request_id: randomUUID(), ...data }) } : {})
        });
        return { status: response.status, data: await response.json() };
      }
    };
  }
  return { server, url, client };
}
async function prepare(c, quantity = 2, product = 'demo-001', extra = {}) {
  const result = await c.call('/cart/proposals', { product_id: product, quantity, ...extra });
  assert.equal(result.status, 200);
  return result.data.proposal;
}

test('подготовка и запрос в чате НЕ меняют корзину', async t => {
  const { client } = await fixture(t); const c = await client();
  const answer = await c.call('/chat', { message: 'DEMO-001' });
  assert.equal(answer.status, 200); assert.equal(answer.data.products[0].sku, 'DEMO-001');
  await prepare(c);
  assert.deepEqual((await c.call('/cart')).data.cart.items, []);
});
test('подтверждение добавляет реальное серверное состояние и итог', async t => {
  const { client } = await fixture(t); const c = await client(); const proposal = await prepare(c, 3);
  const result = await c.call('/cart/confirm', { proposal_id: proposal.id });
  assert.equal(result.status, 200); assert.equal(result.data.status, 'confirmed');
  assert.equal(result.data.cart.items[0].quantity, 3); assert.equal(result.data.cart.total, 8550);
  assert.equal(result.data.cart.cart_url, '#cart');
  assert.equal((await c.call('/cart')).data.cart.total, 8550);
});
test('два параллельных клика и повтор с другим ключом НЕ удваивают добавление', async t => {
  const { client } = await fixture(t); const c = await client(); const proposal = await prepare(c, 2);
  const payload = { proposal_id: proposal.id, request_id: randomUUID() };
  const replies = await Promise.all([c.call('/cart/confirm', payload), c.call('/cart/confirm', payload)]);
  assert.deepEqual(replies.map(r => r.status), [200, 200]);
  assert.equal((await c.call('/cart/confirm', { proposal_id: proposal.id })).data.cart.items[0].quantity, 2);
  assert.equal((await c.call('/cart')).data.cart.revision, 1);
});
test('повтор подготовки возвращает то же предложение', async t => {
  const { client } = await fixture(t); const c = await client(); const key = randomUUID();
  const a = await prepare(c, 1, 'demo-001', { request_id: key });
  const b = await prepare(c, 1, 'demo-001', { request_id: key });
  assert.equal(a.id, b.id);
});
test('тот же request_id с другим количеством запрещён', async t => {
  const { client } = await fixture(t); const c = await client(); const key = randomUUID();
  await prepare(c, 1, 'demo-001', { request_id: key });
  assert.equal((await c.call('/cart/proposals', { product_id: 'demo-001', quantity: 2, request_id: key })).status, 409);
});
test('отмена повторяема и запрещает последующее добавление', async t => {
  const { client } = await fixture(t); const c = await client(); const p = await prepare(c);
  assert.equal((await c.call('/cart/cancel', { proposal_id: p.id })).data.status, 'cancelled');
  assert.equal((await c.call('/cart/cancel', { proposal_id: p.id })).data.status, 'cancelled');
  assert.equal((await c.call('/cart/confirm', { proposal_id: p.id })).status, 409);
  assert.equal((await c.call('/cart')).data.cart.items.length, 0);
});
test('чужая сессия не видит корзину и не подтверждает чужое предложение', async t => {
  const { client } = await fixture(t); const a = await client(); const b = await client(); const p = await prepare(a);
  assert.equal((await b.call('/cart/confirm', { proposal_id: p.id })).status, 404);
  await a.call('/cart/confirm', { proposal_id: p.id });
  assert.equal((await b.call('/cart')).data.cart.items.length, 0);
});
test('учитывается количество, которое уже есть в корзине', async t => {
  const { client } = await fixture(t); const c = await client(); const p = await prepare(c, 20);
  await c.call('/cart/confirm', { proposal_id: p.id });
  assert.equal((await c.call('/cart/proposals', { product_id: 'demo-001', quantity: 5 })).status, 409);
  assert.equal((await c.call('/cart')).data.cart.items[0].quantity, 20);
});
test('цена перепроверяется перед подтверждением', async t => {
  const { server, client } = await fixture(t); const c = await client(); const p = await prepare(c);
  server.demoState.catalog.get('demo-001').price = 3000;
  const result = await c.call('/cart/confirm', { proposal_id: p.id });
  assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PRICE_CHANGED');
  assert.equal((await c.call('/cart')).data.cart.total, 0);
});
test('остаток перепроверяется перед подтверждением', async t => {
  const { server, client } = await fixture(t); const c = await client(); const p = await prepare(c, 3);
  server.demoState.catalog.get('demo-001').stock = 1;
  assert.equal((await c.call('/cart/confirm', { proposal_id: p.id })).status, 409);
  assert.equal((await c.call('/cart')).data.cart.total, 0);
});
test('истёкшее предложение не добавляется', async t => {
  const { server, client } = await fixture(t); const c = await client(); const p = await prepare(c);
  const session = [...server.demoState.sessions.values()][0];
  session.proposals.get(p.id).expires_at = new Date(0).toISOString();
  assert.equal((await c.call('/cart/confirm', { proposal_id: p.id })).status, 410);
});
test('нет товара, ноль, дробь, минус и превышение остатка отклоняются', async t => {
  const { client } = await fixture(t); const c = await client();
  for (const quantity of [0, -1, 1.5, 25, '2']) {
    assert.ok((await c.call('/cart/proposals', { product_id: 'demo-001', quantity })).status >= 400);
  }
  assert.equal((await c.call('/cart/proposals', { product_id: 'missing', quantity: 1 })).status, 404);
  assert.equal((await c.call('/cart/proposals', { product_id: 'demo-004', quantity: 1 })).status, 409);
});
test('сбой чата можно повторить тем же ключом', async t => {
  const { client } = await fixture(t); const c = await client(); const payload = { message: 'тест ошибка', request_id: randomUUID() };
  assert.equal((await c.call('/chat', payload)).status, 503);
  assert.equal((await c.call('/chat', payload)).status, 200);
});
test('пустой поиск отличается от ответа об условиях', async t => {
  const { client } = await fixture(t); const c = await client();
  const empty = await c.call('/chat', { message: 'несуществующий товар' });
  assert.equal(empty.data.result_type, 'empty'); assert.deepEqual(empty.data.products, []);
  assert.equal((await c.call('/chat', { message: 'Условия покупки' })).data.result_type, 'terms');
});
test('нулевой остаток возвращает учебный аналог с объяснением', async t => {
  const { client } = await fixture(t); const c = await client();
  const result = await c.call('/chat', { message: 'DEMO-004' });
  assert.equal(result.data.products[0].stock, 0);
  assert.ok(result.data.products[1].stock > 0); assert.ok(result.data.products[1].reason);
});
test('CSRF, чужой Origin и чтение серверного кода запрещены', async t => {
  const { client, url } = await fixture(t); const c = await client();
  assert.equal((await c.call('/chat', { message: 'автомат' }, { headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await c.call('/chat', { message: 'автомат' }, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await fetch(`${url}/server-demo.mjs`)).status, 404);
  assert.equal((await fetch(`${url}/.env`)).status, 404);
});
test('повтор старого подтверждения возвращает свежую версию корзины', async t => {
  const { client } = await fixture(t); const c = await client();
  const p1 = await prepare(c, 1); const payload = { proposal_id: p1.id, request_id: randomUUID() };
  await c.call('/cart/confirm', payload);
  const p2 = await prepare(c, 1, 'demo-003');
  await c.call('/cart/confirm', { proposal_id: p2.id });
  const again = await c.call('/cart/confirm', payload);
  assert.equal(again.data.cart.items.length, 2); assert.equal(again.data.cart.revision, 2);
});

 test('после обновления страницы сессия возвращает неподтверждённое предложение', async t => {
  const { client } = await fixture(t); const c = await client(); const p = await prepare(c, 2);
  const restored = await c.call('/session');
  assert.equal(restored.status, 200); assert.equal(restored.data.proposal.id, p.id);
  assert.equal(restored.data.proposal.status, 'pending');
  await c.call('/cart/confirm', { proposal_id: p.id });
  assert.equal((await c.call('/session')).data.proposal, null);
});
