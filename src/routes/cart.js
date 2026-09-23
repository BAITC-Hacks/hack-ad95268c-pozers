const express = require('express');
const { randomBytes } = require('node:crypto');
const { createCartService, CartError } = require('../services/cart');

const cookieName = 'ekt_cart_session';
const sessionLifetime = 24 * 60 * 60 * 1000;

function createCartRouter(getProductById) {
  const router = express.Router();
  const sessions = new Map();
  const cart = createCartService(getProductById);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const now = Date.now();
    for (const [id, session] of sessions) if (!session.active && session.expiresAt <= now) sessions.delete(id);
    const id = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    let session = sessions.get(id);
    if (!session) {
      if (sessions.size >= 1000) return next(new CartError('CART_LIMIT', 'Сервис корзины занят. Повторите позже.', 503));
      session = { id: randomBytes(32).toString('hex'), items: new Map(), proposals: new Map(), queue: Promise.resolve(), active: 0 };
      sessions.set(session.id, session);
    }
    session.expiresAt = now + sessionLifetime;
    res.cookie(cookieName, session.id, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/api/cart', maxAge: sessionLifetime });
    req.cartSession = session;
    next();
  });

  function handle(operation, status = 200) {
    return async (req, res, next) => {
      const session = req.cartSession;
      session.active++;
      // Serialize per session, including asynchronous detail fetches. Separate sessions do not block each other.
      const result = session.queue.then(() => operation(session, req.body));
      session.queue = result.catch(() => {});
      try { res.status(status).json(await result); } catch (error) { next(error); }
      finally { session.active--; }
    };
  }
  router.get('/', handle(session => cart.snapshot(session)));
  router.post('/proposals', handle((session, body) => cart.propose(session, body), 201));
  router.post('/confirm', handle((session, body) => cart.confirm(session, body?.proposalId)));
  router.post('/cancel', handle((session, body) => cart.cancel(session, body?.proposalId)));
  // Preserve the existing cart's Remove button without a browser-only mutation.
  router.post('/remove', handle((session, body) => cart.remove(session, body?.productId)));
  return router;
}

module.exports = { createCartRouter };
