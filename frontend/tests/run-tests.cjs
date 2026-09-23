// Optional checks with Node.js, no packages required: node frontend/tests/run-tests.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function runTests() {
  const context = vm.createContext({ window: {} });
  const directory = path.resolve(__dirname, "..");
  for (const name of ["demo-data.js", "assistant-service.js", "cart.js"]) {
    vm.runInContext(fs.readFileSync(path.join(directory, name), "utf8"), context, { filename: name });
  }
  const demo = context.window.EktDemo;
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
  await check("Blank messages are rejected; category, SKU and fallback responses work", async () => {
    await assert.rejects(demo.getReply("   "));
    for (const [query, id] of [["Кабель", "demo-cable"], ["выключатель", "demo-breaker"], ["розетка", "demo-socket"], ["DEMO-KB-325", "demo-cable"]]) {
      const reply = await demo.getReply(query);
      assert.equal(reply.productIds.length, 1);
      assert.equal(reply.productIds[0], id);
      assert.ok(reply.text.length > 0);
    }
    assert.equal((await demo.getReply("все товары")).productIds.length, 3);
    assert.match((await demo.getReply("Привет")).text, /ИИ пока не подключён/);
    assert.equal((await demo.getReply("сертификат")).productIds.length, 0);
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
