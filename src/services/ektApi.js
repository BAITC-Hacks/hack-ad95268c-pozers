const PRODUCTS_URL = 'https://ekt.kz/api/products';

class EktApiError extends Error {
  constructor(message, status, code, upstreamStatus) {
    super(message);
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

async function getProducts(page) {
  if (page !== undefined && (typeof page !== 'string' || !/^[1-9]\d*$/.test(page))) {
    throw new EktApiError('Параметр page должен быть целым положительным числом.', 400, 'INVALID_PAGE');
  }

  const url = new URL(PRODUCTS_URL);
  if (page !== undefined) url.searchParams.set('page', page);
  return requestJson(url);
}

async function getProductDetail(detailUrl) {
  let url;
  try { url = new URL(detailUrl); } catch {
    throw new EktApiError('Некорректный адрес detail.', 502, 'EKT_INVALID_DETAIL_URL');
  }
  if (url.origin !== 'https://ekt.kz' || url.pathname !== '/api/products/detail' || url.username || url.password) {
    throw new EktApiError('Некорректный адрес detail.', 502, 'EKT_INVALID_DETAIL_URL');
  }
  return requestJson(url);
}

async function requestJson(url) {
  const { EKT_USERNAME, EKT_PASSWORD } = process.env;
  if (!EKT_USERNAME || !EKT_PASSWORD) {
    throw new EktApiError('Заполните EKT_USERNAME и EKT_PASSWORD в локальном .env и перезапустите сервер.', 503, 'EKT_NOT_CONFIGURED');
  }

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${EKT_USERNAME}:${EKT_PASSWORD}`, 'utf8').toString('base64')}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      // Не передаём наружу тело ошибки: оно может содержать чувствительные данные.
      await response.body?.cancel();
      const message = response.status === 401 || response.status === 403
        ? 'API ekt.kz отклонил доступ. Проверьте данные авторизации и права доступа.'
        : response.status === 429
          ? 'API ekt.kz ограничил частоту запросов. Попробуйте позже.'
          : 'API ekt.kz вернул ошибку.';
      throw new EktApiError(message, 502, 'EKT_HTTP_ERROR', response.status);
    }

    // Сохраняем исходную структуру JSON, включая данные пагинации, если они есть.
    return await response.json();
  } catch (error) {
    if (error instanceof EktApiError) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new EktApiError('API ekt.kz не ответил за 15 секунд. Попробуйте позже.', 504, 'EKT_TIMEOUT');
    }
    if (error instanceof SyntaxError) {
      throw new EktApiError('API ekt.kz вернул некорректный JSON.', 502, 'EKT_INVALID_JSON', response?.status);
    }
    throw new EktApiError('Не удалось получить ответ API ekt.kz. Проверьте соединение и попробуйте позже.', 502, 'EKT_CONNECTION_ERROR', response?.status);
  }
}

module.exports = { getProducts, getProductDetail, EktApiError };
