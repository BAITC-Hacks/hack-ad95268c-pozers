const { randomUUID } = require('node:crypto');

class CartError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    Object.assign(this, { code, status });
  }
}

const proposalLifetime = 30 * 60 * 1000;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const productId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
const fail = (code, message, status) => { throw new CartError(code, message, status); };

function createCartService(getProductById) {
  function snapshot(session) {
    const items = [...session.items.values()].map(item => ({
      product: { ...item.product }, quantity: item.quantity,
      subtotal: item.product.price === null ? null : item.product.price * item.quantity,
    }));
    return {
      items, totalCount: items.reduce((total, item) => total + item.quantity, 0),
      totalPrice: items.some(item => item.subtotal === null) ? null : items.reduce((total, item) => total + item.subtotal, 0),
    };
  }

  function parseItems(body) {
    const items = body?.items ?? [body];
    if (!Array.isArray(items) || !items.length || items.length > 10) fail('INVALID_CART_ITEMS', 'Передайте от 1 до 10 позиций.', 400);
    const grouped = new Map();
    for (const item of items) {
      const id = productId(item?.productId);
      if (!positiveInteger(id) || !positiveInteger(item?.quantity)) fail('INVALID_CART_ITEMS', 'ID и количество должны быть положительными целыми числами.', 400);
      const quantity = (grouped.get(id) || 0) + item.quantity;
      if (!positiveInteger(quantity)) fail('INVALID_CART_ITEMS', 'Слишком большое количество.', 400);
      grouped.set(id, quantity);
    }
    return [...grouped].map(([productId, quantity]) => ({ productId, quantity }));
  }

  async function validate(session, items) {
    const checked = [];
    for (const item of items) {
      const detail = await getProductById(String(item.productId));
      if (!detail || detail.id !== item.productId || typeof detail.name !== 'string') fail('INVALID_CART_PRODUCT', 'Каталог вернул некорректные данные товара.', 502);
      if (typeof detail.quantity !== 'number' || !Number.isFinite(detail.quantity) || detail.quantity < 0) fail('CART_STOCK_UNKNOWN', 'Остаток не указан в каталоге. Добавление недоступно.');
      const total = (session.items.get(item.productId)?.quantity || 0) + item.quantity;
      if (!positiveInteger(item.quantity) || !positiveInteger(total) || total > detail.quantity) fail('CART_STOCK_EXCEEDED', 'Недостаточно остатка с учётом уже добавленного в корзину.');
      const product = { id: detail.id, name: detail.name, quantity: detail.quantity,
        price: typeof detail.price === 'number' && Number.isFinite(detail.price) && detail.price >= 0 ? detail.price : null };
      for (const field of ['article', 'image', 'url']) if (typeof detail[field] === 'string') product[field] = detail[field];
      checked.push({ ...item, product });
    }
    if (new Set([...session.items.keys(), ...items.map(item => item.productId)]).size > 100) fail('CART_LIMIT', 'В корзине допускается не более 100 разных товаров.');
    return checked;
  }

  function getProposal(session, id) {
    const proposal = typeof id === 'string' && session.proposals.get(id);
    if (!proposal || proposal.expiresAt <= Date.now()) fail('CART_PROPOSAL_NOT_FOUND', 'Предложение не найдено или истекло. Подготовьте его заново.', 404);
    return proposal;
  }

  return {
    snapshot,
    async propose(session, body) {
      const items = parseItems(body);
      for (const [id, proposal] of session.proposals) if (proposal.expiresAt <= Date.now()) session.proposals.delete(id);
      if (session.proposals.size >= 100) fail('CART_LIMIT', 'Слишком много предложений. Повторите позже.', 429);
      const checked = await validate(session, items);
      const proposal = { proposalId: randomUUID(), status: 'pending', items: checked, expiresAt: Date.now() + proposalLifetime };
      session.proposals.set(proposal.proposalId, proposal);
      return proposal;
    },
    async confirm(session, id) {
      const proposal = getProposal(session, id);
      if (proposal.status === 'cancelled') fail('CART_PROPOSAL_CANCELLED', 'Предложение отменено.');
      // Terminal proposals stay available for retries; a retry never fetches or adds again.
      if (proposal.status === 'confirmed') return { proposalId: id, status: 'confirmed', cart: snapshot(session) };
      const checked = await validate(session, proposal.items);
      if (checked.some((item, index) => item.product.price !== proposal.items[index].product.price)) fail('CART_PRICE_CHANGED', 'Цена изменилась. Отмените предложение и подготовьте новое.');
      // All details and totals are checked before any write, including multi-item proposals.
      for (const item of checked) session.items.set(item.productId, {
        product: item.product, quantity: (session.items.get(item.productId)?.quantity || 0) + item.quantity,
      });
      proposal.status = 'confirmed';
      return { proposalId: id, status: 'confirmed', cart: snapshot(session) };
    },
    cancel(session, id) {
      const proposal = getProposal(session, id);
      if (proposal.status === 'confirmed') fail('CART_ALREADY_CONFIRMED', 'Предложение уже подтверждено. Корзина сохранена.');
      proposal.status = 'cancelled';
      return { proposalId: id, status: 'cancelled' };
    },
    remove(session, value) {
      const id = productId(value);
      if (!positiveInteger(id)) fail('INVALID_CART_ITEMS', 'Передайте корректный ID товара.', 400);
      session.items.delete(id);
      return snapshot(session);
    },
  };
}

module.exports = { createCartService, CartError };
