const { EktApiError } = require('./ektApi');

const normalize = value => String(value).trim().toLocaleLowerCase('ru');
const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const publicProduct = product => ({
  id: product.id, sku: typeof product.article === 'string' ? product.article : null,
  name: product.name, price: numberOrNull(product.price), stock: numberOrNull(product.quantity),
  image: typeof product.image === 'string' ? product.image : null,
  url: typeof product.url === 'string' ? product.url : null,
});

function parseList(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 6000) {
    throw new EktApiError('Вставьте список до 6000 символов в формате «артикул или название ; количество».', 400, 'INVALID_AUDIT_TEXT');
  }
  const lines = text.split(/\r?\n/).map(raw => raw.trim()).filter(Boolean);
  if (lines.length > 10) throw new EktApiError('Можно проверить максимум 10 непустых строк.', 400, 'TOO_MANY_AUDIT_LINES');
  return lines.map((raw, index) => {
    const match = raw.match(/^([^;\n]{1,200})\s*;\s*([1-9]\d*)\s*$/);
    const quantity = match ? Number(match[2]) : null;
    const parsed = match && match[1].trim() && Number.isSafeInteger(quantity);
    return {
      id: `row-${index + 1}`, raw, query: parsed ? match[1].trim() : null,
      quantity: parsed ? quantity : null, status: 'unparsed',
      message: 'Укажите «артикул или название ; положительное целое количество», без единиц измерения.',
      product: null, alternatives: [],
    };
  });
}

function createAuditService({ searchProducts, getProductById }) {
  return async function audit(text) {
    const rows = parseList(text);
    const details = new Map();
    async function detail(id) {
      if (!details.has(id)) details.set(id, (async () => {
        try {
          const product = await getProductById(String(id));
          if (product?.id !== id || typeof product.name !== 'string') throw new EktApiError('Некорректные детали товара ekt.kz.', 502, 'EKT_INVALID_DETAIL');
          return product;
        } catch (error) {
          if (error.code === 'PRODUCT_NOT_FOUND') return null;
          throw error;
        }
      })());
      return details.get(id);
    }

    async function resolve(row) {
      if (!row.query) return;
      const found = await searchProducts(row.query);
      const exact = found.items.filter(p => typeof p.article === 'string' && normalize(p.article) === normalize(row.query));
      const candidates = exact.length ? exact : found.items;
      if (!candidates.length) {
        row.status = 'not_found'; row.message = 'Товар не найден в доступной части каталога (первые 3 страницы).'; return;
      }
      if (candidates.length !== 1) { row.message = 'Найдено несколько товаров. Уточните точный артикул.'; return; }
      const product = await detail(candidates[0].id);
      if (!product) { row.status = 'not_found'; row.message = 'Товар больше не найден в detail каталога.'; return; }
      row.product = publicProduct(product);
    }
    // Не более трёх одновременных операций; повторные ID используют один detail.
    for (let i = 0; i < rows.length; i += 3) await Promise.all(rows.slice(i, i + 3).map(resolve));
    const totals = new Map();
    for (const row of rows) if (row.product) totals.set(row.product.id, (totals.get(row.product.id) || 0) + row.quantity);
    for (const row of rows) {
      if (!row.product) continue;
      const stock = row.product.stock;
      const required = totals.get(row.product.id);
      if (stock === null) { row.status = 'unknown'; row.message = 'Остаток в API не указан. Добавление недоступно.'; }
      else if (stock === 0) { row.status = 'out_of_stock'; row.message = 'Остаток по каталогу равен 0.'; }
      else if (stock < required) {
        row.status = 'shortage'; row.message = required !== row.quantity
          ? 'Остатка недостаточно для суммы повторяющихся позиций списка.' : 'Товар найден, но количества недостаточно.';
      } else { row.status = 'ready'; row.message = 'Товар найден, количества достаточно.'; }
    }

    // Кандидаты только с подтверждёнными общими свойствами; не инженерные аналоги.
    const keys = ['TORGOVAYA_MARKA', 'NOMINALNYY_TOK', 'KOLICHESTVO_POLYUSOV'];
    const scalar = value => (typeof value === 'string' && value.trim()) || typeof value === 'number';
    let probes = 0;
    for (const row of rows.filter(r => ['shortage', 'out_of_stock'].includes(r.status))) {
      const source = await detail(row.product.id);
      if (!keys.every(key => scalar(source.properties?.[key]))) continue;
      const query = String(source.properties.TORGOVAYA_MARKA).trim();
      if (query.length > 200) continue;
      const candidates = await searchProducts(query);
      for (const item of candidates.items) {
        if (item.id === source.id) continue;
        if (!details.has(item.id)) {
          if (probes >= 4) break;
          probes++;
        }
        const candidate = await detail(item.id);
        if (!candidate || numberOrNull(candidate.quantity) === null || candidate.quantity < totals.get(source.id)) continue;
        if (!keys.every(key => scalar(candidate.properties?.[key]) && normalize(candidate.properties[key]) === normalize(source.properties[key]))) continue;
        const voltage = 'NOMINALNOE_NAPRYAZHENIE';
        if (scalar(source.properties[voltage]) && scalar(candidate.properties[voltage]) && normalize(source.properties[voltage]) !== normalize(candidate.properties[voltage])) continue;
        row.alternatives.push({ product: publicProduct(candidate), matched_fields: keys,
          message: 'Возможный кандидат на замену, требуется проверка характеристик.' });
        if (row.alternatives.length >= 2) break;
      }
    }
    return { rows, data_mode: 'live', message: 'Проверка завершена. Использованы данные ekt.kz; поиск ограничен первыми 3 страницами. Корзина не менялась.' };
  };
}

module.exports = { createAuditService };
