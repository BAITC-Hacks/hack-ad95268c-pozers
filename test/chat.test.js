const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createChatService } = require('../src/services/chat');
const { getProductDetail } = require('../src/services/ektApi');

// Искусственные товары только для тестов, не подставляются в рабочий каталог.
const product = { id: 123, name: 'Лампа LED 30W', article: 'AbC-123', price: 1810, offers: [], url_api_detail: 'https://ekt.kz/api/products/detail?id=123' };
function setup(items = [product], detail = {}) {
  const calls = [];
  const chat = createChatService({
    getProducts: async page => { calls.push(page); return { items: page === '1' ? items : [], per_page: 20 }; },
    getProductDetail: async () => ({ id: 123, ...detail }),
  });
  return { chat, session: {}, calls };
}

test('article matching is exact and case insensitive', async () => {
  const { chat, session } = setup();
  assert.equal((await chat('найди abc-123', session)).products[0].id, 123);
  assert.equal((await chat('abc-12', session)).reply, 'Информация не найдена в каталоге');
});

test('name matching is partial and case insensitive', async () => {
  const { chat, session } = setup();
  assert.equal((await chat('найди лАМПа led', session)).products[0].id, 123);
});

test('unknown product returns honest fallback and clears selection', async () => {
  const { chat, session } = setup();
  await chat('abc-123', session);
  assert.equal((await chat('неизвестный товар', session)).reply, 'Информация не найдена в каталоге');
  assert.equal(session.product, null);
});

test('price comes from API, zero is valid, absent price is not fabricated', async () => {
  const { chat, session } = setup();
  const response = await chat('цена abc-123', session);
  assert.equal(response.intent, 'price');
  assert.match(response.reply, /1810/);
  const missing = setup([{ ...product, price: null }]);
  assert.equal((await missing.chat('цена abc-123', missing.session)).reply, 'Информация не найдена в каталоге');
  const zero = setup([{ ...product, price: 0 }]);
  assert.match((await zero.chat('цена abc-123', zero.session)).reply, /: 0 /);
});

test('add without confirmation only creates pending action using session selection', async () => {
  const { chat, session } = setup();
  await chat('abc-123', session);
  const response = await chat('добавь 2 штуки', session);
  assert.deepEqual(response.pendingAction, { action: 'confirm_add_to_cart', productId: 123, quantity: 2 });
  assert.equal(response.reply, 'Добавить 2 шт. товара Лампа LED 30W в корзину?');
  assert.equal(session.cart, undefined);
  assert.equal((await chat('добавь 2 штуки', {})).pendingAction, null);
  assert.equal((await chat('да', session)).pendingAction, null);
  assert.equal(session.cart, undefined);
});

test('ambiguous products and invalid quantities never create actions', async () => {
  const { chat, session } = setup([product, { ...product, id: 124, article: 'another' }]);
  assert.equal((await chat('добавь 2 штуки лампа', session)).pendingAction, null);
  await chat('abc-123', session);
  assert.equal((await chat('добавь -2 штуки', session)).pendingAction, null);
});

test('availability uses detail quantity, not offers; specifications preserve source data', async () => {
  const { chat, session } = setup([product], { quantity: 0, stores: [], properties: { BRAND: 'Test' } });
  assert.equal((await chat('наличие abc-123', session)).data.quantity, 0);
  assert.deepEqual((await chat('характеристики abc-123', session)).data.properties, { BRAND: 'Test' });
  const missing = setup();
  assert.equal((await missing.chat('наличие abc-123', {})).reply, 'Информация не найдена в каталоге');
  assert.equal((await chat('аналоги abc-123', session)).reply, 'Информация не найдена в каталоге');
  assert.equal((await chat('сертификаты abc-123', session)).reply, 'Информация не найдена в каталоге');
});

test('search continues to subsequent pages, count is not assumed to be total', async () => {
  const chat = createChatService({ getProducts: async page => ({ count: 1, per_page: 1, items: page === '1' ? [{ ...product, article: 'other' }] : [product] }) });
  assert.equal((await chat('abc-123', {})).products[0].article, 'AbC-123');
});

test('bounded search explicitly reports incomplete results', async () => {
  let calls = 0;
  const chat = createChatService({ getProducts: async () => { calls++; return { per_page: 1, items: [product] }; } });
  const response = await chat('missing', {});
  assert.equal(response.searchComplete, false);
  assert.equal(calls, 20);
  assert.ok(response.note);
});

test('detail URL cannot send credentials to a different host', async () => {
  for (const url of ['https://example.com/api/products/detail?id=123', 'http://ekt.kz/api/products/detail?id=123', 'https://ekt.kz/other', 'invalid']) {
    await assert.rejects(getProductDetail(url), { code: 'EKT_INVALID_DETAIL_URL' });
  }
});
