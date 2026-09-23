// Opt-in live test: backend/frontend must be running; uses real OpenAI credits.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', () => errors.push('Browser JavaScript error'));
    await page.goto(process.env.FRONTEND_URL || 'http://localhost:4173', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.product-card').count(), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /ИИ не подключён|тестовые товары|тестовый ответ/i);
    async function ask(message) {
      await page.locator('#message-input').fill(message);
      const responsePromise = page.waitForResponse(r => r.url() === 'http://localhost:3000/api/chat' && r.request().method() === 'POST', { timeout: 160000 });
      await page.locator('#send-button').click();
      const response = await responsePromise;
      assert.equal(response.request().postDataJSON().message, message);
      const body = await response.json();
      console.log(JSON.stringify({ request: message, httpStatus: response.status(), code: body.error?.code, productIds: body.products?.map(p => p.id) }));
      assert.equal(response.status(), 200, 'Live chat must respond with HTTP 200');
      await page.locator('#connection-status').filter({ hasText: 'Ответ получен от AI' }).waitFor();
      assert.equal(await page.locator('.message-assistant').last().locator('.message-text').innerText(), body.message);
      assert.equal(await page.locator('.message-assistant').last().locator('.product-card').count(), body.products.length);
      return body;
    }
    const answer = await ask('Есть Legrand 40A?');
    assert.ok(answer.products.length > 0, 'Expected real matching products');
    const item = answer.products.find(p => p.quantity >= 1) || answer.products[0];
    assert.ok(Number.isSafeInteger(item.id));
    const button = page.locator(`[data-product-id="${item.id}"]`).last();
    const detailPromise = page.waitForResponse(r => r.url() === `http://localhost:3000/api/products/${item.id}`);
    await button.click();
    const detailResponse = await detailPromise;
    assert.equal(detailResponse.status(), 200);
    const detail = await detailResponse.json();
    assert.ok(detail.quantity >= 1, 'Need an in-stock product for the confirmation flow');
    await page.locator('#confirm-dialog[open]').waitFor();
    const stock = Math.floor(detail.quantity);
    assert.equal(await page.locator('#cart-count').innerText(), '0');
    const quantity = Math.min(2, stock);
    await page.locator('#quantity-input').fill(String(quantity));
    assert.equal(await page.locator('#cart-count').innerText(), '0');
    await page.locator('#cancel-confirmation').click();
    assert.equal(await page.locator('#cart-count').innerText(), '0');
    await button.click();
    await page.locator('#confirm-dialog[open]').waitFor();
    await page.locator('#quantity-input').fill(String(stock + 1));
    assert.equal(await page.locator('#confirm-button').isDisabled(), true);
    assert.equal(await page.locator('#cart-count').innerText(), '0');
    assert.match(await page.locator('#quantity-error').innerText(), /Доступно/);
    await page.locator('#quantity-input').fill(String(quantity));
    await page.locator('#confirm-button').click();
    await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#cart-count').innerText(), String(quantity));
    assert.equal(await page.locator('#cart-items .cart-item h3').innerText(), detail.name);
    await page.locator('.cart-shortcut').click();
    assert.equal(await page.locator('#header-cart-count').innerText(), String(quantity));
    await page.screenshot({ path: path.join(os.tmpdir(), 'ekt-integration-desktop.png'), fullPage: true });
    const unknown = await ask('Расскажи про несуществующий товар XYZ123NOTFOUND');
    assert.equal(unknown.products.length, 0);
    assert.match(unknown.message, /Не удалось найти подходящий товар/);
    assert.equal(await page.locator('#cart-count').innerText(), String(quantity));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow on mobile');
    await page.screenshot({ path: path.join(os.tmpdir(), 'ekt-integration-mobile.png'), fullPage: true });
    assert.equal(errors.length, 0);
    console.log(JSON.stringify({ passed: true, confirmedProductId: item.id, quantity, stock, cartBeforeConfirmation: 0, overStockBlocked: true, unknownProducts: 0, browserErrors: errors.length, screenshots: os.tmpdir() }));
  } finally { await browser.close(); }
})().catch(error => { console.error('Browser smoke failed: ' + error.message); process.exitCode = 1; });
