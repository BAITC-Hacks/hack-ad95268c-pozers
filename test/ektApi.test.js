const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { getProducts } = require('../src/services/ektApi');

const originalFetch = global.fetch;
const originalUsername = process.env.EKT_USERNAME;
const originalPassword = process.env.EKT_PASSWORD;

afterEach(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries({ EKT_USERNAME: originalUsername, EKT_PASSWORD: originalPassword })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function useTestCredentials() {
  // Искусственные данные только для локальных тестов; запросы в сеть не отправляются.
  process.env.EKT_USERNAME = 'test-user';
  process.env.EKT_PASSWORD = 'test-password';
}

test('missing configuration does not send a request', async () => {
  delete process.env.EKT_USERNAME;
  delete process.env.EKT_PASSWORD;
  global.fetch = () => assert.fail('Unexpected network request');
  await assert.rejects(getProducts(), { status: 503, code: 'EKT_NOT_CONFIGURED' });
});

test('invalid and repeated page values do not send a request', async () => {
  global.fetch = () => assert.fail('Unexpected network request');
  for (const page of ['0', '-1', '1.5', '', 'abc', ['1', '2'], {}]) {
    await assert.rejects(getProducts(page), { status: 400, code: 'INVALID_PAGE' });
  }
});

test('sends Basic Auth and page, and preserves arbitrary JSON', async () => {
  useTestCredentials();
  // Проверка прозрачной передачи JSON, а не предполагаемая схема каталога.
  const payload = { arbitrary: [{ value: 7 }], extra: null };
  for (const page of [undefined, '2']) {
    global.fetch = async (url, options) => {
      assert.equal(String(url), 'https://ekt.kz/api/products' + (page ? '?page=2' : ''));
      assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('test-user:test-password').toString('base64'));
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(payload);
    };
    assert.deepEqual(await getProducts(page), payload);
  }
});

test('upstream HTTP errors expose status without upstream body or secrets', async () => {
  useTestCredentials();
  for (const status of [401, 403, 429, 500]) {
    global.fetch = async () => new Response('sensitive upstream content', { status });
    await assert.rejects(getProducts(), error => {
      assert.equal(error.status, 502);
      assert.equal(error.upstreamStatus, status);
      assert.doesNotMatch(error.message, /sensitive|test-password|Basic/);
      return true;
    });
  }
});

test('invalid JSON, timeouts and connection failures have safe errors', async () => {
  useTestCredentials();
  global.fetch = async () => new Response('<html>not JSON</html>');
  await assert.rejects(getProducts(), { status: 502, code: 'EKT_INVALID_JSON', upstreamStatus: 200 });
  global.fetch = async () => { throw new DOMException('sensitive content', 'TimeoutError'); };
  await assert.rejects(getProducts(), { status: 504, code: 'EKT_TIMEOUT' });
  global.fetch = async () => { throw new TypeError('sensitive content'); };
  await assert.rejects(getProducts(), { status: 502, code: 'EKT_CONNECTION_ERROR' });
});
