/* Local, in-memory basket. Does not modify a basket or reserve stock at ekt.kz. */
(() => {
  "use strict";
  const app = window.EktApp = window.EktApp || {};
  app.createCart = function createCart(products = []) {
    const catalog = new Map();
    const register = products => products.forEach(product => catalog.set(String(product.id), { ...product, id: String(product.id) }));
    register(products);
    const quantities = new Map();
    let pending = null;
    let sequence = 0;
    const fail = error => ({ ok: false, error });
    const available = id => {
      const stock = catalog.get(String(id))?.stock;
      return typeof stock === "number" && Number.isFinite(stock) && stock >= 0 ? Math.max(0, Math.floor(stock) - (quantities.get(String(id)) || 0)) : null;
    };
    const snapshot = () => {
      const items = Array.from(quantities, ([id, quantity]) => ({ product: catalog.get(id), quantity, subtotal: typeof catalog.get(id).price === "number" ? catalog.get(id).price * quantity : null }));
      return { items, totalCount: items.reduce((sum, item) => sum + item.quantity, 0), totalPrice: items.some(item => item.subtotal === null) ? null : items.reduce((sum, item) => sum + item.subtotal, 0) };
    };
    return {
      available, snapshot, register,
      getProduct: id => catalog.get(String(id)),
      prepare(id) {
        id = String(id);
        pending = null;
        const product = catalog.get(id);
        if (!product) return fail("Товар не найден.");
        if (available(id) === null) return fail("Остаток не указан в каталоге. Добавление недоступно.");
        if (available(id) < 1) return fail("Нет доступного остатка с учётом локальной корзины.");
        pending = { token: ++sequence, productId: id, quantity: 1 };
        return { ok: true, token: pending.token, product, quantity: 1, available: available(id) };
      },
      setQuantity(token, value) {
        if (!pending || pending.token !== token) return fail("Это подтверждение больше не активно.");
        const raw = String(value).trim();
        const quantity = Number(raw);
        if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(quantity)) {
          pending.quantity = null;
          return fail("Введите целое количество от 1.");
        }
        if (available(pending.productId) === null || quantity > available(pending.productId)) {
          pending.quantity = null;
          return fail(`Доступно для добавления: ${available(pending.productId)}. Учтены товары в корзине.`);
        }
        pending.quantity = quantity;
        const price = catalog.get(pending.productId).price;
        return { ok: true, quantity, total: typeof price === "number" ? quantity * price : null };
      },
      confirm(token) {
        if (!pending || pending.token !== token) return fail("Это подтверждение уже закрыто.");
        const { productId, quantity } = pending;
        if (!Number.isSafeInteger(quantity) || quantity < 1) return fail("Укажите корректное количество.");
        if (available(productId) === null || quantity > available(productId)) return fail("Количество превышает доступный остаток каталога.");
        // Consume the confirmation before mutation: repeated clicks are harmless.
        pending = null;
        quantities.set(productId, (quantities.get(productId) || 0) + quantity);
        return { ok: true, product: catalog.get(productId), quantity };
      },
      cancel(token) {
        if (pending?.token === token) pending = null;
      },
      remove(id) { quantities.delete(String(id)); },
    };
  };
})();
