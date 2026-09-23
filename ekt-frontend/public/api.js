/**
 * Единственная точка подключения UI к backend.
 * Это ПРЕДЛОЖЕННЫЙ контракт, не проверенная схема ekt.kz. См. API.md.
 * Настоящие ключи магазина и AI должны оставаться на вашем backend.
 */
const API_BASE = '/api';
const TIMEOUT_MS = 12000;
let csrfToken = '';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const requestId = () => crypto.randomUUID();

function assert(condition, message) {
  if (!condition) throw new ApiError(`Непонятный ответ сервера: ${message}`, { code: 'INVALID_RESPONSE' });
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => Number.isFinite(value) && value >= 0;

export function validateCart(cart) {
  assert(object(cart) && Array.isArray(cart.items), 'нет состава корзины');
  assert(Number.isSafeInteger(cart.revision) && cart.revision >= 0, 'нет версии корзины');
  assert(nonnegative(cart.total) && cart.currency === 'KZT', 'нет корректного итога');
  assert(typeof cart.cart_url === 'string' && safeLink(cart.cart_url, true), 'неверная ссылка на корзину');
  for (const item of cart.items) {
    assert(object(item) && typeof item.product_id === 'string' && typeof item.name === 'string', 'неверная позиция');
    assert(Number.isSafeInteger(item.quantity) && item.quantity > 0 && nonnegative(item.unit_price) && nonnegative(item.total), 'неверное количество или цена');
    assert(typeof item.unit === 'string' && typeof item.sku === 'string', 'нет единицы измерения');
    assert(item.total === item.quantity * item.unit_price, 'итог позиции не совпадает с ценой');
  }
  assert(cart.total === cart.items.reduce((sum, item) => sum + item.total, 0), 'итог корзины не совпадает с позициями');
  return cart;
}

function validateProducts(products) {
  assert(Array.isArray(products), 'нет списка товаров');
  for (const p of products) {
    assert(object(p) && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.sku === 'string', 'неверная карточка');
    assert(nonnegative(p.price) && p.currency === 'KZT', 'неверная цена');
    assert((Number.isSafeInteger(p.stock) && p.stock >= 0) || p.stock === null, 'неверный остаток');
    assert(typeof p.unit === 'string' && Array.isArray(p.specs) && p.specs.every(s => typeof s === 'string'), 'неверные характеристики');
    assert(p.certificate_url === null || typeof p.certificate_url === 'string', 'неверный сертификат');
  }
  return products;
}

function validateProposal(proposal) {
  assert(object(proposal) && typeof proposal.id === 'string' && proposal.status === 'pending', 'нет предложения');
  assert(typeof proposal.name === 'string', 'нет названия предложения');
  const items = proposal.items || [proposal];
  assert(Array.isArray(items) && items.length > 0 && items.length <= 10, 'неверный список предложения');
  for (const p of items) {
    assert(object(p) && typeof p.product_id === 'string' && typeof p.name === 'string' && typeof p.sku === 'string', 'неверная позиция предложения');
    assert(Number.isSafeInteger(p.quantity) && p.quantity > 0 && typeof p.unit === 'string', 'неверное количество');
    assert(nonnegative(p.unit_price) && p.total === p.quantity * p.unit_price, 'неверный итог позиции');
  }
  assert(proposal.currency === 'KZT' && proposal.total === items.reduce((n, p) => n + p.total, 0), 'неверный итог списка');
  assert(Number.isFinite(Date.parse(proposal.expires_at)), 'неверный срок подтверждения');
  return proposal;
}

/** Запрещает javascript:, data: и внешние ссылки для корзины. */
export function safeLink(value, sameOrigin = false) {
  try {
    const url = new URL(value, window.location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (sameOrigin && url.origin !== window.location.origin) return null;
    return url.href;
  } catch { return null; }
}

async function request(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        ...(body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new ApiError('Сервер вернул не JSON. Проверьте адрес API.', { status: response.status, code: 'INVALID_RESPONSE' });
    }
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError('Не удалось прочитать ответ сервера.', { status: response.status, code: 'INVALID_RESPONSE' }); }
    if (!response.ok) {
      throw new ApiError(data.error?.message || 'Сервер не выполнил запрос.', { status: response.status, code: data.error?.code || 'SERVER_ERROR', details: data.error?.details });
    }
    assert(object(data), 'ожидался объект');
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') throw new ApiError('Сервер не ответил за 12 секунд.', { code: 'TIMEOUT' });
    throw new ApiError('Нет связи с сервером. Проверьте подключение.', { code: 'NETWORK_ERROR' });
  } finally { clearTimeout(timeout); }
}

export const api = {
  async session() {
    const result = await request('/session');
    assert(typeof result.csrf_token === 'string' && result.csrf_token.length > 10, 'нет токена сессии');
    assert(['demo', 'live'].includes(result.data_mode), 'не указан режим данных');
    if (result.proposal !== null) validateProposal(result.proposal);
    csrfToken = result.csrf_token;
    return result;
  },
  async chat(message, id) {
    const result = await request('/chat', { method: 'POST', body: { message, request_id: id } });
    assert(typeof result.message === 'string' && ['products', 'empty', 'terms', 'message'].includes(result.result_type), 'неверный ответ чата');
    validateProducts(result.products);
    assert(Array.isArray(result.warnings) && result.warnings.every(w => typeof w === 'string'), 'неверные предупреждения');
    if (result.proposal !== null) validateProposal(result.proposal);
    return result;
  },
  async prepare(productId, quantity, id) {
    const result = await request('/cart/proposals', { method: 'POST', body: { product_id: productId, quantity, request_id: id } });
    validateProposal(result.proposal);
    return result;
  },
  async audit(text, id) {
    const result = await request('/audit', { method: 'POST', body: { text, request_id: id } });
    assert(Array.isArray(result.rows) && result.rows.length <= 10, 'неверный отчёт закупки');
    for (const row of result.rows) {
      assert(object(row) && typeof row.id === 'string' && typeof row.raw === 'string' && typeof row.message === 'string', 'неверная строка');
      assert(['ready', 'shortage', 'out_of_stock', 'unknown', 'unparsed', 'not_found', 'unit_mismatch'].includes(row.status), 'неверный статус строки');
      if (row.product) validateProducts([row.product]);
      assert(Array.isArray(row.alternatives), 'неверный список аналогов');
      for (const a of row.alternatives) { validateProducts([a.product]); assert(object(a.comparison) && Array.isArray(a.comparison.parameters), 'нет сравнения'); }
    }
    return result;
  },
  async prepareBatch(items, id) {
    const result = await request('/cart/proposals', { method: 'POST', body: { items, request_id: id } });
    validateProposal(result.proposal); return result;
  },
  async checks(suite, id) {
    const result = await request('/demo/checks', { method: 'POST', body: { suite, request_id: id } });
    assert(result.scope === 'isolated-local-demo' && Array.isArray(result.checks), 'неверная область тестов');
    assert(result.checks.every(c => typeof c.passed === 'boolean' && typeof c.name === 'string' && Array.isArray(c.trace)), 'неверные результаты');
    assert(result.summary?.total === result.checks.length && result.summary.passed === result.checks.filter(c => c.passed).length && result.summary.failed === result.checks.filter(c => !c.passed).length, 'итог не совпадает с тестами');
    return result;
  },
  async confirm(proposalId, id) {
    const result = await request('/cart/confirm', { method: 'POST', body: { proposal_id: proposalId, request_id: id } });
    assert(result.status === 'confirmed' && result.proposal_id === proposalId, 'нет подтверждения операции');
    validateCart(result.cart);
    return result;
  },
  async cancel(proposalId, id) {
    const result = await request('/cart/cancel', { method: 'POST', body: { proposal_id: proposalId, request_id: id } });
    assert(result.status === 'cancelled' && result.proposal_id === proposalId, 'нет подтверждения отмены');
    return result;
  },
  async cart() {
    const result = await request('/cart');
    return validateCart(result.cart);
  }
};
