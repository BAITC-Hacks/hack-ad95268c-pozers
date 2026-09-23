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
    return { ok: fetchResult.status === 200, status: fetchResult.status, json: async () => fetchResult.body };
  } });
  const directory = path.resolve(__dirname, "..");
  for (const name of ["demo-data.js", "assistant-service.js", "cart.js"]) {
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
  return { passed: checks.length, checks };
}

module.exports = runTests;
if (require.main === module) {
  runTests().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
