const express = require('express');
const ektApi = require('./services/ektApi');
const { createAiAssistant, AiError } = require('./services/ai');
const { createProductSearch } = require('./services/productSearch');

// Передача зависимостей позволяет проверять HTTP-маршруты без внешних API.
function createApp({ catalog = ektApi, searchProducts = createProductSearch(catalog.getProducts), aiClient } = {}) {
  const app = express();
  const { getProducts, getProductById } = catalog;
  const { EktApiError } = ektApi;
  const chat = createAiAssistant({ searchProducts, getProductById, client: aiClient });

  app.use(express.json({ limit: '8kb' }));

  app.post('/api/chat', async (req, res, next) => {
    if (typeof req.body?.message !== 'string' || !req.body.message.trim() || req.body.message.length > 2000) {
      return res.status(400).json({ error: { code: 'INVALID_MESSAGE', message: 'Передайте непустое поле message длиной до 2000 символов.' } });
    }
    res.set('Cache-Control', 'no-store');
    try {
      res.json(await chat(req.body.message.trim()));
    } catch (error) {
      next(error);
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
    if (error instanceof EktApiError || error instanceof AiError) return res.status(error.status).json({ error: {
      code: error.code, message: error.message,
      ...(error.upstreamStatus !== undefined && { upstreamStatus: error.upstreamStatus }),
    } });
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: { code: 'INVALID_JSON', message: 'Передайте корректный JSON размером до 8 КБ.' } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера.' } });
  });

  return app;
}

if (require.main === module) {
  require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
  const port = process.env.PORT || 3000;
  createApp().listen(port, (error) => {
    if (error) {
      console.error(error.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Stop the previous server before restarting.`
        : 'Server could not start.');
      process.exitCode = 1;
      return;
    }
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = { createApp };
