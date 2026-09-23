/**
 * ОТДЕЛЬНЫЙ УЧЕБНЫЙ сервер. Не API ekt.kz, не языковая модель, не настоящий заказ.
 * Нужен, чтобы frontend можно было проверить без ключей и backend другого участника.
 * Все цены, товары и правила здесь вымышлены. Данные хранятся только в памяти.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { BUILD, evidence, publicProduct, alternativesFor, auditList } from './lib/revisor.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const SESSION_TTL = 12 * 60 * 60 * 1000;
const PROPOSAL_TTL = 5 * 60 * 1000;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const breaker = curve => ({ current: '16 А', poles: '1', curve, breaking_capacity: '6 кА', voltage: '230 В', dimensions: null });
const initialCatalog = [
  { id: 'demo-001', attributes: breaker('C'), sku: 'DEMO-001', name: 'Автоматический выключатель C16', specs: ['16 А', '1 полюс', '6 кА'], price: 2850, currency: 'KZT', stock: 24, unit: 'шт.', kind: 'breaker', certificate_url: null },
  { id: 'demo-002', attributes: { ...breaker('C'), current: '25 А' }, sku: 'DEMO-002', name: 'Автоматический выключатель C25', specs: ['25 А', '1 полюс', '6 кА'], price: 3200, currency: 'KZT', stock: 18, unit: 'шт.', kind: 'breaker', certificate_url: null },
  { id: 'demo-003', sku: 'DEMO-003', name: 'Кабель ВВГнг 3×2,5', specs: ['3 жилы', '2,5 мм²', 'Медь'], price: 690, currency: 'KZT', stock: 120, unit: 'м', kind: 'cable', certificate_url: null },
  { id: 'demo-004', attributes: breaker('C'), sku: 'DEMO-004', name: 'Автомат C16 · базовый', specs: ['16 А', '1 полюс', '6 кА'], price: 2600, currency: 'KZT', stock: 0, unit: 'шт.', kind: 'breaker', certificate_url: null },
  { id: 'demo-005', sku: 'DEMO-005', name: 'Автоматический выключатель B16', attributes: breaker('B'), specs: ['16 А', '1 полюс', 'B', '6 кА'], price: 2700, currency: 'KZT', stock: 12, unit: 'шт.', kind: 'breaker', certificate_url: null },
  { id: 'demo-006', sku: 'DEMO-006', name: 'Автомат C16 · остаток не подтверждён', attributes: breaker('C'), specs: ['16 А', '1 полюс', '6 кА'], price: 3100, currency: 'KZT', stock: null, unit: 'шт.', kind: 'breaker', certificate_url: null },
];
class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'JSON_REQUIRED', 'Ожидается application/json.');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) fail(413, 'BODY_TOO_LARGE', 'Запрос слишком большой.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'INVALID_JSON', 'Не удалось прочитать JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_JSON', 'Ожидался объект JSON.');
  return value;
}
function cleanSessionCookie(req) {
  const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('ekt_demo_sid='));
  const value = cookie?.slice('ekt_demo_sid='.length);
  return value && /^[a-f0-9-]{36}$/.test(value) ? value : null;
}
function publicProposal(proposal) {
  const { id, status, product_id, sku, name, quantity, unit, unit_price, total, currency, warehouse, expires_at, items, provenance } = proposal;
  return { id, status, product_id, sku, name, quantity, unit, unit_price, total, currency, warehouse, expires_at, items, provenance };
}
function cartSnapshot(session) {
  const items = [...session.cart.values()].map(item => ({ ...item, total: item.quantity * item.unit_price }));
  return { items, total: items.reduce((sum, item) => sum + item.total, 0), currency: 'KZT', revision: session.revision, cart_url: '#cart', provenance: evidence('cart', ['items', 'total', 'revision']) };
}
function proposalItems(proposal) { return proposal.items || [proposal]; }
function prepareProposal(session, data, catalog) {
  const inputs = data.items ?? [{ product_id: data.product_id, quantity: data.quantity }];
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 10) fail(400, 'INVALID_ITEMS', 'Нужно от 1 до 10 позиций.');
  const grouped = new Map();
  for (const item of inputs) {
    if (!item || typeof item.product_id !== 'string' || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 100000) fail(400, 'INVALID_QUANTITY', 'Количество должно быть целым положительным числом до 100000.');
    grouped.set(item.product_id, (grouped.get(item.product_id) || 0) + item.quantity);
  }
  const items = [];
  for (const [id, quantity] of grouped) {
    const product = catalog.get(id);
    if (!product) fail(404, 'PRODUCT_NOT_FOUND', 'Товар не найден.');
    if (product.stock === null) fail(409, 'STOCK_UNKNOWN', 'Остаток не подтверждён.');
    const old = session.cart.get(id); const already = old?.quantity || 0;
    if (already + quantity > product.stock) fail(409, 'INSUFFICIENT_STOCK', `Доступно ${product.stock} ${product.unit}; уже в корзине ${already}. Количество не изменено.`);
    if (old && old.unit_price !== product.price) fail(409, 'PRICE_CHANGED', 'Изменилась цена уже лежащего в корзине товара. Требуется отдельное пересогласование.');
    const total = quantity * product.price;
    if (!Number.isSafeInteger(total) || total < 0) fail(400, 'INVALID_PRICE', 'Цена требует проверки.');
    items.push({ product_id: id, sku: product.sku, name: product.name, kind: product.kind, quantity, unit: product.unit, unit_price: product.price, total });
  }
  if ([...session.proposals.values()].some(p => p.status === 'pending' && Date.parse(p.expires_at) > Date.now())) fail(409, 'ACTIVE_PROPOSAL', 'Сначала подтвердите или отмените текущее предложение.');
  const total = items.reduce((n, item) => n + item.total, 0);
  if (!Number.isSafeInteger(total)) fail(400, 'INVALID_TOTAL', 'Сумма слишком большая.');
  const proposal = { id: randomUUID(), status: 'pending', ...(items.length === 1 ? items[0] : { name: `Список: ${items.length} поз.`, sku: 'СПИСОК' }), items, total, currency: 'KZT', warehouse: 'Учебный склад · не ekt.kz', expires_at: new Date(Date.now() + PROPOSAL_TTL).toISOString(), provenance: evidence('catalog', ['items', 'unit_price', 'total']) };
  session.proposals.set(proposal.id, proposal);
  return { proposal: publicProposal(proposal), data_mode: 'demo' };
}
function confirmProposal(session, id, catalog) {
  const proposal = getProposal(session, id);
  if (proposal.status === 'confirmed') return { status: 'confirmed', proposal_id: id, cart: cartSnapshot(session) };
  if (proposal.status === 'cancelled') fail(409, 'PROPOSAL_CANCELLED', 'Предложение уже отменено.');
  if (Date.parse(proposal.expires_at) <= Date.now()) fail(410, 'PROPOSAL_EXPIRED', 'Срок предложения истёк. Выберите товар заново.');
  const changes = [];
  for (const item of proposalItems(proposal)) {
    const product = catalog.get(item.product_id);
    if (!product) fail(404, 'PRODUCT_NOT_FOUND', 'Товар больше недоступен.');
    if (product.price !== item.unit_price || product.unit !== item.unit) fail(409, 'PRICE_CHANGED', 'Цена или единица изменилась. Нужно новое предложение и подтверждение.');
    const old = session.cart.get(product.id); const current = old?.quantity || 0;
    if (old && old.unit_price !== product.price) fail(409, 'PRICE_CHANGED', 'Нужно пересогласовать цену существующей позиции.');
    if (product.stock === null || current + item.quantity > product.stock) fail(409, 'INSUFFICIENT_STOCK', 'Остаток изменился или не подтверждён. Весь список отклонён; корзина не менялась.');
    changes.push({ ...item, quantity: current + item.quantity });
  }
  // ALL checks precede ALL writes; synchronous in one demo process. Production needs DB transactions.
  for (const item of changes) session.cart.set(item.product_id, item);
  session.revision += 1; proposal.status = 'confirmed';
  return { status: 'confirmed', proposal_id: id, cart: cartSnapshot(session) };
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function getProposal(session, id) {
  if (typeof id !== 'string' || !session.proposals.has(id)) fail(404, 'PROPOSAL_NOT_FOUND', 'Предложение не найдено в этой сессии.');
  return session.proposals.get(id);
}
function verifyRequestId(session, route, data) {
  if (typeof data.request_id !== 'string' || !/^[\w-]{10,100}$/.test(data.request_id)) fail(400, 'REQUEST_ID_REQUIRED', 'Нужен уникальный request_id.');
  const key = `${route}:${data.request_id}`;
  const fingerprint = canonical(data);
  const saved = session.requests.get(key);
  if (saved && saved.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'Этот request_id уже использован для другого запроса.');
  if (!saved && session.requests.size >= 1000) fail(429, 'SESSION_LIMIT', 'Достигнут лимит учебной сессии.');
  return { key, fingerprint, saved };
}
function chatReply(session, data, catalog) {
  if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 2000) fail(400, 'INVALID_MESSAGE', 'Введите запрос длиной до 2000 символов.');
  const query = data.message.toLowerCase().trim();
  const result = { message: '', products: [], result_type: 'message', proposal: null, cart_url: '#cart', data_mode: 'demo', warnings: [], provenance: evidence('catalog', ['products']), comparisons: [] };
  if (query === 'тест ошибка') {
    if (!session.errorTests.has(data.request_id)) {
      session.errorTests.add(data.request_id);
      fail(503, 'DEMO_FAILURE', 'Учебный сбой сервера. Нажмите «Повторить запрос», чтобы проверить восстановление.');
    }
    result.message = 'Соединение восстановлено. Вы проверили обработку ошибки и повтор запроса.';
    return result;
  }
  if (/не добавляй|без подтверждения|игнорируй|ignore|не покупай/.test(query)) {
    result.message = 'Команда не выполнялась. Сообщения и вставленные списки не имеют права изменять корзину. Для покупки подтвердите конкретное предложение.';
    result.provenance = evidence('guard', ['cart_mutation_rule']);
    return result;
  }
  if (/оплат|достав|услов|покупк|парти/.test(query)) {
    result.result_type = 'terms'; result.provenance = evidence('terms', ['payment', 'delivery', 'minimum_quantity']);
    result.message = 'Учебный пример условий: оплата по счёту; получение — самовывоз; минимальное количество — 1 единица товара. Это вымышленные условия для проверки интерфейса, а не правила ekt.kz.';
    result.warnings = ['Для настоящего сервиса backend должен возвращать согласованные условия магазина.'];
    return result;
  }
  const sku = query.match(/\bdemo-\d{3}\b/)?.[0];
  if (sku && !catalog.has(sku)) { result.result_type = 'empty'; result.message = 'Такого артикула нет в учебной выборке.'; return result; }
  if (sku === 'demo-004') {
    result.products = [catalog.get('demo-004'), { ...catalog.get('demo-001'), reason: 'Учебный кандидат на замену: совпадают 16 А, 1 полюс и 6 кА. Это не гарантия совместимости реального оборудования.' }];
    result.comparisons = alternativesFor(catalog.get('demo-004'), catalog).map(a => ({ ...a.comparison, candidate: a.product }));
    result.message = 'У этой учебной позиции нулевой остаток. Рядом — доступный кандидат на замену с объяснением.';
  } else if (sku) {
    result.products = [catalog.get(sku)];
    result.message = 'Нашёл точное совпадение в учебном каталоге. Укажите количество и нажмите «Выбрать» — это ещё не добавление.';
  } else if (/кабел|ввг|3[хx×]/.test(query)) {
    result.products = [catalog.get('demo-003')];
    result.message = 'Вот вариант из учебного каталога. Обратите внимание: количество указано в метрах.';
  } else if (/автомат|выключател|[cс]16|[cс]25/.test(query)) {
    result.products = /[cс]16/.test(query) ? [catalog.get('demo-001')] : /[cс]25/.test(query) ? [catalog.get('demo-002')] : [catalog.get('demo-001'), catalog.get('demo-002')];
    result.message = 'Нашёл варианты в учебном каталоге. Сравните характеристики и укажите нужное количество.';
  } else {
    result.result_type = 'empty';
    result.message = 'По этому запросу нет совпадений в небольшой учебной выборке.';
    return result;
  }
  result.products = result.products.map(publicProduct);
  result.result_type = 'products';
  return result;
}

export function createDemoServer({ delay = 450, enableDiagnostics = true } = {}) {
  let checksRunning = false; let lastCheckAt = 0;
  const sessions = new Map();
  const catalog = new Map(structuredClone(initialCatalog).map(p => [p.id, p]));
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const route = new URL(req.url, 'http://localhost').pathname;
      if (!route.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается.');
        const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/api.js': ['api.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/revisor.js': ['revisor.js', 'text/javascript'], '/evidence.js': ['evidence.js', 'text/javascript'] };
        if (!files[route]) fail(404, 'NOT_FOUND', 'Страница не найдена.');
        const [name, type] = files[route];
        const content = await readFile(path.join(directory, 'public', name));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      }
      // Только именованный same-origin frontend может читать токен и отправлять его назад.
      if (req.headers.origin) {
        const expected = new Set([`http://${req.headers.host}`, `https://${req.headers.host}`]);
        if (process.env.CODESPACE_NAME) expected.add(`https://${process.env.CODESPACE_NAME}-${process.env.PORT || 3000}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}`);
        if (!expected.has(req.headers.origin)) fail(403, 'ORIGIN_REJECTED', 'Запрос с другого сайта запрещён.');
      }
      let session = sessions.get(cleanSessionCookie(req));
      if (session && Date.now() - session.lastSeen > SESSION_TTL) { sessions.delete(session.id); session = null; }
      if (route === '/api/session' && req.method === 'GET') {
        if (!session) {
          for (const [key, old] of sessions) if (Date.now() - old.lastSeen > SESSION_TTL) sessions.delete(key);
          if (sessions.size >= 1000) fail(503, 'DEMO_CAPACITY', 'Учебный сервер достиг лимита сессий.');
          const id = randomUUID();
          session = { id, csrf: randomBytes(24).toString('hex'), cart: new Map(), revision: 0, proposals: new Map(), requests: new Map(), errorTests: new Set(), lastSeen: Date.now() };
          sessions.set(id, session);
          const secure = Boolean(req.socket.encrypted || process.env.CODESPACE_NAME);
          res.setHeader('Set-Cookie', `ekt_demo_sid=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
        }
        session.lastSeen = Date.now();
        const pending = [...session.proposals.values()].find(p => p.status === 'pending' && Date.parse(p.expires_at) > Date.now());
        json(res, 200, { csrf_token: session.csrf, data_mode: 'demo', build: BUILD, diagnostics_enabled: enableDiagnostics, proposal: pending ? publicProposal(pending) : null });
        return;
      }
      if (!session) fail(401, 'SESSION_EXPIRED', 'Сессия истекла. Обновите страницу.');
      session.lastSeen = Date.now();
      if (req.method === 'GET' && route === '/api/cart') {
        await wait(delay);
        json(res, 200, { cart: cartSnapshot(session) });
        return;
      }
      if (req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается.');
      const token = Buffer.from(String(req.headers['x-csrf-token'] || ''));
      const expectedToken = Buffer.from(session.csrf);
      if (token.length !== expectedToken.length || !timingSafeEqual(token, expectedToken)) fail(403, 'CSRF_REJECTED', 'Нет корректного токена сессии.');
      const data = await body(req);
      await wait(delay);
      const operation = verifyRequestId(session, route, data);
      // Подтверждение при повторе вернёт текущую, а не старую корзину.
      if (operation.saved && route !== '/api/cart/confirm') { json(res, 200, operation.saved.result); return; }
      let result;
      if (route === '/api/chat') {
        result = chatReply(session, data, catalog);
      } else if (route === '/api/audit') {
        result = auditList(data.text, catalog, session.cart);
      } else if (route === '/api/demo/checks') {
        if (!enableDiagnostics) fail(404, 'NOT_FOUND', 'Тестовый стенд отключён.');
        if (!['core', 'repeat', 'refusal'].includes(data.suite)) fail(400, 'INVALID_SUITE', 'Неизвестный набор проверок.');
        if (checksRunning || Date.now() - lastCheckAt < 1000) fail(429, 'CHECKS_BUSY', 'Проверка уже идёт. Повторите после её завершения.');
        checksRunning = true; lastCheckAt = Date.now();
        try { const { runChecks } = await import('./checks/run-checks.mjs'); result = await runChecks(data.suite); }
        finally { checksRunning = false; }
      } else if (route === '/api/cart/proposals') {
        result = prepareProposal(session, data, catalog);
      } else if (route === '/api/cart/confirm') {
        result = confirmProposal(session, data.proposal_id, catalog);
      } else if (route === '/api/cart/cancel') {
        const proposal = getProposal(session, data.proposal_id);
        if (proposal.status === 'confirmed') fail(409, 'ALREADY_CONFIRMED', 'Добавление уже выполнено. Откройте корзину.');
        proposal.status = 'cancelled';
        result = { status: 'cancelled', proposal_id: proposal.id };
      } else {
        fail(404, 'NOT_FOUND', 'Маршрут не найден.');
      }
      session.requests.set(operation.key, { fingerprint: operation.fingerprint, result });
      json(res, 200, result);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, error.status || 500, { error: { code: error.code || 'INTERNAL_ERROR', message: error instanceof HttpError || error.code === 'INVALID_LIST' || error.code === 'TOO_MANY_LINES' ? error.message : 'Внутренняя ошибка учебного сервера.' } });
    }
  });
  // Только для локальных автоматических тестов; HTTP-маршрута к этим данным нет.
  server.demoState = { sessions, catalog };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть от 1 до 65535');
  const server = createDemoServer({ enableDiagnostics: process.env.DEMO_DIAGNOSTICS !== 'off', delay: Math.max(0, Math.min(15000, Number(process.env.DEMO_DELAY_MS) || 450)) });
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`EKT frontend: http://localhost:${port}`);
    console.log('УЧЕБНЫЙ РЕЖИМ. Без AI, реального каталога и заказов. Данные только в памяти.');
  });
  server.on('error', error => { console.error(`Не удалось запустить сервер: ${error.message}`); process.exitCode = 1; });
}
