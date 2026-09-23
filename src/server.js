const path = require('node:path');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  quiet: true,
});

const express = require('express');
const { randomUUID } = require('node:crypto');
const { createChatService } = require('./services/chat');
const { getProducts, getProductById, EktApiError } = require('./services/ektApi');
const { createProductSearch } = require('./services/productSearch');

const app = express();
const port = process.env.PORT || 3000;
const chat = createChatService();
const sessions = new Map();
const searchProducts = createProductSearch();

app.use(express.json({ limit: '8kb' }));

app.post('/api/chat', async (req, res, next) => {
  if (typeof req.body?.message !== 'string' || !req.body.message.trim() || req.body.message.length > 2000) {
    return res.status(400).json({ error: { code: 'INVALID_MESSAGE', message: 'Передайте непустое поле message длиной до 2000 символов.' } });
  }
  const now = Date.now();
  for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
  let id = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('chat_session='))?.slice('chat_session='.length);
  if (!sessions.has(id)) {
    if (sessions.size >= 1000) return res.status(503).json({ error: { code: 'CHAT_BUSY', message: 'Чат занят. Попробуйте позже.' } });
    id = randomUUID();
    sessions.set(id, { product: null, pendingAction: null });
  }
  const session = sessions.get(id);
  if (session.busy) return res.status(409).json({ error: { code: 'CHAT_BUSY', message: 'Дождитесь ответа на предыдущее сообщение.' } });
  session.expires = now + 30 * 60 * 1000;
  res.cookie('chat_session', id, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 30 * 60 * 1000, path: '/api/chat' });
  res.set('Cache-Control', 'no-store');
  session.busy = true;
  try {
    res.json(await chat(req.body.message.trim(), session));
  } catch (error) {
    next(error);
  } finally {
    session.busy = false;
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/products', async (req, res) => {
  try {
    const products = await getProducts(req.query.page);
    res.json(products);
  } catch (error) {
    if (error instanceof EktApiError) {
      return res.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.upstreamStatus !== undefined && { upstreamStatus: error.upstreamStatus }),
        },
      });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера.' } });
  }
});

// Статический маршрут должен предшествовать /:id.
app.get('/api/products/search', async (req, res, next) => {
  try {
    res.json(await searchProducts(req.query.q));
  } catch (error) { next(error); }
});

app.get('/api/products/:id', async (req, res, next) => {
  try {
    res.json(await getProductById(req.params.id));
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  if (error instanceof EktApiError) return res.status(error.status).json({ error: {
    code: error.code, message: error.message,
    ...(error.upstreamStatus !== undefined && { upstreamStatus: error.upstreamStatus }),
  } });
  if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
    return res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: { code: 'INVALID_JSON', message: 'Передайте корректный JSON размером до 8 КБ.' } });
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера.' } });
});

app.listen(port, (error) => {
  if (error) {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Stop the previous server before restarting.`
      : 'Server could not start.');
    process.exitCode = 1;
    return;
  }
  console.log(`Server running at http://localhost:${port}`);
});
