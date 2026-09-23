/* Cart view model and server adapter. The active UI uses createServerCart only. */
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
    let serverSnapshot = null;
    const fail = error => ({ ok: false, error });
    const available = id => {
      const stock = catalog.get(String(id))?.stock;
      return typeof stock === "number" && Number.isFinite(stock) && stock >= 0 ? Math.max(0, Math.floor(stock) - (quantities.get(String(id)) || 0)) : null;
    };
    const snapshot = () => {
      if (serverSnapshot) return serverSnapshot;
      const items = Array.from(quantities, ([id, quantity]) => ({ product: catalog.get(id), quantity, subtotal: typeof catalog.get(id).price === "number" ? catalog.get(id).price * quantity : null }));
      return { items, totalCount: items.reduce((sum, item) => sum + item.quantity, 0), totalPrice: items.some(item => item.subtotal === null) ? null : items.reduce((sum, item) => sum + item.subtotal, 0) };
    };
    return {
      available, snapshot, register,
      hydrate(snapshot) {
        serverSnapshot = snapshot;
        quantities.clear();
        snapshot.items.forEach(item => {
          register([item.product]);
          quantities.set(String(item.product.id), item.quantity);
        });
      },
      getProduct: id => catalog.get(String(id)),
      prepare(id) {
        id = String(id);
        pending = null;
        const product = catalog.get(id);
        if (!product) return fail("Товар не найден.");
        if (available(id) === null) return fail("Остаток не указан в каталоге. Добавление недоступно.");
        if (available(id) < 1) return fail("Нет доступного остатка с учётом корзины.");
        pending = { token: ++sequence, productId: id, quantity: 1 };
        return { ok: true, token: pending.token, product, quantity: 1, available: available(id) };
      },
      prepareBatch(items) {
        pending = null;
        if (!Array.isArray(items) || !items.length || items.length > 10) return fail("Выберите от 1 до 10 позиций.");
        const grouped = new Map();
        for (const item of items) {
          if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) return fail("Количество должно быть целым положительным числом.");
          const id = String(item.productId);
          grouped.set(id, (grouped.get(id) || 0) + item.quantity);
        }
        const batch = [];
        for (const [productId, quantity] of grouped) {
          if (!catalog.has(productId) || !Number.isSafeInteger(quantity)) return fail("Не удалось подготовить позиции.");
          if (available(productId) === null || quantity > available(productId)) return fail(`Недостаточно остатка для ${catalog.get(productId).name}. Учтены товары в корзине.`);
          batch.push({ productId, quantity });
        }
        pending = { token: ++sequence, items: batch };
        return { ok: true, token: pending.token, items: batch.map(item => ({ ...item, product: catalog.get(item.productId) })) };
      },
      setQuantity(token, value) {
        if (!pending || pending.token !== token) return fail("Это подтверждение больше не активно.");
        if (pending.items) return fail("Измените количества в списке и подготовьте предложение заново.");
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
        if (pending.items) {
          const items = pending.items;
          // Проверить весь пакет до первой записи: частичное добавление исключено.
          for (const item of items) {
            if (available(item.productId) === null || item.quantity > available(item.productId)) return fail("Остаток изменился. Перепроверьте список; ничего не добавлено.");
          }
          pending = null;
          for (const item of items) quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
          return { ok: true, items };
        }
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

  // Local preparation only edits the dialog. All active cart writes go through HTTP.
  app.createServerCart = function createServerCart(api = app) {
    const view = app.createCart();
    let pending = null;
    let busy = false;
    let refreshRequest = null;
    const fail = error => ({ ok: false, error });
    async function refresh(force = false) {
      // A read started before a mutation must not replace its required post-mutation GET.
      if (force && refreshRequest) { try { await refreshRequest; } catch { /* Retry below. */ } }
      // Coalesce startup/open requests so a new browser receives just one session cookie.
      if (!refreshRequest) refreshRequest = api.getCart().then(snapshot => {
        view.hydrate(snapshot);
        return snapshot;
      }).finally(() => { refreshRequest = null; });
      return refreshRequest;
    }
    async function prepare(items, single) {
      await refresh();
      const proposal = await api.proposeCart(items);
      view.register(proposal.items.map(item => item.product));
      const preview = single ? view.prepare(items[0].productId) : view.prepareBatch(items);
      if (!preview.ok) { await api.cancelCart(proposal.proposalId); return preview; }
      pending = { ...proposal, token: preview.token, single, quantity: single ? 1 : null, submitted: false };
      return preview;
    }
    return {
      snapshot: view.snapshot, register: view.register, available: view.available, getProduct: view.getProduct, refresh,
      prepare: id => prepare([{ productId: id, quantity: 1 }], true),
      prepareBatch: items => prepare(items, false),
      setQuantity(token, value) {
        if (!pending || pending.token !== token || busy) return fail('Подтверждение недоступно.');
        if (pending.submitted && Number(value) !== pending.quantity) return fail('Сначала повторите подтверждение прежнего количества: результат запроса ещё не получен.');
        const result = view.setQuantity(token, value);
        if (result.ok) pending.quantity = result.quantity;
        else if (!pending.submitted) pending.quantity = null;
        return result;
      },
      async confirm(token) {
        if (!pending || pending.token !== token || busy) return fail('Подтверждение уже закрыто или выполняется.');
        if (pending.single && !Number.isSafeInteger(pending.quantity)) return fail('Укажите корректное количество.');
        busy = true;
        try {
          if (pending.priceChanged) return fail('Цена изменилась. Закройте и откройте подтверждение заново.');
          if (pending.single && pending.quantity !== pending.items[0].quantity) {
            const previousPrice = pending.items[0].product.price;
            await api.cancelCart(pending.proposalId);
            const replacement = await api.proposeCart([{ productId: pending.items[0].productId, quantity: pending.quantity }]);
            Object.assign(pending, replacement);
            if (replacement.items[0].product.price !== previousPrice) {
              pending.priceChanged = true;
              return fail('Цена изменилась. Закройте и откройте подтверждение заново.');
            }
          }
          // Keep this ID after an uncertain network outcome. Retry the same proposal, never create a duplicate.
          pending.submitted = true;
          await api.confirmCart(pending.proposalId);
          await refresh(true);
          const result = { ok: true, quantity: pending.quantity, items: pending.items };
          view.cancel(token);
          pending = null;
          return result;
        } catch (error) { return fail(error.message); }
        finally { busy = false; }
      },
      async cancel(token) {
        if (busy) return fail('Дождитесь результата подтверждения.');
        if (!pending || pending.token !== token) return { ok: true };
        const proposal = pending;
        pending = null;
        view.cancel(token);
        try { await api.cancelCart(proposal.proposalId); return { ok: true }; }
        catch (error) { return fail(error.message); }
        finally { try { await refresh(true); } catch { /* Keep the last server snapshot; never fabricate a successful mutation. */ } }
      },
      async remove(id) { await api.removeCartItem(id); await refresh(true); },
    };
  };
})();
