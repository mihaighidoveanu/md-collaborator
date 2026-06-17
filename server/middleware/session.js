// Session-loading middleware, built against an injected db so the same logic
// runs in production and tests.
function createSessionMiddleware(db) {
  function requireSession(req, res, next) {
    const { token } = req.params;
    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);

    if (!session) return res.status(404).json({ error: 'Link not found.' });
    if (session.status === 'revoked') return res.status(403).json({ error: 'This link has been revoked.' });
    if (session.status === 'submitted') return res.status(403).json({ error: 'This review has already been submitted.' });
    if (session.status !== 'active') return res.status(403).json({ error: 'This link is no longer active.' });

    req.session = session;
    next();
  }

  function requireActiveOrSubmitted(req, res, next) {
    const { token } = req.params;
    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);

    if (!session) return res.status(404).json({ error: 'Link not found.' });
    if (session.status === 'revoked') return res.status(403).json({ error: 'This link has been revoked.' });

    req.session = session;
    next();
  }

  return { requireSession, requireActiveOrSubmitted };
}

module.exports = createSessionMiddleware;
