const { getProducts, EktApiError } = require('./ektApi');

const PAGE_LIMIT = 3;
const CACHE_TTL_MS = 3 * 60 * 1000;
const normalize = value => value.toLocaleLowerCase('ru').trim();

function createProductSearch(fetchPage = getProducts, now = Date.now) {
  let cache;
  let expiresAt = 0;
  let loading;

  async function loadCatalog() {
    const products = new Map();
    // В реальном ответе page/per_page/count нет общего количества страниц.
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const data = await fetchPage(String(page));
      if (!data || !Array.isArray(data.items)) {
        throw new EktApiError('Неожиданная структура каталога ekt.kz.', 502, 'EKT_INVALID_CATALOG');
      }
      for (const item of data.items) products.set(item.id, item);
      if (!data.items.length || (Number.isInteger(data.per_page) && data.per_page > data.items.length)) break;
    }
    cache = [...products.values()];
    expiresAt = now() + CACHE_TTL_MS;
    return cache;
  }

  async function catalog() {
    if (cache && now() < expiresAt) return cache;
    // Одновременные поиски разделяют одну загрузку; ошибки не кэшируются.
    if (!loading) loading = loadCatalog().finally(() => { loading = undefined; });
    return loading;
  }

  return async function searchProducts(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) {
      throw new EktApiError('Укажите непустой параметр q длиной до 200 символов.', 400, 'INVALID_SEARCH_QUERY');
    }
    const q = normalize(query);
    const ranked = (await catalog()).map(item => {
      const article = typeof item.article === 'string' ? normalize(item.article) : '';
      const name = typeof item.name === 'string' ? normalize(item.name) : '';
      const rank = article === q ? 0 : article.includes(q) ? 1 : name.includes(q) ? 2 : 3;
      return { item, rank };
    }).filter(entry => entry.rank < 3).sort((a, b) => a.rank - b.rank);
    const items = ranked.map(({ item }) => item);
    return { query: query.trim(), count: items.length, items };
  };
}

module.exports = { createProductSearch };
