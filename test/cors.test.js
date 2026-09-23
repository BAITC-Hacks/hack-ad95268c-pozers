const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/server');

test('CORS permits only the configured frontend origin, method and headers', async t => {
  const server = createApp({ frontendOrigin: 'http://localhost:4173' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/chat`;
  const headers = { Origin: 'http://localhost:4173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' };
  const allowed = await fetch(url, { method: 'OPTIONS', headers });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), headers.Origin);
  assert.equal(allowed.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal((await fetch(url, { method: 'OPTIONS', headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(url, { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Method': 'DELETE' } })).status, 403);
  assert.equal((await fetch(url, { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Headers': 'authorization' } })).status, 403);
  const invalid = await fetch(url, { method: 'POST', headers: { Origin: headers.Origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('Access-Control-Allow-Origin'), headers.Origin);
});
