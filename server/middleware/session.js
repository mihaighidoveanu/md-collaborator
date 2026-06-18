// Session-loading middleware, built against an injected db so the same logic
// runs in production and tests.
function createSessionMiddleware(db) {
  function requireSession(req, res, next) {
    const { token } = req.params;
    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);

    if (!session) return res.status(404).json({ error: 'Link not found.' });
    if (session.status === 'revoked') return res.status(403).json({ error: 'This link has been revoked.' });
    if (session.status !== 'active') return res.status(403).json({ error: 'This link is no longer active.' });

    req.session = session;
    next();
  }

  // Sessions never reach a terminal status (D4) — only 'active' or 'revoked'
  // exist — but this stays distinct from requireSession because it is meant
  // for read-only routes that should keep working for any non-revoked
  // session, regardless of future statuses requireSession might gate on.
  function requireNotRevoked(req, res, next) {
    const { token } = req.params;
    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);

    if (!session) return res.status(404).json({ error: 'Link not found.' });
    if (session.status === 'revoked') return res.status(403).json({ error: 'This link has been revoked.' });

    req.session = session;
    next();
  }

  return { requireSession, requireNotRevoked };
}

module.exports = createSessionMiddleware;
