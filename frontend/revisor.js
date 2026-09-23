/* Adapted from ekt-frontend/public/revisor.js: audit rows, selection, totals,
 * invalidation on editing and questions to clarify. Uses the main live API/cart. */
(() => {
  'use strict';
  const app = window.EktApp = window.EktApp || {};
  const labels = { ready: 'Можно подготовить', shortage: 'Не хватает', out_of_stock: 'Нет в наличии', unknown: 'Остаток неизвестен', not_found: 'Не найдено', unparsed: 'Нужно уточнение' };
  app.createAuditSelection = function () {
    let audit = null;
    const selected = new Set();
    return {
      reset(value = null) { audit = value; selected.clear(); },
      select(id, checked) {
        const row = audit?.rows.find(row => row.id === id);
        if (!row || row.status !== 'ready' || !row.product || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || typeof row.product.stock !== 'number' || row.product.stock < row.quantity) return false;
        if (checked) selected.add(id); else selected.delete(id);
        return true;
      },
      items() { return (audit?.rows || []).filter(row => selected.has(row.id)).map(row => ({ productId: String(row.product.id), quantity: row.quantity })); },
      total() {
        const rows = (audit?.rows || []).filter(row => selected.has(row.id));
        return rows.some(row => typeof row.product.price !== 'number') ? null : rows.reduce((sum, row) => sum + row.quantity * row.product.price, 0);
      },
    };
  };
  app.createRevisor = function ({ prepareBatch, canPrepare, toast }) {
    const $ = id => document.getElementById(id);
    const selection = app.createAuditSelection();
    let audit = null;
    let busy = false;
    let version = 0;
    function node(tag, className, text) {
      const result = document.createElement(tag);
      result.className = className;
      if (text !== undefined) result.textContent = text;
      return result;
    }
    const number = value => typeof value === 'number' ? new Intl.NumberFormat('ru-RU').format(value) : 'Не указано';
    function update() {
      $('audit-submit').disabled = busy;
      $('audit-input').disabled = busy;
      $('load-example').disabled = busy;
      $('prepare-list').disabled = busy || !canPrepare() || selection.items().length === 0;
      $('selected-count').textContent = String(selection.items().length);
      $('list-total').textContent = number(selection.total());
    }
    function invalidate(message = 'Список изменён. Запустите проверку заново.') {
      version++;
      audit = null;
      selection.reset();
      $('audit-results').replaceChildren();
      $('audit-summary').hidden = true;
      $('manager-text').hidden = true;
      $('audit-status').textContent = message;
      update();
    }
    function render() {
      const container = $('audit-results');
      container.replaceChildren();
      const ready = audit.rows.filter(row => row.status === 'ready').length;
      container.append(node('p', 'audit-stats', `Проверено строк: ${audit.rows.length} · Можно подготовить: ${ready} · Нужно уточнить: ${audit.rows.length - ready}`));
      for (const row of audit.rows) {
        const card = node('article', 'audit-row');
        card.dataset.rowId = row.id;
        card.dataset.status = row.status;
        const heading = node('div', 'audit-row-heading');
        const choice = node('input', 'audit-choice');
        choice.type = 'checkbox';
        choice.dataset.selectRow = row.id;
        choice.setAttribute('aria-label', `Выбрать ${row.product?.sku || row.raw}`);
        choice.disabled = row.status !== 'ready';
        choice.addEventListener('change', () => { if (!selection.select(row.id, choice.checked)) choice.checked = false; update(); });
        heading.append(choice, node('h3', '', row.product?.name || row.raw), node('span', `status-pill ${row.status}`, labels[row.status] || 'Нужно уточнение'));
        card.append(heading, node('p', 'audit-message', row.message));
        const facts = node('dl', 'audit-facts');
        for (const [label, value] of [['Артикул', row.product?.sku || 'Не указан'], ['Нужно', number(row.quantity)], ['Остаток', number(row.product?.stock)], ['Цена', number(row.product?.price)]]) {
          const fact = node('div', ''); fact.append(node('dt', '', label), node('dd', '', value)); facts.append(fact);
        }
        card.append(facts);
        if (row.alternatives?.length) {
          const details = node('details', 'audit-alternatives');
          details.append(node('summary', '', `Возможные кандидаты: ${row.alternatives.length}`));
          for (const candidate of row.alternatives) {
            details.append(node('p', '', `${candidate.product.name} · ${candidate.product.sku || 'Артикул не указан'} · Цена: ${number(candidate.product.price)} · Остаток: ${number(candidate.product.stock)}. ${candidate.message}`));
          }
          details.append(node('p', '', 'Совместимость не подтверждена. После проверки характеристик можно проверить артикул кандидата отдельной строкой.'));
          card.append(details);
        }
        container.append(card);
      }
      $('audit-summary').hidden = false;
      update();
    }
    async function runAudit() {
      if (busy) return;
      const text = $('audit-input').value.trim();
      invalidate('Проверяем список в ekt.kz. Корзина не меняется…');
      $('audit-error').textContent = '';
      if (!text || text.split(/\r?\n/).filter(line => line.trim()).length > 10) {
        $('audit-error').textContent = 'Вставьте от 1 до 10 непустых строк.';
        $('audit-status').textContent = 'Проверка не начата.'; return;
      }
      const current = version;
      busy = true; update();
      try {
        const result = await app.audit(text);
        if (current !== version) return;
        audit = result; selection.reset(result); render();
        $('audit-status').textContent = result.message;
      } catch (error) {
        if (current !== version) return;
        $('audit-error').textContent = error.message;
        $('audit-status').textContent = 'Проверка не завершена. Повторите запрос.';
      } finally { busy = false; update(); }
    }
    $('audit-form').addEventListener('submit', event => { event.preventDefault(); runAudit(); });
    $('audit-input').addEventListener('input', () => invalidate());
    $('load-example').addEventListener('click', () => {
      $('audit-input').value = '200300273_ ; 2\n310100080_ ; 5\nXYZ123NOTFOUND ; 3'; invalidate();
    });
    $('prepare-list').addEventListener('click', async () => {
      if (busy || !canPrepare() || !selection.items().length) return;
      busy = true; update();
      try { await prepareBatch(selection.items(), $('prepare-list')); }
      catch (error) { toast(error.message); }
      finally { busy = false; update(); }
    });
    $('manager-copy').addEventListener('click', async () => {
      if (!audit) return;
      const lines = audit.rows.filter(row => row.status !== 'ready').map(row => `${row.product?.sku || row.raw}: ${row.message}`);
      const text = 'Вопросы по данным ekt.kz (не заказ):\n' + (lines.join('\n') || 'Нерешённых строк нет.');
      $('manager-text').value = text; $('manager-text').hidden = false;
      try { await navigator.clipboard.writeText(text); toast('Вопросы скопированы. Ничего не отправлено.'); }
      catch { $('manager-text').focus(); $('manager-text').select(); }
    });
    update();
    return { update, invalidateAudit: () => invalidate('Корзина изменилась. Перепроверьте список перед новым предложением.') };
  };
})();
