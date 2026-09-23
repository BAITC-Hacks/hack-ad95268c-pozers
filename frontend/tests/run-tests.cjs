// Optional checks with Node.js, no packages required: node frontend/tests/run-tests.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function runTests() {
  let fetchResult;
  const fetchCalls = [];
  const context = vm.createContext({ window: {}, AbortSignal, fetch: async (url, options) => {
    fetchCalls.push({ url, options });
    if (fetchResult instanceof Error) throw fetchResult;
    return { ok: fetchResult.status >= 200 && fetchResult.status < 300, status: fetchResult.status, json: async () => fetchResult.body };
  } });
  const directory = path.resolve(__dirname, "..");
  for (const name of ["demo-data.js", "assistant-service.js", "cart.js", "revisor.js"]) {
    vm.runInContext(fs.readFileSync(path.join(directory, name), "utf8"), context, { filename: name });
  }
  const demo = { ...context.window.EktApp, products: context.window.EktDemo.products };
  const checks = [];
  async function check(name, callback) {
    await callback();
    checks.push(name);
  }
  const product = demo.products[0];

  await check("Opening and cancelling a confirmation leaves the cart empty", () => {
    const cart = demo.createCart(demo.products);
    const pending = cart.prepare(product.id);
    assert.equal(pending.ok, true);
    assert.equal(cart.snapshot().totalCount, 0);
    cart.setQuantity(pending.token, "3");
    assert.equal(cart.snapshot().totalPrice, 0);
    cart.cancel(pending.token);
    assert.equal(cart.confirm(pending.token).ok, false);
    assert.equal(cart.snapshot().totalCount, 0);
  });
  await check("Confirmation adds the specified quantity exactly once", () => {
    const cart = demo.createCart(demo.products);
    const pending = cart.prepare(product.id);
    assert.equal(cart.setQuantity(pending.token, "3").total, product.price * 3);
    assert.equal(cart.confirm(pending.token).ok, true);
    assert.equal(cart.confirm(pending.token).ok, false);
    assert.equal(cart.snapshot().totalCount, 3);
    assert.equal(cart.snapshot().totalPrice, product.price * 3);
  });
  await check("Previously added quantities count towards the stock limit", () => {
    const cart = demo.createCart(demo.products);
    let pending = cart.prepare(product.id);
    cart.setQuantity(pending.token, "3");
    cart.confirm(pending.token);
    pending = cart.prepare(product.id);
    assert.equal(pending.available, product.stock - 3);
    assert.equal(cart.setQuantity(pending.token, String(product.stock)).ok, false);
    assert.equal(cart.confirm(pending.token).ok, false);
    assert.equal(cart.snapshot().totalCount, 3);
    assert.equal(cart.setQuantity(pending.token, String(product.stock - 3)).ok, true);
    assert.equal(cart.confirm(pending.token).ok, true);
    assert.equal(cart.snapshot().totalCount, product.stock);
    assert.equal(cart.snapshot().items.length, 1);
    assert.equal(cart.available(product.id), 0);
    assert.equal(cart.prepare(product.id).ok, false);
  });
  await check("Empty, zero, negative, fractional and malformed quantities cannot be confirmed", () => {
    for (const value of ["", " ", "0", "-1", "1.5", "abc", "NaN", "Infinity", "1e1", "0x2", "9007199254740992"]) {
      const cart = demo.createCart(demo.products);
      const pending = cart.prepare(product.id);
      assert.equal(cart.setQuantity(pending.token, value).ok, false, value);
      assert.equal(cart.confirm(pending.token).ok, false, value);
      assert.equal(cart.snapshot().totalCount, 0, value);
    }
  });
  await check("A new confirmation invalidates an old confirmation", () => {
    const cart = demo.createCart(demo.products);
    const first = cart.prepare(product.id);
    const second = cart.prepare(demo.products[1].id);
    assert.equal(cart.confirm(first.token).ok, false);
    cart.cancel(first.token);
    assert.equal(cart.confirm(second.token).ok, true);
    assert.equal(cart.snapshot().items[0].product.id, demo.products[1].id);
  });
  await check("Multiple products sum correctly; removal restores available stock", () => {
    const cart = demo.createCart(demo.products);
    let expectedTotal = 0;
    for (const item of demo.products) {
      const pending = cart.prepare(item.id);
      cart.setQuantity(pending.token, "2");
      cart.confirm(pending.token);
      expectedTotal += item.price * 2;
    }
    assert.equal(cart.snapshot().totalCount, 6);
    assert.equal(cart.snapshot().totalPrice, expectedTotal);
    cart.remove(product.id);
    assert.equal(cart.snapshot().totalCount, 4);
    assert.equal(cart.snapshot().totalPrice, expectedTotal - product.price * 2);
    assert.equal(cart.available(product.id), product.stock);
  });
  await check("Unknown and out-of-stock products cannot be added", () => {
    const cart = demo.createCart([{ ...product, stock: 0 }]);
    assert.equal(cart.prepare(product.id).ok, false);
    assert.equal(cart.prepare("missing").ok, false);
    assert.equal(cart.snapshot().totalCount, 0);
  });
  await check("Blank messages are rejected; real chat payload and products are adapted", async () => {
    await assert.rejects(demo.getReply("   "));
    fetchResult = { status: 200, body: { message: "Реальный ответ", products: [{ id: 515279, name: "Legrand", article: "200300273_", quantity: 36, price: 26930, image: "https://ekt.kz/image.jpg", url: "https://ekt.kz/catalog/item" }] } };
    const reply = await demo.getReply("Есть Legrand 40A?");
    assert.equal(fetchCalls[0].url, "http://localhost:3000/api/chat");
    assert.equal(fetchCalls[0].options.method, "POST");
    assert.equal(JSON.parse(fetchCalls[0].options.body).message, "Есть Legrand 40A?");
    assert.equal(reply.text, "Реальный ответ");
    assert.equal(reply.products.length, 1);
    assert.equal(reply.products[0].sku, "200300273_");
    assert.equal(reply.products[0].stock, 36);
    assert.equal(reply.products[0].id, "515279");
    assert.equal(reply.products[0].price, 26930);
    assert.equal(reply.products[0].features, undefined);
    assert.equal(reply.products[0].certificateUrl, undefined);
  });
  await check("Unknown stock and price are not fabricated; unsafe URLs are removed", () => {
    const item = demo.adaptProduct({ id: 123, name: "Без данных", image: "javascript:alert(1)", url: "data:text/html,test" });
    assert.equal(item.stock, null);
    assert.equal(item.price, null);
    assert.equal(item.image, null);
    assert.equal(item.url, null);
    const cart = demo.createCart([item]);
    assert.equal(cart.prepare(123).ok, false);
  });
  await check("Real numeric IDs work in cart and detail does not add anything", async () => {
    fetchResult = { status: 200, body: { id: 515279, name: "Legrand", quantity: 2, price: 0 } };
    const item = await demo.getProduct(515279);
    assert.equal(fetchCalls.at(-1).url, "http://localhost:3000/api/products/515279");
    const cart = demo.createCart();
    cart.register([item]);
    const pending = cart.prepare(515279);
    assert.equal(cart.snapshot().totalCount, 0);
    assert.equal(cart.setQuantity(pending.token, '3').ok, false);
    assert.equal(cart.confirm(pending.token).ok, false);
    cart.setQuantity(pending.token, '2');
    cart.confirm(pending.token);
    assert.equal(cart.snapshot().totalCount, 2);
    assert.equal(cart.snapshot().totalPrice, 0);
  });
  await check("A refreshed lower stock is checked again on confirmation", () => {
    const cart = demo.createCart([{ id: 123, stock: 5, price: 10 }]);
    const pending = cart.prepare(123);
    cart.setQuantity(pending.token, '5');
    cart.register([{ id: 123, stock: 2, price: 10 }]);
    assert.equal(cart.confirm(pending.token).ok, false);
    assert.equal(cart.snapshot().totalCount, 0);
  });
  await check("Empty real results stay empty; demo products are never added", async () => {
    fetchResult = { status: 200, body: { message: "Не найдено", products: [] } };
    assert.equal((await demo.getReply('XYZ123NOTFOUND')).products.length, 0);
  });
  await check("API and network errors stay visible without exposing server internals or demo fallback", async () => {
    fetchResult = { status: 503, body: { error: { code: "OPENAI_UNAVAILABLE", message: "private-upstream-details" } } };
    await assert.rejects(demo.getReply('Legrand'), error => /HTTP 503/.test(error.message) && !/private/.test(error.message));
    fetchResult = new Error('private-network-details');
    await assert.rejects(demo.getReply('Legrand'), error => /backend/.test(error.message) && !/private/.test(error.message));
  });
  await check("Revisor sends the list to live audit endpoint, never the demo backend", async () => {
    fetchResult = { status: 200, body: { rows: [], data_mode: 'live', message: 'Проверка завершена.' } };
    await demo.audit('200300273_ ; 2');
    assert.equal(fetchCalls.at(-1).url, 'http://localhost:3000/api/audit');
    assert.equal(JSON.parse(fetchCalls.at(-1).options.body).text, '200300273_ ; 2');
    fetchResult.body.data_mode = 'demo';
    await assert.rejects(demo.audit('200300273_ ; 2'));
  });
  await check("Revisor only selects ready rows, keeps null price unknown and invalidates edited results", () => {
    const state = demo.createAuditSelection();
    const row = { id: 'row-1', quantity: 2, status: 'ready', product: { id: 1, stock: 3, price: null } };
    state.reset({ rows: [row, { ...row, id: 'row-2', status: 'unknown' }] });
    assert.equal(state.items().length, 0);
    assert.equal(state.select('row-2', true), false);
    assert.equal(state.select('row-1', true), true);
    assert.equal(state.total(), null);
    assert.equal(state.items()[0].quantity, 2);
    state.reset();
    assert.equal(state.items().length, 0);
  });
  await check("Selecting, preparing and cancelling an audit batch never changes cart", () => {
    const cart = demo.createCart([{ id: 1, stock: 10, price: 5 }]);
    const batch = cart.prepareBatch([{ productId: 1, quantity: 2 }]);
    assert.equal(batch.ok, true);
    assert.equal(cart.snapshot().totalCount, 0);
    cart.cancel(batch.token);
    assert.equal(cart.confirm(batch.token).ok, false);
    assert.equal(cart.snapshot().totalCount, 0);
  });
  await check("Audit batch adds all chosen positions once after explicit confirmation", () => {
    const cart = demo.createCart([{ id: 1, stock: 10, price: 5 }, { id: 2, stock: 10, price: 7 }]);
    const batch = cart.prepareBatch([{ productId: 1, quantity: 2 }, { productId: 2, quantity: 3 }]);
    assert.equal(cart.snapshot().totalCount, 0);
    assert.equal(cart.confirm(batch.token).ok, true);
    assert.equal(cart.confirm(batch.token).ok, false);
    assert.equal(cart.snapshot().totalCount, 5);
    assert.equal(cart.snapshot().totalPrice, 31);
  });
  await check("Batch revalidation blocks every write if one stock dropped", () => {
    const cart = demo.createCart([{ id: 1, stock: 10, price: 5 }, { id: 2, stock: 10, price: 7 }]);
    const batch = cart.prepareBatch([{ productId: 1, quantity: 2 }, { productId: 2, quantity: 3 }]);
    cart.register([{ id: 2, stock: 1, price: 7 }]);
    assert.equal(cart.confirm(batch.token).ok, false);
    assert.equal(cart.snapshot().items.length, 0);
  });
  await check("Batch aggregates duplicates, counts existing cart and blocks unknown stock", () => {
    const cart = demo.createCart([{ id: 1, stock: 5, price: 5 }, { id: 2, stock: null, price: 7 }]);
    assert.equal(cart.prepareBatch([{ productId: 1, quantity: 3 }, { productId: 1, quantity: 3 }]).ok, false);
    assert.equal(cart.prepareBatch([{ productId: 2, quantity: 1 }]).ok, false);
    const first = cart.prepareBatch([{ productId: 1, quantity: 3 }]);
    cart.confirm(first.token);
    assert.equal(cart.prepareBatch([{ productId: 1, quantity: 3 }]).ok, false);
    assert.equal(cart.snapshot().totalCount, 3);
  });
  await check("Empty, fractional and negative audit batches cannot be confirmed", () => {
    const cart = demo.createCart([{ id: 1, stock: 5, price: 5 }]);
    for (const quantity of [null, 0, -1, 1.2, '2', Infinity]) assert.equal(cart.prepareBatch([{ productId: 1, quantity }]).ok, false);
    assert.equal(cart.prepareBatch([]).ok, false);
    assert.equal(cart.snapshot().totalCount, 0);
  });
  function serverCartFixture() {
    const product = demo.adaptProduct({ id: 123, name: 'Real product', article: 'ABC', quantity: 10, price: 5 });
    const state = { quantity: 0, proposals: [], confirms: [], cancels: [], reads: 0, failAfterConfirm: false };
    const committed = new Set();
    const api = {
      async getCart() {
        state.reads++;
        return { items: state.quantity ? [{ product, quantity: state.quantity, subtotal: state.quantity * 5 }] : [], totalCount: state.quantity, totalPrice: state.quantity * 5 };
      },
      async proposeCart(items) {
        const proposal = { proposalId: `proposal-${state.proposals.length + 1}`, items: items.map(item => ({ ...item, product })) };
        state.proposals.push(proposal);
        return proposal;
      },
      async confirmCart(id) {
        state.confirms.push(id);
        if (!committed.has(id)) {
          state.quantity += state.proposals.find(proposal => proposal.proposalId === id).items.reduce((total, item) => total + item.quantity, 0);
          committed.add(id);
        }
        if (state.failAfterConfirm) { state.failAfterConfirm = false; throw new Error('Connection interrupted'); }
      },
      async cancelCart(id) { state.cancels.push(id); },
      async removeCartItem() { state.quantity = 0; },
    };
    return { state, api, cart: demo.createServerCart(api) };
  }
  await check('Server cart preparation and cancellation never call confirm or mutate the snapshot', async () => {
    const { cart, state } = serverCartFixture();
    const proposal = await cart.prepare(123);
    assert.equal(proposal.ok, true);
    assert.equal(cart.snapshot().totalCount, 0);
    cart.setQuantity(proposal.token, '2');
    await cart.cancel(proposal.token);
    assert.equal(state.confirms.length, 0);
    assert.equal(state.cancels.length, 1);
    assert.equal((await cart.confirm(proposal.token)).ok, false);
  });
  await check('Explicit server confirmation refreshes the cart using GET and survives a new page model', async () => {
    const { cart, api, state } = serverCartFixture();
    const proposal = await cart.prepare(123);
    cart.setQuantity(proposal.token, '2');
    assert.equal((await cart.confirm(proposal.token)).ok, true);
    assert.equal(state.proposals.length, 2); // Changed quantity gets its own validated server proposal.
    assert.equal(state.cancels.length, 1);
    assert.equal(state.confirms.length, 1);
    assert.equal(cart.snapshot().totalCount, 2);
    const refreshedPage = demo.createServerCart(api);
    await refreshedPage.refresh();
    assert.equal(refreshedPage.snapshot().totalCount, 2);
    await refreshedPage.remove(123);
    assert.equal(refreshedPage.snapshot().totalCount, 0);
  });
  await check('Uncertain confirmation retries the same server proposal without duplicate creation', async () => {
    const { cart, state } = serverCartFixture();
    const proposal = await cart.prepare(123);
    state.failAfterConfirm = true;
    assert.equal((await cart.confirm(proposal.token)).ok, false);
    assert.equal(cart.setQuantity(proposal.token, '2').ok, false);
    assert.equal((await cart.confirm(proposal.token)).ok, true);
    assert.equal(state.proposals.length, 1);
    assert.equal(state.confirms[0], state.confirms[1]);
    assert.equal(cart.snapshot().totalCount, 1);
  });
  await check('Server cart blocks malformed quantity locally and batch requires explicit confirmation', async () => {
    const { cart, state } = serverCartFixture();
    let proposal = await cart.prepare(123);
    assert.equal(cart.setQuantity(proposal.token, '-1').ok, false);
    assert.equal((await cart.confirm(proposal.token)).ok, false);
    assert.equal(state.confirms.length, 0);
    await cart.cancel(proposal.token);
    proposal = await cart.prepareBatch([{ productId: 123, quantity: 3 }]);
    assert.equal(state.quantity, 0);
    assert.equal((await cart.confirm(proposal.token)).ok, true);
    assert.equal(cart.snapshot().totalCount, 3);
  });
  await check('Concurrent startup cart reads share one session initialization', async () => {
    const { cart, state } = serverCartFixture();
    await Promise.all([cart.refresh(), cart.refresh(), cart.refresh()]);
    assert.equal(state.reads, 1);
  });
  await check('Confirmation performs a fresh GET even when an older read is still in flight', async () => {
    const { cart, api, state } = serverCartFixture();
    const proposal = await cart.prepare(123);
    const original = api.getCart;
    let release;
    const stale = await original();
    api.getCart = () => new Promise(resolve => { release = () => resolve(stale); });
    const oldRead = cart.refresh();
    const confirmation = cart.confirm(proposal.token);
    api.getCart = original;
    release();
    await oldRead;
    assert.equal((await confirmation).ok, true);
    assert.equal(state.quantity, 1);
    assert.equal(cart.snapshot().totalCount, 1);
  });
  await check('Cart HTTP adapter sends cookies, adapts real fields and preserves safe stock errors', async () => {
    const product = { id: 123, name: 'Real product', article: 'ABC', quantity: 10, price: 5 };
    fetchResult = { status: 201, body: { proposalId: 'p-1', items: [{ product, productId: 123, quantity: 2 }] } };
    const proposal = await demo.proposeCart([{ productId: 123, quantity: 2 }]);
    assert.equal(proposal.items[0].product.stock, 10);
    assert.equal(fetchCalls.at(-1).url, 'http://localhost:3000/api/cart/proposals');
    assert.equal(fetchCalls.at(-1).options.credentials, 'include');
    fetchResult = { status: 200, body: { items: [{ product, quantity: 2 }], totalCount: 2 } };
    assert.equal((await demo.getCart()).items[0].product.sku, 'ABC');
    assert.equal(fetchCalls.at(-1).options.credentials, 'include');
    fetchResult = { status: 409, body: { error: { code: 'CART_STOCK_EXCEEDED', message: 'private-upstream-details' } } };
    await assert.rejects(demo.confirmCart('p-1'), error => /остатка.*HTTP 409/.test(error.message) && !/private/.test(error.message));
    assert.equal(JSON.parse(fetchCalls.at(-1).options.body).proposalId, 'p-1');
  });
  return { passed: checks.length, checks };
}

module.exports = runTests;
if (require.main === module) {
  runTests().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
