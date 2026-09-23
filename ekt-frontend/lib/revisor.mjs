/** Pure demo catalogue reading. No AI, network, secrets, or cart mutations. */
import { randomUUID } from 'node:crypto';
export const BUILD = '2.0.0';
export const ATTRIBUTES = [
  ['current', 'Номинальный ток'], ['poles', 'Полюса'], ['curve', 'Характеристика'],
  ['breaking_capacity', 'Отключающая способность'], ['voltage', 'Напряжение'],
  ['dimensions', 'Размеры / монтаж'],
];
export function evidence(kind = 'catalog', fields = []) {
  const labels = { catalog: 'Локальный учебный каталог', terms: 'Вымышленный справочник условий', cart: 'Состояние учебной корзины', audit: 'Проверка учебного списка', guard: 'Правила учебного сервера' };
  return {
    source: { id: `demo:${kind}`, label: labels[kind] || labels.catalog, url: null },
    fetched_at: new Date().toISOString(), data_mode: 'demo', fields,
    limitations: ['Это вымышленные данные, не сведения ekt.kz.', 'fetched_at — время чтения локальных данных, не обновления магазина.'],
  };
}
export function publicProduct(product) {
  return { ...structuredClone(product), provenance: evidence('catalog', ['sku', 'price', 'stock', 'unit', 'specs', 'attributes', 'certificate_url']) };
}
export function compareProducts(original, candidate) {
  const parameters = ATTRIBUTES.map(([key, label]) => {
    const a = original.attributes?.[key] ?? null;
    const b = candidate.attributes?.[key] ?? null;
    return { key, label, original: a, candidate: b, verdict: a === null || b === null ? 'unknown' : a === b ? 'match' : 'different' };
  });
  return {
    original_sku: original.sku, candidate_sku: candidate.sku, parameters,
    status: parameters.some(p => p.verdict === 'different') ? 'incompatible' : 'requires_review',
    explanation: parameters.some(p => p.verdict === 'different')
      ? 'Есть различие важных параметров. Не предлагаем как подтверждённую замену.'
      : 'Известные параметры совпали. Монтаж и совместимость не подтверждены: требуется проверка специалиста.',
    provenance: evidence('catalog', ['attributes']),
  };
}
export function alternativesFor(product, catalog) {
  if (product.kind !== 'breaker') return [];
  return [...catalog.values()]
    .filter(p => p.id !== product.id && p.kind === product.kind && p.stock > 0 && p.attributes?.current === product.attributes?.current)
    .slice(0, 3).map(p => ({ product: publicProduct(p), comparison: compareProducts(product, p) }));
}
const normalizeUnit = text => /^шт\.?$/i.test(text || '') ? 'шт.' : text?.toLowerCase() === 'м' ? 'м' : text;
/** Strict format on purpose: pasted material is data, never an executable command. */
export function auditList(text, catalog, cart) {
  if (typeof text !== 'string' || !text.trim() || text.length > 6000) throw Object.assign(new Error('Вставьте список до 6000 символов.'), { status: 400, code: 'INVALID_LIST' });
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length > 10) throw Object.assign(new Error('В первой версии — не больше 10 строк за проверку.'), { status: 400, code: 'TOO_MANY_LINES' });
  const grouped = new Map(); const rows = [];
  for (const raw of lines) {
    const match = raw.match(/^(DEMO-\d{3})\s*(?:[;:×xX—–]|-)\s*(\d+)\s*(шт\.?|м)?\s*$/i);
    if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0 || Number(match[2]) > 100000) {
      rows.push({ id: randomUUID(), raw, status: 'unparsed', quantity: null, product: null, message: 'Не распознано. Формат: DEMO-001 ; 10 шт. Команды из списка не выполняются.', alternatives: [] }); continue;
    }
    const sku = match[1].toUpperCase(); const unit = normalizeUnit(match[3]);
    const key = `${sku}|${unit || ''}`;
    if (grouped.has(key)) { const r = grouped.get(key); r.quantity += Number(match[2]); r.raw += `\n${raw}`; r.merged_lines++; }
    else { const r = { id: randomUUID(), sku, quantity: Number(match[2]), requested_unit: unit || null, raw, merged_lines: 1 }; grouped.set(key, r); rows.push(r); }
  }
  const requestedTotals = new Map();
  for (const r of rows) if (r.sku) requestedTotals.set(r.sku, (requestedTotals.get(r.sku) || 0) + r.quantity);
  for (const row of rows) {
    if (!row.sku) continue;
    const p = [...catalog.values()].find(p => p.sku === row.sku);
    row.product = p ? publicProduct(p) : null; row.alternatives = [];
    if (!p) { row.status = 'not_found'; row.message = 'Артикул не найден в учебной выборке. Это не означает отсутствия в магазине.'; continue; }
    row.already_in_cart = cart.get(p.id)?.quantity || 0;
    row.available_to_add = p.stock === null ? null : Math.max(0, p.stock - row.already_in_cart);
    if (row.requested_unit && row.requested_unit !== p.unit) { row.status = 'unit_mismatch'; row.message = `Запрошено «${row.requested_unit}», каталог использует «${p.unit}». Автоматического пересчёта нет.`; }
    else if (p.stock === null) { row.status = 'unknown'; row.message = 'Остаток неизвестен. Это не нулевой остаток.'; }
    else if (p.stock === 0) { row.status = 'out_of_stock'; row.message = 'Нет в учебном остатке. Замена только после вашего выбора.'; row.alternatives = alternativesFor(p, catalog); }
    else if (requestedTotals.get(row.sku) > row.available_to_add) { row.status = 'shortage'; row.message = `Нужно по списку ${requestedTotals.get(row.sku)} ${p.unit}; можно добавить ${row.available_to_add}. Количество не уменьшено.`; }
    else { row.status = 'ready'; row.message = `По учебным данным количество доступно. Уже в корзине: ${row.already_in_cart} ${p.unit}.`; }
  }
  return { id: randomUUID(), rows, provenance: evidence('audit', ['rows.product', 'rows.quantity', 'rows.status']), data_mode: 'demo', message: 'Проверка ничего не добавила в корзину. Выберите строки и подготовьте предложение.' };
}
