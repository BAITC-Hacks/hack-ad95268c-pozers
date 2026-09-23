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
})();
