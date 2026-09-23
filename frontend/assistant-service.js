/* Backend adapter. No demo fallback: API errors stay visible to the user. */
(() => {
  "use strict";
  const app = window.EktApp = window.EktApp || {};
  const base = (window.EKT_API_BASE || "http://localhost:3000").replace(/\/$/, "");
  const safeUrl = value => typeof value === "string" && /^https?:\/\//i.test(value) ? value : null;
  app.adaptProduct = function adaptProduct(product) {
    if (!Number.isSafeInteger(product?.id) || typeof product.name !== "string") throw new Error("Некорректные данные товара от сервера.");
    return {
      id: String(product.id), name: product.name,
      sku: typeof product.article === "string" ? product.article : null,
      stock: typeof product.quantity === "number" && Number.isFinite(product.quantity) && product.quantity >= 0 ? product.quantity : null,
      price: typeof product.price === "number" && Number.isFinite(product.price) && product.price >= 0 ? product.price : null,
      image: safeUrl(product.image), url: safeUrl(product.url),
    };
  };
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(150000) });
    } catch {
      throw new Error("Не удалось связаться с backend. Проверьте запуск сервера и настройки FRONTEND_ORIGIN.");
    }
    let body;
    try { body = await response.json(); } catch { throw new Error("Backend вернул некорректный ответ."); }
    if (!response.ok) {
      // Do not display arbitrary upstream response bodies or stack traces.
      const messages = {
        OPENAI_NOT_CONFIGURED: "На backend не настроен ключ OpenAI.",
        OPENAI_UNAVAILABLE: "OpenAI временно недоступен. Повторите запрос позже.",
        OPENAI_TIMEOUT: "Истекло время ожидания ответа AI. Попробуйте ещё раз.",
        EKT_NOT_CONFIGURED: "На backend не настроен доступ к каталогу ekt.kz.",
        PRODUCT_NOT_FOUND: "Товар не найден в каталоге ekt.kz.",
        AI_TOOL_LIMIT: "Не удалось завершить поиск. Уточните артикул или название товара.",
        INVALID_AUDIT_TEXT: "Вставьте список в формате «артикул или название ; количество».",
        TOO_MANY_AUDIT_LINES: "Можно проверить максимум 10 непустых строк.",
        INVALID_CART_ITEMS: "Укажите товар и целое количество больше нуля.",
        CART_STOCK_UNKNOWN: "Остаток не указан в каталоге. Добавление недоступно.",
        CART_STOCK_EXCEEDED: "Недостаточно остатка с учётом уже добавленного в корзину.",
        CART_PROPOSAL_NOT_FOUND: "Предложение истекло или сессия завершена. Откройте подтверждение заново.",
        CART_PROPOSAL_CANCELLED: "Предложение отменено. Откройте подтверждение заново.",
        CART_ALREADY_CONFIRMED: "Предложение уже подтверждено. Корзина сохранена.",
        CART_PRICE_CHANGED: "Цена изменилась. Отмените предложение и подготовьте его заново.",
        CART_LIMIT: "Достигнут лимит корзины или предложений. Повторите позже.",
      };
      throw new Error(`${messages[body.error?.code] || "Не удалось получить данные от backend. Попробуйте ещё раз."} (HTTP ${response.status})`);
    }
    return body;
  }
  app.getReply = async function getReply(message) {
    if (!message.trim()) throw new Error("Введите сообщение.");
    const body = await request("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
    if (typeof body.message !== "string" || !Array.isArray(body.products)) throw new Error("Некорректный ответ чата от backend.");
    return { text: body.message, products: body.products.map(app.adaptProduct) };
  };
  app.getProduct = async id => app.adaptProduct(await request(`/api/products/${encodeURIComponent(id)}`));
  const cartRequest = (path, body) => request(`/api/cart${path}`, {
    credentials: 'include', ...(body !== undefined && {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  });
  app.getCart = async () => {
    const body = await cartRequest('');
    if (!Array.isArray(body.items)) throw new Error('Некорректный ответ корзины.');
    return { ...body, items: body.items.map(item => ({ ...item, product: app.adaptProduct(item.product) })) };
  };
  app.proposeCart = async items => {
    const body = await cartRequest('/proposals', { items });
    if (typeof body.proposalId !== 'string' || !Array.isArray(body.items)) throw new Error('Некорректное предложение корзины.');
    return { ...body, items: body.items.map(item => ({ ...item, product: app.adaptProduct(item.product) })) };
  };
  app.confirmCart = proposalId => cartRequest('/confirm', { proposalId });
  app.cancelCart = proposalId => cartRequest('/cancel', { proposalId });
  app.removeCartItem = productId => cartRequest('/remove', { productId });
  app.audit = async text => {
    const body = await request('/api/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (body.data_mode !== 'live' || !Array.isArray(body.rows)) throw new Error('Некорректный ответ ревизора.');
    return body;
  };
})();
