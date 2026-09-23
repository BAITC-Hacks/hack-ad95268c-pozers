const ektApi = require('./ektApi');

const NOT_FOUND = 'Информация не найдена в каталоге';
const normalize = value => String(value).normalize('NFKC').toLocaleLowerCase('ru').trim();

function intentOf(message) {
  if (/добав|полож|в корзину/i.test(message)) return 'add_to_cart';
  if (/аналог|замен/i.test(message)) return 'alternatives';
  if (/цен|стоим|сколько стоит/i.test(message)) return 'price';
  if (/налич|остат|есть ли/i.test(message)) return 'availability';
  if (/характерист|параметр|сертификат/i.test(message)) return 'specifications';
  return 'search';
}

function queryOf(message) {
  const quoted = message.match(/[«"]([^»"]+)[»"]/);
  if (quoted) return normalize(quoted[1]);
  return normalize(message)
    .replace(/[\d.,-]+\s*(?:штук[аи]?|шт\.?)(?=\s|$)/giu, ' ')
    .replace(/(?:пожалуйста|сколько стоит|есть ли|в наличии|в корзину|по артикулу|артикул|характеристики|характеристика|сертификаты|сертификат|параметры|стоимость|наличие|остатки|добавь|добавить|положи|покажи|найди|найти|аналоги|аналог|замена|товара|товар|цена|цену)/giu, ' ')
    .replace(/^[\s:?,]+|[\s:?,]+$/g, '').replace(/\s+/g, ' ');
}

function createChatService(api = ektApi) {
  // Кэш страниц ограничен; неполный просмотр не выдаём за полный каталог.
  const cache = new Map();
  async function pageAt(page) {
    const cached = cache.get(page);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = await api.getProducts(String(page));
    if (!value || !Array.isArray(value.items)) {
      throw new ektApi.EktApiError('Неожиданная структура каталога.', 502, 'EKT_INVALID_CATALOG');
    }
    cache.set(page, { value, until: Date.now() + 60000 });
    return value;
  }

  async function search(query) {
    const matches = new Map();
    const started = Date.now();
    for (let page = 1; page <= 20; page++) {
      const data = await pageAt(page);
      const exact = data.items.find(p => typeof p.article === 'string' && normalize(p.article) === query);
      if (exact) return { products: [exact], complete: true };
      for (const p of data.items) {
        if (typeof p.name === 'string' && normalize(p.name).includes(query)) matches.set(p.id, p);
      }
      if (!data.items.length || (Number.isInteger(data.per_page) && data.per_page > data.items.length)) {
        return { products: [...matches.values()].slice(0, 10), complete: true };
      }
      if (Date.now() - started >= 15000) break;
    }
    return { products: [...matches.values()].slice(0, 10), complete: false };
  }

  return async function chat(message, session) {
    const intent = intentOf(message);
    const result = (reply, extra = {}) => ({ intent, reply, products: [], pendingAction: null, ...extra });
    if (/^(да|подтверждаю|подтвердить|нет|отмена)[.!\s]*$/i.test(message)) {
      session.pendingAction = null;
      return result('Корзина не изменена. Выполнение действий с корзиной пока не подключено.');
    }
    const query = queryOf(message);
    let products;
    let complete = true;
    if (!query) products = session.product ? [session.product] : [];
    else ({ products, complete } = await search(query));
    session.pendingAction = null;
    if (!products.length) {
      if (query) session.product = null;
      return result(!query && intent === 'add_to_cart' ? 'Укажите название или артикул товара для добавления.' : NOT_FOUND,
        { searchComplete: complete, ...(!complete && { note: 'Проверена только часть каталога. Уточните артикул; отсутствие товара во всём каталоге не подтверждено.' }) });
    }
    const extra = { products, searchComplete: complete, ...(!complete && { note: 'Проверена только часть каталога; результаты могут быть неполными.' }) };
    if (products.length !== 1) {
      session.product = null;
      return result('Найдено несколько товаров. Уточните артикул нужного товара.', extra);
    }
    const product = products[0];
    session.product = product;
    if (intent === 'add_to_cart') {
      const quantityMatch = message.match(/(?:добавь|добавить|положи)\s+([\d.,-]+)(?=\s|$)|([\d.,-]+)\s*(?:шт|штук)/i);
      const quantity = quantityMatch ? Number(quantityMatch[1] ?? quantityMatch[2]) : 1;
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) return result('Укажите целое количество от 1 до 10000.', extra);
      session.pendingAction = { action: 'confirm_add_to_cart', productId: product.id, quantity };
      return result(`Добавить ${quantity} шт. товара ${product.name} в корзину?`, { ...extra, pendingAction: session.pendingAction });
    }
    if (intent === 'price') {
      return result(typeof product.price === 'number' && Number.isFinite(product.price)
        ? `Цена товара ${product.name}: ${product.price} (значение из каталога).` : NOT_FOUND, extra);
    }
    if (['availability', 'specifications', 'alternatives'].includes(intent)) {
      if (intent === 'alternatives' || /сертификат/i.test(message)) return result(NOT_FOUND, extra);
      const detail = product.url_api_detail ? await api.getProductDetail(product.url_api_detail) : null;
      if (!detail || detail.id !== product.id) return result(NOT_FOUND, extra);
      if (intent === 'availability' && typeof detail.quantity === 'number' && Number.isFinite(detail.quantity)) {
        return result(`Количество в каталоге для ${product.name}: ${detail.quantity}.`, {
          ...extra, data: { quantity: detail.quantity, ...(Array.isArray(detail.stores) && { stores: detail.stores }) },
        });
      }
      if (intent === 'specifications') {
        const data = {};
        if (typeof detail.description === 'string' && detail.description.trim()) data.description = detail.description;
        if (detail.properties && typeof detail.properties === 'object' && !Array.isArray(detail.properties) && Object.keys(detail.properties).length) data.properties = detail.properties;
        if (Object.keys(data).length) return result(`Данные каталога для ${product.name} находятся в поле data.`, { ...extra, data });
      }
      return result(NOT_FOUND, extra);
    }
    return result(`Найден товар: ${product.name}.`, extra);
  };
}

module.exports = { createChatService, intentOf };
