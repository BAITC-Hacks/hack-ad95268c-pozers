/* Presentation state only. Confirmed quantities always come from the shared server cart. */
(() => {
  'use strict';
  window.EktApp.createStorefront = function ({ cart, productCard, isBusy, notify }) {
    const $ = id => document.getElementById(id);
    const loadedIds = new Set();
    const selections = new Map();
    const lastConfirmed = new Map();
    const panels = { chat: $('assistant-drawer'), cart: $('cart-drawer') };
    const panelOpeners = new Map();
    const confirmed = id => cart.snapshot().items.find(item => String(item.product.id) === String(id))?.quantity || 0;
    const desired = id => selections.get(id) ?? String(confirmed(id) || 1);

    function intent(id) {
      const raw = desired(id);
      const quantity = Number(raw);
      const current = confirmed(id);
      const product = cart.getProduct(id);
      if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(quantity)) return { ok: false, error: 'Введите целое неотрицательное количество.' };
      if (quantity === current) return { ok: false, error: current ? 'Это количество уже в корзине.' : 'Выберите количество больше нуля.' };
      if (quantity > 0 && quantity < current) return { ok: false, error: 'Частичное уменьшение пока не поддерживается сервером. Для полного удаления выберите 0.' };
      if (typeof product?.stock === 'number' && quantity > product.stock) return { ok: false, error: `Итог не должен превышать остаток: ${product.stock}.` };
      return { ok: true, quantity, current };
    }
    function renderCatalogue() {
      const query = $('catalog-search').value.trim().toLocaleLowerCase('ru');
      const filter = $('stock-filter').value;
      const products = [...loadedIds].map(id => cart.getProduct(id)).filter(Boolean);
      const visible = products.filter(product => {
        const matches = `${product.name} ${product.sku || ''}`.toLocaleLowerCase('ru').includes(query);
        return matches && (filter === 'all' || (filter === 'available' && product.stock > 0) || (filter === 'unknown' && product.stock === null));
      });
      $('catalog-results').textContent = `${visible.length} из ${products.length} позиций`;
      $('catalog-grid').replaceChildren(...visible.map(productCard));
      $('catalog-empty').hidden = visible.length > 0;
      $('catalog-empty-title').textContent = products.length ? 'По вашему запросу ничего не найдено' : 'Начните с нужного товара';
      $('catalog-empty-text').textContent = products.length ? 'Измените название, артикул или фильтр наличия.' : 'Укажите название или артикул помощнику. Найденные товары и позиции вашей корзины появятся здесь.';
      $('reset-filters').hidden = !products.length;
      $('clear-search').disabled = !$('catalog-search').value;
      updateControls();
    }
    function remember(products) {
      let added = false;
      for (const product of products) {
        if (!loadedIds.has(String(product.id))) added = true;
        loadedIds.add(String(product.id));
      }
      if (added) renderCatalogue();
    }
    function updateControls() {
      const busy = isBusy();
      document.querySelectorAll('[data-cart-quantity]').forEach(node => {
        const id = node.dataset.cartQuantity;
        const unit = cart.getProduct(id)?.unit;
        node.textContent = `В корзине: ${confirmed(id)}${unit ? ` ${unit}` : ''}`;
      });
      document.querySelectorAll('[data-quantity-choice]').forEach(control => {
        const id = control.dataset.quantityChoice;
        const input = control.querySelector('input');
        if (document.activeElement !== input) input.value = desired(id);
        input.disabled = busy;
        const result = intent(id);
        input.setAttribute('aria-invalid', String(!result.ok && Number(desired(id)) !== confirmed(id)));
        const buttons = control.querySelectorAll('button');
        buttons[0].disabled = busy || Number(desired(id)) <= 0;
        buttons[1].disabled = busy || (typeof cart.getProduct(id)?.stock === 'number' && Number(desired(id)) >= cart.getProduct(id).stock);
        control.closest('.product-selection').querySelector('.selection-hint').textContent = result.ok
          ? (result.quantity === 0 ? 'Удаление — только после подтверждения.' : `Добавим ${result.quantity - result.current}. Итог в корзине: ${result.quantity}.`)
          : result.error;
      });
      document.querySelectorAll('[data-product-id]').forEach(button => {
        const result = intent(button.dataset.productId);
        button.disabled = busy || !result.ok;
        button.textContent = busy ? 'Дождитесь операции…' : result.ok && result.quantity === 0 ? 'Подтвердить удаление' : confirmed(button.dataset.productId) ? 'Применить количество' : 'Добавить в корзину';
      });
    }
    function quantityControls(product) {
      const wrapper = document.createElement('div'); wrapper.className = 'product-selection';
      const status = document.createElement('p'); status.className = 'in-cart-status'; status.dataset.cartQuantity = product.id;
      const label = document.createElement('label'); label.className = 'selection-label';
      label.append(document.createTextNode('Нужное количество в корзине'));
      const controls = document.createElement('span'); controls.className = 'quantity-control'; controls.dataset.quantityChoice = product.id;
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.step = '1'; input.inputMode = 'numeric'; input.value = desired(product.id);
      input.setAttribute('aria-label', `Количество в корзине: ${product.name}`);
      input.addEventListener('input', () => { selections.set(product.id, input.value); updateControls(); });
      const makeStep = delta => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = delta < 0 ? '−' : '+';
        button.setAttribute('aria-label', `${delta < 0 ? 'Уменьшить' : 'Увеличить'} количество: ${product.name}`);
        button.addEventListener('click', () => {
          const value = Number(desired(product.id));
          const next = Math.max(0, (Number.isSafeInteger(value) ? value : 0) + delta);
          selections.set(product.id, String(next)); updateControls();
        });
        return button;
      };
      controls.append(makeStep(-1), input, makeStep(1)); label.append(controls);
      const hint = document.createElement('p'); hint.className = 'selection-hint'; hint.setAttribute('aria-live', 'polite');
      wrapper.append(status, label, hint);
      return wrapper;
    }
    function sync() {
      for (const id of loadedIds) {
        const current = confirmed(id);
        if (lastConfirmed.has(id) && lastConfirmed.get(id) !== current) selections.delete(id);
        lastConfirmed.set(id, current);
      }
      remember(cart.snapshot().items.map(item => item.product));
      updateControls();
    }
    function openPanel(name, source = document.activeElement) {
      const panel = panels[name];
      if (panel.open) return;
      Object.values(panels).forEach(other => { if (other.open) other.close(); });
      panelOpeners.set(panel, source); panel.showModal();
    }
    function closePanel(name) { panels[name].close(); }
    Object.entries(panels).forEach(([name, panel]) => {
      panel.addEventListener('close', () => {
        if (Object.values(panels).some(other => other.open)) return;
        const source = panelOpeners.get(panel);
        if (source?.isConnected && !source.disabled) source.focus({ preventScroll: true });
        else $('catalog-heading').focus({ preventScroll: true });
      });
      document.querySelectorAll(`[data-close-panel="${name}"]`).forEach(button => button.addEventListener('click', () => closePanel(name)));
    });
    document.querySelectorAll('[data-open-panel]').forEach(button => button.addEventListener('click', () => openPanel(button.dataset.openPanel, button)));
    $('catalog-search').addEventListener('input', renderCatalogue);
    $('catalog-search-form').addEventListener('submit', event => { event.preventDefault(); location.hash = '#catalog-section'; $('audit-panel').hidden = true; $('catalog-section').hidden = false; $('catalog-heading').scrollIntoView({ block: 'start' }); });
    $('stock-filter').addEventListener('change', renderCatalogue);
    $('clear-search').addEventListener('click', () => { $('catalog-search').value = ''; renderCatalogue(); $('catalog-search').focus(); });
    $('reset-filters').addEventListener('click', () => { $('catalog-search').value = ''; $('stock-filter').value = 'all'; renderCatalogue(); });
    document.querySelectorAll('[data-catalog-link]').forEach(link => link.addEventListener('click', () => {
      Object.values(panels).forEach(panel => { if (panel.open) panel.close(); });
      $('audit-panel').hidden = true; $('catalog-section').hidden = false;
    }));
    function prefill(prompt, source) {
      openPanel('chat', source);
      const input = $('message-input');
      const value = input.value.trim() ? `${input.value}\n${prompt}` : prompt;
      if (value.length > input.maxLength) return notify('Черновик сохранён. Отправьте или сократите его перед новым запросом.');
      input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    }
    renderCatalogue();
    return { remember, sync, intent, quantityControls, updateControls, openPanel, closePanel, prefill };
  };
})();
