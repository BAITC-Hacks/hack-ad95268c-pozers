/* In-memory demo only. This is not a real order or a server inventory check. */
(() => {
  "use strict";
  window.EktDemo.createCart = function createCart(products) {
    const catalog = new Map(products.map(product => [product.id, product]));
    const quantities = new Map();
    let pending = null;
    let sequence = 0;
    const fail = error => ({ ok: false, error });
    const available = id => (catalog.get(id)?.stock || 0) - (quantities.get(id) || 0);
    const snapshot = () => {
      const items = Array.from(quantities, ([id, quantity]) => ({ product: catalog.get(id), quantity, subtotal: catalog.get(id).price * quantity }));
      return { items, totalCount: items.reduce((sum, item) => sum + item.quantity, 0), totalPrice: items.reduce((sum, item) => sum + item.subtotal, 0) };
    };
    return {
      available, snapshot,
      prepare(id) {
        const product = catalog.get(id);
        if (!product) return fail("Товар не найден.");
        if (available(id) < 1) return fail("Весь тестовый остаток уже в корзине.");
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
        if (quantity > available(pending.productId)) {
          pending.quantity = null;
          return fail(`Доступно для добавления: ${available(pending.productId)}. Учтены товары в корзине.`);
        }
        pending.quantity = quantity;
        return { ok: true, quantity, total: quantity * catalog.get(pending.productId).price };
      },
      confirm(token) {
        if (!pending || pending.token !== token) return fail("Это подтверждение уже закрыто.");
        const { productId, quantity } = pending;
        if (!Number.isSafeInteger(quantity) || quantity < 1) return fail("Укажите корректное количество.");
        if (quantity > available(productId)) return fail("Количество превышает доступный тестовый остаток.");
        // Consume the confirmation before mutation: repeated clicks are harmless.
        pending = null;
        quantities.set(productId, (quantities.get(productId) || 0) + quantity);
        return { ok: true, product: catalog.get(productId), quantity };
      },
      cancel(token) {
        if (pending?.token === token) pending = null;
      },
      remove(id) { quantities.delete(id); },
    };
  };
})();
