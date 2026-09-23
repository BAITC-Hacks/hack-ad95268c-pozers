import { api, requestId, safeLink } from './api.js';
import { evidenceHTML, comparisonHTML } from './evidence.js';
import { createRevisor } from './revisor.js';
let revisor;

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = value => `${new Intl.NumberFormat('ru-RU').format(value)} ₸`;
const paths = {
  chat: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3v-10A7.5 7.5 0 0 1 9.5 4h3a7.5 7.5 0 0 1 7.5 7.5Z"/><path d="M7 10h8M7 14h5"/>',
  bag: '<path d="M5 7h14l1 14H4L5 7Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  shield: '<path d="m12 3 8 3v5c0 5-5 8-8 10-3-2-8-5-8-10V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  'arrow-up': '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
  cable: '<path d="M7 3v5m-3-5v5M3 8h5v3a3 3 0 0 1-3 3v3a4 4 0 0 0 8 0V8a4 4 0 0 1 8 0v7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  delivery: '<path d="M3 6h11v11H3zM14 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
}
document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });

const state = {
  ready: false, chatBusy: false, actionBusy: false, products: new Map(),
  proposal: null, proposalError: '', confirmationUncertain: false, confirmationBlocked: false,
  confirmId: null, cancelId: null, preparation: null, failedChat: null,
  cart: { items: [], total: 0, revision: -1, cart_url: '#cart', currency: 'KZT' },
  mode: null, toastTimer: null, cartLoadSequence: 0,
};

function uncertain(error) {
  return error.status === 0 || error.status >= 500 || error.code === 'INVALID_RESPONSE';
}
function toast(text) {
  clearTimeout(state.toastTimer);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000);
}
function scrollMessages() {
  const element = $('#messages');
  element.scrollTop = element.scrollHeight;
}
function chatError(text, retry = null) {
  const box = $('#chat-error');
  box.replaceChildren();
  box.hidden = !text;
  if (!text) return;
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  box.append(paragraph);
  if (retry) {
    const button = document.createElement('button');
    button.className = 'retry-button';
    button.textContent = 'Повторить запрос';
    button.type = 'button';
    button.addEventListener('click', retry, { once: true });
    box.append(button);
  }
}
function updateControls() {
  const blocked = !state.ready || state.chatBusy || state.actionBusy || Boolean(state.proposal) || Boolean(state.preparation);
  const textBlocked = !state.ready || state.chatBusy || state.actionBusy || Boolean(state.preparation) || state.confirmationUncertain;
  $('#message-input').disabled = textBlocked;
  $('#send-button').disabled = textBlocked || !$('#message-input').value.trim();
  document.querySelectorAll('[data-query], [data-prepare], .qty-field input').forEach(node => {
    const product = state.products.get(node.dataset.prepare);
    node.disabled = blocked || (product ? product.stock === null || product.stock <= 0 : node.dataset.unavailable === 'true');
  });
  revisor?.update();
  $('#send-button').innerHTML = icon('arrow-up');
  $('#chat-form').setAttribute('aria-busy', String(state.chatBusy));
  $('#composer-caption').innerHTML = `${icon('lock')}<span>${state.proposal ? 'Подтвердите кнопкой или напишите «да, добавь»' : 'Добавление только с вашего подтверждения'}</span>`;
}

function productArt(kind = 'breaker') {
  if (kind === 'cable') return '<svg viewBox="0 0 110 90" aria-hidden="true"><ellipse cx="55" cy="73" rx="33" ry="6" fill="#dce2ec"/><ellipse cx="53" cy="46" rx="32" ry="25" fill="#34445b"/><ellipse cx="53" cy="46" rx="23" ry="17" fill="#637086"/><ellipse cx="53" cy="46" rx="12" ry="9" fill="#eef1f6"/><path d="M77 61c19 1 20-23 9-27" fill="none" stroke="#36465c" stroke-width="7"/><path d="m86 34-6-8m6 8 3-10m-3 10 9-6" stroke="#d0a35c" stroke-width="3" stroke-linecap="round"/></svg>';
  return '<svg viewBox="0 0 110 100" aria-hidden="true"><ellipse cx="57" cy="89" rx="29" ry="5" fill="#dce2ec"/><path d="m33 14 10-7h38v70l-10 10H33Z" fill="#c5ceda"/><path d="M33 14h38v73H33z" fill="#fafcfe" stroke="#d5dce6"/><path d="m71 14 10-7v70L71 87Z" fill="#b9c4d2"/><path d="M38 18h27v13H38zM38 70h27v12H38z" fill="#e2e8f0"/><circle cx="51" cy="24" r="3" fill="#9caaba"/><circle cx="51" cy="76" r="3" fill="#9caaba"/><path d="M42 42h19v19H42z" fill="#243c5d"/><path d="m42 43 19-4v9l-19 4Z" fill="#3d6191"/><path d="M40 34h10" stroke="#315efb" stroke-width="2"/><path d="M40 65h20" stroke="#d1dce9" stroke-width="1.5"/></svg>';
}

function productCard(product) {
  state.products.set(product.id, product);
  const available = product.stock !== null && product.stock > 0;
  const stockText = product.stock === null ? 'Не проверено' : product.stock > 0 ? `${product.stock} ${product.unit} в наличии` : 'Нет в наличии';
  const certificate = product.certificate_url && safeLink(product.certificate_url);
  return `<article class="product-card" data-product="${escape(product.id)}">
    <div class="product-visual">${productArt(product.kind)}<span class="product-category">${state.mode === 'demo' ? 'DEMO CATALOG' : 'КАТАЛОГ'}</span><span class="stock-dot ${available ? '' : 'unavailable'}">${escape(stockText)}</span></div>
    <span class="sku">АРТ. ${escape(product.sku)}</span><h3>${escape(product.name)}</h3>
    <div class="spec-chips">${product.specs.map(spec => `<span>${escape(spec)}</span>`).join('')}</div>
    <div class="certificate">${certificate ? `<a href="${escape(certificate)}" target="_blank" rel="noopener noreferrer">Открыть сертификат ↗</a>` : 'Сертификат не предоставлен'}</div>
    ${evidenceHTML(product.provenance)}
    ${product.reason ? `<p class="alternative-reason">${escape(product.reason)}</p>` : ''}
    <div class="price-row"><span class="price">${money(product.price)}</span><small>/ ${escape(product.unit)}</small></div>
    <div class="product-bottom"><label class="qty-field"><span class="sr-only">Количество для ${escape(product.sku)}</span><input type="number" inputmode="numeric" min="1" max="${product.stock || 1}" step="1" value="1" data-unavailable="${!available}" ${available ? '' : 'disabled'}><span aria-hidden="true">${escape(product.unit)}</span></label><button type="button" class="select-button" data-prepare="${escape(product.id)}" ${available ? '' : 'disabled'}>${available ? 'Выбрать ↗' : product.stock === null ? 'Нет данных' : 'Недоступен'}</button></div><p class="product-error" role="alert" hidden></p>
  </article>`;
}

function appendMessage(role, text, result = {}) {
  const message = document.createElement('article');
  message.className = `message ${role}`;
  message.innerHTML = `<div class="message-label">${role === 'assistant' ? `${icon('bolt')} EKT АССИСТЕНТ` : 'ВЫ'}</div><p class="message-text">${escape(text)}</p>`;
  if (result.products?.length) message.insertAdjacentHTML('beforeend', `<div class="product-grid">${result.products.map(productCard).join('')}</div>`);
  if (result.result_type === 'empty') message.insertAdjacentHTML('beforeend', `<div class="empty-result">${icon('search')}<strong>Ничего не найдено</strong><p>Попробуйте другое название или уточните артикул.</p></div>`);
  for (const warning of result.warnings || []) message.insertAdjacentHTML('beforeend', `<p class="result-warning">${escape(warning)}</p>`);
  if (result.cart_url) {
    const url = safeLink(result.cart_url, true);
    if (url) message.insertAdjacentHTML('beforeend', `<a class="cart-link" href="${escape(url)}">Открыть корзину ${icon('arrow')}</a>`);
  }
  if (role === 'assistant') {
    for (const comparison of result.comparisons || []) message.insertAdjacentHTML('beforeend', comparisonHTML(comparison));
    message.insertAdjacentHTML('beforeend', evidenceHTML(result.provenance));
  }
  $('#messages').append(message);
  scrollMessages();
  updateControls();
  return message;
}
function showWelcome() {
  const welcome = appendMessage('assistant', 'Здравствуйте! Помогу найти электротехнику и проверить ваш выбор перед добавлением в корзину. С чего начнём?');
  const suggestions = [
    ['bolt', 'Автоматы', 'Подобрать выключатель', 'Покажи автоматы'],
    ['cable', 'Кабель', 'Посмотреть варианты', 'Кабель 3x2,5'],
    ['search', 'По артикулу', 'Найти точную позицию', 'DEMO-001'],
    ['delivery', 'Условия покупки', 'Оплата и доставка', 'Условия покупки'],
  ];
  welcome.insertAdjacentHTML('beforeend', `<div class="suggestions">${suggestions.map(([symbol, title, subtitle, query]) => `<button class="suggestion" type="button" data-query="${escape(query)}"><span class="suggestion-icon">${icon(symbol)}</span><span><strong>${title}</strong><small>${subtitle}</small></span><span class="suggestion-arrow">↗</span></button>`).join('')}</div><p class="starter-note">${icon('info')}<span id="starter-mode-note">Товары и ответы в демо — учебные.</span></p>`);
}
function showThinking() {
  const node = document.createElement('div');
  node.id = 'chat-pending';
  node.className = 'thinking';
  node.setAttribute('role', 'status');
  node.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Проверяем данные…</span>';
  $('#messages').append(node);
  scrollMessages();
}
async function sendChat(text, retry = false) {
  if (!state.ready || state.chatBusy || state.actionBusy || state.preparation || state.confirmationUncertain) return;
  const value = String(text || '').trim();
  if (!value) return;
  if (state.proposal && /^да\s*,?\s*добавь[.!]?$/i.test(value)) {
    appendMessage('user', value); $('#message-input').value = '';
    await confirmProposal(); return;
  }
  if (value.length > 2000) return chatError('Сократите запрос до 2000 символов.');
  const task = retry && state.failedChat ? state.failedChat : { message: value, request_id: requestId() };
  state.chatBusy = true;
  chatError('');
  if (!retry) appendMessage('user', value);
  $('#message-input').value = '';
  $('#message-input').style.height = '';
  updateControls();
  showThinking();
  try {
    const result = await api.chat(task.message, task.request_id);
    state.failedChat = null;
    appendMessage('assistant', result.message, result);
    if (result.proposal) setProposal(result.proposal);
  } catch (error) {
    state.failedChat = task;
    chatError(error.message, () => sendChat(task.message, true));
  } finally {
    $('#chat-pending')?.remove();
    state.chatBusy = false;
    updateControls();
  }
}

function setProposal(proposal) {
  state.proposal = proposal;
  state.confirmId = requestId();
  state.cancelId = requestId();
  state.proposalError = '';
  state.confirmationUncertain = false;
  state.confirmationBlocked = false;
  renderProposal();
}
function clearProposal() {
  state.proposal = null;
  state.proposalError = '';
  state.confirmationUncertain = false;
  state.confirmationBlocked = false;
  renderProposal();
}
function renderProposal() {
  const area = $('#proposal-area');
  const proposal = state.proposal;
  if (!proposal) { area.replaceChildren(); return; }
  area.innerHTML = `<section class="proposal" aria-labelledby="proposal-title">
    <div class="proposal-heading">${icon('shield')}<h2 id="proposal-title">Подтвердите добавление</h2><span class="proposal-badge">ЕЩЁ НЕ В КОРЗИНЕ</span></div>
    ${(proposal.items || [proposal]).map(item => `<div class="proposal-product"><div><strong>${escape(item.name)}</strong><small>${escape(item.sku)} · ${item.quantity} ${escape(item.unit)} × ${money(item.unit_price)}</small></div><span class="proposal-total">${money(item.total)}</span></div>`).join('')}
    <div class="batch-total"><span>Итого за товары</span><strong>${money(proposal.total)}</strong></div>
    ${evidenceHTML(proposal.provenance)}
    <div class="proposal-facts"><span>${escape(proposal.warehouse || 'Склад не указан')}</span><span class="expires-label"></span></div>
    <div class="proposal-error" role="alert" ${state.proposalError ? '' : 'hidden'}>${escape(state.proposalError)}</div>
    <div class="proposal-actions"><button id="cancel-proposal" type="button" class="secondary-button">Отмена</button><button id="confirm-proposal" type="button" class="primary-button">${icon('check')}<span>Подтвердить добавление</span></button></div>
    <p class="proposal-note">${state.confirmationUncertain ? 'Ответ не получен. Операция могла выполниться. Проверка использует тот же идентификатор и не добавляет товар повторно.' : 'Проверим наличие ещё раз. Без вашего подтверждения корзина не изменится.'}</p>
  </section>`;
  updateProposalButtons();
}
function updateProposalButtons() {
  const proposal = state.proposal;
  if (!proposal || !$('#confirm-proposal')) return;
  const remaining = Math.max(0, Math.ceil((Date.parse(proposal.expires_at) - Date.now()) / 1000));
  $('.expires-label').textContent = remaining > 0 ? `Подтверждение: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Срок предложения истёк';
  const button = $('#confirm-proposal');
  button.disabled = state.actionBusy || state.confirmationBlocked || (!remaining && !state.confirmationUncertain);
  button.querySelector('span').textContent = state.actionBusy ? 'Ждём ответ сервера…' : state.confirmationUncertain ? 'Проверить результат' : remaining ? 'Подтвердить добавление' : 'Время истекло';
  $('#cancel-proposal').disabled = state.actionBusy || state.confirmationUncertain;
  $('.proposal-badge').textContent = state.confirmationUncertain ? 'РЕЗУЛЬТАТ НЕИЗВЕСТЕН' : 'ЕЩЁ НЕ В КОРЗИНЕ';
}
setInterval(updateProposalButtons, 1000);

async function prepareProduct(productId, quantity, retry = false, batchItems = null) {
  if (!state.ready || state.actionBusy || state.proposal || state.chatBusy || (state.preparation && !retry)) return;
  const task = retry ? state.preparation : { ...(batchItems ? { items: batchItems } : { product_id: productId, quantity }), request_id: requestId() };
  state.preparation = task;
  state.actionBusy = true;
  chatError('');
  $('#proposal-area').innerHTML = `<div class="thinking" role="status"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>Готовим предложение. Корзина пока не меняется…</div>`;
  updateControls();
  try {
    const result = task.items ? await api.prepareBatch(task.items, task.request_id) : await api.prepare(task.product_id, task.quantity, task.request_id);
    state.preparation = null;
    setProposal(result.proposal);
  } catch (error) {
    $('#proposal-area').replaceChildren();
    if (uncertain(error)) {
      chatError(`${error.message} Корзина не менялась: это только подготовка предложения.`, () => prepareProduct(task.product_id, task.quantity, true));
    } else {
      state.preparation = null;
      chatError(error.message);
    }
  } finally {
    state.actionBusy = false;
    updateControls();
    updateProposalButtons();
    $('#confirm-proposal')?.focus();
  }
}

function receiveCart(cart) {
  // Поздний ответ не должен откатить уже показанную более новую корзину.
  const changed = state.cart.revision >= 0 && cart.revision > state.cart.revision;
  if (cart.revision >= state.cart.revision) state.cart = cart;
  if (changed) revisor?.invalidateAudit();
  // Считаем позиции: метры и штуки нельзя складывать как одну единицу.
  document.querySelectorAll('[data-cart-count]').forEach(node => { node.textContent = String(state.cart.items.length); });
}
async function confirmProposal() {
  if (!state.proposal || state.actionBusy || state.confirmationBlocked) return;
  if (!state.confirmationUncertain && Date.parse(state.proposal.expires_at) <= Date.now()) return;
  const proposal = state.proposal;
  state.actionBusy = true;
  state.proposalError = '';
  renderProposal();
  updateControls();
  try {
    // Идентификатор сохраняется при тайм-ауте и повторной попытке.
    const result = await api.confirm(proposal.id, state.confirmId);
    receiveCart(result.cart);
    clearProposal();
    appendMessage('assistant', `Сервер подтвердил добавление: ${(proposal.items || [proposal]).map(p => `${p.sku} — ${p.quantity} ${p.unit}`).join('; ')}. Итого ${money(proposal.total)}.`, { cart_url: result.cart.cart_url, provenance: result.cart.provenance });
    toast('Добавлено в корзину — сервер подтвердил операцию.');
    if (location.hash === '#cart') await loadCart();
  } catch (error) {
    state.confirmationUncertain = uncertain(error);
    state.confirmationBlocked = !state.confirmationUncertain;
    state.proposalError = state.confirmationUncertain ? `${error.message} Не считаем операцию неуспешной: её результат пока неизвестен. Нажмите «Проверить результат» или откройте корзину.` : `${error.message} Добавление не подтверждено. Отмените предложение и выберите товар заново.`;
    renderProposal();
  } finally {
    state.actionBusy = false;
    updateControls();
    updateProposalButtons();
    if (!state.proposal && location.hash !== '#cart') $('#message-input').focus({ preventScroll: true });
  }
}
async function cancelProposal() {
  if (!state.proposal || state.actionBusy || state.confirmationUncertain) return;
  const proposal = state.proposal;
  state.actionBusy = true;
  updateControls();
  updateProposalButtons();
  try {
    await api.cancel(proposal.id, state.cancelId);
    clearProposal();
    toast('Предложение отменено. Корзина не менялась.');
  } catch (error) {
    state.proposalError = `${error.message} Отмена не подтверждена — предложение сохранено.`;
    // Нельзя после неясной отмены разрешать подтверждение: сначала повторяем отмену.
    state.confirmationBlocked = true;
    renderProposal();
  } finally {
    state.actionBusy = false;
    updateControls();
    updateProposalButtons();
    if (!state.proposal) $('#message-input').focus({ preventScroll: true });
  }
}

function renderCart() {
  const cart = state.cart;
  if (!cart.items.length) {
    $('#cart-content').innerHTML = `<div class="empty-cart"><div class="empty-cart-icon">${icon('bag')}</div><h2>Пока ничего нет</h2><p>Выберите товар в чате и подтвердите добавление. После ответа сервера он появится здесь.</p><a href="#chat" class="primary-button">Перейти к подбору ${icon('arrow')}</a></div>`;
    return;
  }
  $('#cart-content').innerHTML = `<div class="cart-layout"><div><div class="cart-list"><div class="cart-list-header"><span>ВЫБРАННЫЕ ПОЗИЦИИ</span><span>${cart.items.length}</span></div>${cart.items.map(item => `<article class="cart-item"><div class="product-visual">${productArt(item.kind)}</div><div><h3>${escape(item.name)}</h3><div class="sku">АРТ. ${escape(item.sku)}</div><p>${item.quantity} ${escape(item.unit)} × ${money(item.unit_price)}</p></div><strong class="cart-item-price">${money(item.total)}</strong></article>`).join('')}</div><p class="cart-updated">${icon('check')}Состояние получено с сервера · версия ${cart.revision}</p></div><aside class="cart-summary"><h2>Сводка корзины</h2><div class="summary-row"><span>Позиций</span><span>${cart.items.length}</span></div><div class="summary-row"><span>Стоимость товаров</span><span>${money(cart.total)}</span></div><div class="summary-row"><span>Доставка</span><span>Не рассчитана</span></div><div class="summary-total"><span>Итого за товары</span><strong>${money(cart.total)}</strong></div><a class="primary-button" href="#chat">Продолжить подбор ${icon('arrow')}</a><div class="demo-note">${icon('info')}<div><strong>${state.mode === 'demo' ? 'Это учебная корзина' : 'Оформление не подключено'}</strong><p>${state.mode === 'demo' ? 'Не связана с ekt.kz. Оплата и настоящий заказ недоступны. После перезапуска демосервера данные удаляются.' : 'Этот интерфейс не принимает платёжные данные. Оформление заказа нужно подключить отдельно.'}</p></div></div></aside></div>`;
}
async function loadCart() {
  const sequence = ++state.cartLoadSequence;
  $('#cart-content').innerHTML = '<div class="skeleton-card" role="status" aria-label="Загрузка корзины"><span class="sr-only">Загружаем корзину…</span><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>';
  try {
    const cart = await api.cart();
    if (sequence !== state.cartLoadSequence) return;
    receiveCart(cart);
    renderCart();
    $('#cart-content').insertAdjacentHTML('beforeend', evidenceHTML(state.cart.provenance));
  } catch (error) {
    if (sequence !== state.cartLoadSequence) return;
    $('#cart-content').innerHTML = `<div class="cart-error" role="alert"><h2>Не удалось загрузить корзину</h2><p>${escape(error.message)} Старые данные не выдаём за актуальные.</p><button class="retry-button" type="button" id="retry-cart">Попробовать ещё раз</button></div>`;
  }
}
function route() {
  const selected = ['chat', 'cart', 'audit', 'checks'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'audit';
  const titles = { chat: 'Подбор оборудования', cart: 'Корзина', audit: 'Ревизор закупки', checks: 'Проверки защиты' };
  for (const key of Object.keys(titles)) {
    $(`#${key}-page`).hidden = key !== selected;
    const nav = $(`#nav-${key}`); nav.classList.toggle('active', key === selected);
    if (key === selected) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  }
  document.querySelectorAll('.mobile-tabs a').forEach(a => {
    a.classList.toggle('active', a.hash === `#${selected}`);
    if (a.hash === `#${selected}`) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#page-crumb').textContent = titles[selected];
  if (selected === 'cart' && state.ready) loadCart();
}

async function init() {
  state.ready = false;
  updateControls();
  $('#connection-error').hidden = true;
  try {
    const session = await api.session();
    state.mode = session.data_mode;
    $('#mode-badge').textContent = state.mode === 'demo' ? 'ДЕМО · учебные данные' : 'Данные сервера';
    $('#assistant-subtitle').textContent = state.mode === 'demo' ? 'Учебный сервер · без AI' : 'Подключён к вашему серверу';
    $('#demo-note').hidden = state.mode !== 'demo';
    $('#demo-checks').hidden = state.mode !== 'demo';
    $('#starter-mode-note').textContent = state.mode === 'demo' ? 'Товары и ответы в демо — учебные.' : 'Цены и наличие поступают с вашего сервера.';
    // Сохраняем реальную корзину сессии при обновлении страницы.
    receiveCart(await api.cart());
    if (session.proposal) setProposal(session.proposal);
    state.ready = true;
    revisor.setSession(session);
    route();
  } catch (error) {
    $('#mode-badge').textContent = 'Нет подключения';
    $('#assistant-subtitle').textContent = 'Сервер недоступен';
    $('#connection-error').hidden = false;
    $('#connection-error').innerHTML = `<p>${escape(error.message)} Запустите сервер по README.</p><button class="retry-button" id="retry-init" type="button">Подключиться снова</button>`;
  } finally { updateControls(); }
}

$('#chat-form').addEventListener('submit', event => { event.preventDefault(); sendChat($('#message-input').value); });
$('#message-input').addEventListener('input', () => {
  const input = $('#message-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  updateControls();
});
$('#message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendChat($('#message-input').value); }
});
document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.query) return void sendChat(target.dataset.query);
  if (target.dataset.prepare) {
    const card = target.closest('.product-card');
    const input = card.querySelector('input');
    const errorBox = card.querySelector('.product-error');
    const product = state.products.get(target.dataset.prepare);
    const quantity = Number(input.value);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > product.stock) {
      errorBox.textContent = `Введите целое количество от 1 до ${product.stock}.`;
      errorBox.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    errorBox.hidden = true;
    input.removeAttribute('aria-invalid');
    return void prepareProduct(product.id, quantity);
  }
  if (target.id === 'confirm-proposal') return void confirmProposal();
  if (target.id === 'cancel-proposal') return void cancelProposal();
  if (target.id === 'retry-cart') return void loadCart();
  if (target.id === 'retry-init') return void init();
});
revisor = createRevisor({
  canPrepare: () => state.ready && !state.actionBusy && !state.chatBusy && !state.proposal && !state.preparation,
  prepareBatch: items => { location.hash = '#chat'; prepareProduct(null, null, false, items); },
  toast,
});
window.addEventListener('hashchange', route);
showWelcome();
route();
init();
