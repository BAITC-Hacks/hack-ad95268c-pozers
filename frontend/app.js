(() => {
  "use strict";
  const service = window.EktApp;
  const cart = service.createServerCart();
  const byId = id => document.getElementById(id);
  const conversation = byId("conversation");
  const input = byId("message-input");
  const dialog = byId("confirm-dialog");
  const quantityInput = byId("quantity-input");
  const money = value => typeof value === "number" ? new Intl.NumberFormat("ru-RU").format(value) : "Цена не указана";
  let sending = false;
  let confirmation = null;
  let confirmationBusy = false;
  let opener = null;
  let notificationTimer;
  let revisor;
  const batchDialog = byId('batch-dialog');
  let batchPreparation = null;
  let batchPreparing = false;
  let batchConfirming = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(name, className = "icon") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${name}`);
    svg.append(use);
    return svg;
  }
  function notify(text) {
    clearTimeout(notificationTimer);
    byId("notification").textContent = text;
    byId("notification").classList.add("visible");
    notificationTimer = setTimeout(() => byId("notification").classList.remove("visible"), 4500);
  }
  function productCard(product) {
    const card = element("article", "product-card");
    card.setAttribute("aria-label", product.name);
    const visual = element("div", "product-visual");
    if (product.image) {
      const image = element("img", "product-image");
      image.src = product.image;
      image.alt = product.name;
      image.loading = "lazy";
      image.addEventListener("error", () => visual.replaceChildren(element("span", "muted", "Фото недоступно")), { once: true });
      visual.append(image);
    } else visual.append(element("span", "muted", "Фото не указано"));
    const info = element("div", "product-info");
    info.append(element("p", "product-sku", product.sku ? `Арт. ${product.sku}` : "Артикул не указан"), element("h3", "", product.name));
    const price = element("div", "product-price", money(product.price));
    price.append(element("span", "price-unit", " · цена по каталогу"));
    const stock = element("p", "stock");
    stock.dataset.stockId = product.id;
    const button = element("button", "add-button", "+ Добавить в корзину");
    button.type = "button";
    button.dataset.productId = product.id;
    button.setAttribute("aria-label", `Добавить в корзину: ${product.name}`);
    button.addEventListener("click", () => openConfirmation(product.id, button));
    info.append(price, stock, button);
    if (product.url) {
      const link = element("a", "certificate-link", "Открыть товар на ekt.kz");
      link.href = product.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.prepend(icon("icon-file"));
      info.append(link);
    }
    card.append(visual, info);
    return card;
  }
  function appendMessage(role, text, products = [], scroll = true) {
    cart.register(products);
    const message = element("div", `message message-${role}`);
    const meta = element("div", "message-meta");
    meta.append(element("strong", "", role === "user" ? "Вы" : "EKT-помощник"));
    message.append(meta, element("p", "message-text", text));
    if (products.length) {
      const heading = element("div", "catalog-heading");
      heading.append(element("strong", "", "Товары ekt.kz"), element("span", "", `${products.length} товаров`));
      const grid = element("div", "product-grid");
      products.forEach(product => grid.append(productCard(product)));
      message.append(heading, grid, element("p", "catalog-note", "Данные каталога ekt.kz. Перед выбором количества проверим текущий остаток."));
    }
    conversation.append(message);
    renderCart();
    refreshProductAvailability();
    if (scroll) message.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function refreshProductAvailability() {
    document.querySelectorAll("[data-product-id]").forEach(button => {
      const available = cart.available(button.dataset.productId);
      button.disabled = false;
      button.textContent = available === 0 ? "Проверить остаток" : "+ Добавить в корзину";
    });
    document.querySelectorAll("[data-stock-id]").forEach(node => {
      const product = cart.getProduct(node.dataset.stockId);
      const available = cart.available(product.id);
      node.textContent = product.stock === null ? "Остаток не указан — проверим перед добавлением" : `Остаток: ${product.stock}${available < product.stock ? ` · С учётом корзины: ${available}` : ""}`;
    });
  }
  function renderCart() {
    const snapshot = cart.snapshot();
    byId("cart-count").textContent = snapshot.totalCount;
    byId("header-cart-count").textContent = snapshot.totalCount;
    byId("cart-total").textContent = money(snapshot.totalPrice);
    const container = byId("cart-items");
    container.replaceChildren();
    if (!snapshot.items.length) {
      const empty = element("div", "cart-empty");
      const illustration = element("div", "empty-illustration");
      illustration.append(icon("icon-bag"));
      empty.append(illustration, element("strong", "", "Здесь пока пусто"), element("p", "", "Выберите товар в чате.\nПосле подтверждения он появится здесь."));
      container.append(empty);
    }
    snapshot.items.forEach(({ product, quantity, subtotal }) => {
      const item = element("article", "cart-item");
      item.append(element("h3", "", product.name), element("div", "muted", product.sku || "Артикул не указан"));
      const bottom = element("div", "cart-item-bottom");
      bottom.append(element("span", "", `${quantity} × ${money(product.price)}`), element("strong", "", money(subtotal)));
      const remove = element("button", "remove-item", "Удалить");
      remove.type = "button";
      remove.setAttribute("aria-label", `Удалить из корзины: ${product.name}`);
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await cart.remove(product.id);
          revisor?.invalidateAudit();
          renderCart();
          byId("cart-panel").focus({ preventScroll: true });
          notify("Товар удалён из серверной корзины.");
        } catch (error) { notify(error.message); remove.disabled = false; }
      });
      item.append(bottom, remove);
      container.append(item);
    });
    refreshProductAvailability();
  }
  function updateQuantity() {
    if (!confirmation || confirmationBusy) return;
    const result = cart.setQuantity(confirmation.token, quantityInput.value);
    byId("quantity-error").textContent = result.ok ? "" : result.error;
    quantityInput.setAttribute("aria-invalid", String(!result.ok));
    byId("confirm-button").disabled = !result.ok;
    byId("confirm-total").textContent = result.ok ? money(result.total) : "—";
    byId("decrease-quantity").disabled = result.ok && result.quantity <= 1;
    byId("increase-quantity").disabled = result.ok && result.quantity >= cart.available(confirmation.product.id);
  }
  let preparing = false;
  async function openConfirmation(id, source) {
    if (dialog.open || preparing || batchDialog.open || batchPreparing) return;
    preparing = true;
    source.disabled = true;
    source.textContent = "Проверяем остаток…";
    try {
      const result = await cart.prepare(id);
      renderCart();
      if (!result.ok) return notify(result.error);
      confirmation = result;
      opener = source;
      byId("confirm-product-name").textContent = result.product.name;
      byId("confirm-product-sku").textContent = result.product.sku ? `Арт. ${result.product.sku}` : "Артикул не указан";
      byId("confirm-unit-price").textContent = money(result.product.price);
      byId("available-stock").textContent = `Доступно: ${result.available}`;
      quantityInput.value = "1";
      quantityInput.max = result.available;
      updateQuantity();
      dialog.showModal();
      quantityInput.focus();
      quantityInput.select();
    } catch (error) { notify(error.message); }
    finally { preparing = false; refreshProductAvailability(); }
  }
  function lockConfirmation(locked) {
    confirmationBusy = locked;
    for (const id of ['quantity-input', 'confirm-button', 'cancel-confirmation', 'close-dialog', 'decrease-quantity', 'increase-quantity']) byId(id).disabled = locked;
  }
  async function closeConfirmation() {
    if (confirmationBusy) return;
    lockConfirmation(true);
    if (confirmation) {
      const result = await cart.cancel(confirmation.token);
      if (!result.ok) notify(result.error);
    }
    confirmation = null;
    dialog.close();
    lockConfirmation(false);
    renderCart();
    if (opener && !opener.disabled) opener.focus({ preventScroll: true });
    else byId("cart-panel").focus({ preventScroll: true });
  }
  byId("confirm-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!confirmation || confirmationBusy) return;
    updateQuantity();
    if (byId("confirm-button").disabled) return;
    lockConfirmation(true);
    byId('quantity-error').textContent = 'Перепроверяем остаток на сервере…';
    const result = await cart.confirm(confirmation.token);
    lockConfirmation(false);
    if (!result.ok) {
      updateQuantity();
      byId("quantity-error").textContent = result.error;
      return;
    }
    renderCart();
    revisor?.invalidateAudit();
    await closeConfirmation();
    notify(`Добавлено в серверную корзину: ${result.quantity}`);
  });
  quantityInput.addEventListener("input", updateQuantity);
  ["decrease-quantity", "increase-quantity"].forEach((id, index) => byId(id).addEventListener("click", () => {
    if (!confirmation || confirmationBusy) return;
    const value = Number(quantityInput.value);
    const base = Number.isSafeInteger(value) ? value : 1;
    quantityInput.value = Math.max(1, Math.min(cart.available(confirmation.product.id), base + (index ? 1 : -1)));
    updateQuantity();
  }));
  byId("cancel-confirmation").addEventListener("click", closeConfirmation);
  byId("close-dialog").addEventListener("click", closeConfirmation);
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeConfirmation(); });

  function updateSendButton() {
    byId("send-button").disabled = sending || !input.value.trim();
    revisor?.update();
  }
  async function sendMessage() {
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    byId("connection-status").textContent = "Ищем в каталоге…";
    input.value = "";
    input.style.height = "42px";
    updateSendButton();
    appendMessage("user", text);
    input.focus({ preventScroll: true });
    try {
      const reply = await service.getReply(text);
      appendMessage("assistant", reply.text, reply.products);
      byId("connection-status").textContent = "Ответ получен от AI";
    } catch (error) {
      appendMessage("assistant", error.message);
      byId("connection-status").textContent = "Ошибка запроса";
    } finally {
      sending = false;
      updateSendButton();
    }
  }
  byId("message-form").addEventListener("submit", event => { event.preventDefault(); sendMessage(); });
  input.addEventListener("input", () => {
    updateSendButton();
    input.style.height = "42px";
    input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  document.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => {
    if (sending) return;
    input.value = button.dataset.prompt;
    sendMessage();
  }));
  async function prepareBatch(items, source) {
    if (batchPreparing || batchDialog.open || dialog.open || preparing) return;
    batchPreparing = true;
    try {
      const proposal = await cart.prepareBatch(items);
      renderCart();
      if (!proposal.ok) throw new Error(proposal.error);
      batchPreparation = proposal;
      opener = source;
      const list = byId('batch-items'); list.replaceChildren();
      let total = 0;
      for (const item of proposal.items) {
        const row = element('article', 'batch-item');
        row.append(element('strong', '', item.product.name), element('p', 'muted', `${item.product.sku || 'Артикул не указан'} · Количество: ${item.quantity} · Цена: ${money(item.product.price)}`));
        list.append(row);
        total = total === null || item.product.price === null ? null : total + item.quantity * item.product.price;
      }
      byId('batch-total').textContent = money(total);
      byId('batch-error').textContent = '';
      byId('batch-confirm').disabled = false;
      batchDialog.showModal();
    } finally { batchPreparing = false; revisor?.update(); }
  }
  async function closeBatch() {
    if (batchConfirming) return;
    batchConfirming = true;
    byId('batch-cancel').disabled = true;
    byId('batch-confirm').disabled = true;
    if (batchPreparation) {
      const result = await cart.cancel(batchPreparation.token);
      if (!result.ok) notify(result.error);
    }
    batchPreparation = null;
    batchDialog.close();
    batchConfirming = false;
    byId('batch-cancel').disabled = false;
    renderCart();
    revisor?.update();
    if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
  }
  byId('batch-cancel').addEventListener('click', closeBatch);
  batchDialog.addEventListener('cancel', event => { event.preventDefault(); closeBatch(); });
  byId('batch-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!batchPreparation || batchConfirming) return;
    const proposal = batchPreparation;
    batchConfirming = true; byId('batch-confirm').disabled = true;
    byId('batch-cancel').disabled = true;
    byId('batch-error').textContent = 'Перепроверяем остатки…';
    try {
      const result = await cart.confirm(proposal.token);
      if (!result.ok) throw new Error(result.error);
      batchConfirming = false;
      await closeBatch(); renderCart(); revisor.invalidateAudit();
      notify('Выбранные товары добавлены в серверную корзину.');
    } catch (error) {
      if (batchPreparation === proposal) byId('batch-error').textContent = error.message;
    } finally {
      batchConfirming = false;
      byId('batch-cancel').disabled = false;
      if (batchPreparation === proposal) byId('batch-confirm').disabled = false;
    }
  });
  revisor = service.createRevisor({ prepareBatch, toast: notify, canPrepare: () => !sending && !preparing && !dialog.open && !batchPreparing && !batchDialog.open });
  function route() {
    const view = location.hash === '#audit' ? 'audit' : location.hash === '#chat' || !location.hash ? 'chat' : null;
    if (!view) return;
    byId('chat-section').hidden = view !== 'chat';
    byId('audit-panel').hidden = view !== 'audit';
    document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  }
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { location.hash = button.dataset.view; route(); }));
  window.addEventListener('hashchange', route); route();
  appendMessage("assistant", "Здравствуйте! Помогу найти товары ekt.kz. Укажите название, артикул или ID товара — например, «Есть Legrand 40A?».", [], false);
  renderCart();
  async function refreshCart() {
    try { await cart.refresh(); renderCart(); }
    catch (error) { notify(error.message); }
  }
  document.querySelector('.cart-shortcut').addEventListener('click', refreshCart);
  refreshCart();
})();
