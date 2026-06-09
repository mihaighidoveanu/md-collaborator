const db = require('../db');

function requireSession(req, res, next) {
  const { token } = req.params;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);

  if (!session) return res.status(404).json({ error: 'Link not found.' });
  if (session.status === 'revoked') return res.status(403).json({ error: 'This link has been revoked.' });
  if (session.status === 'approved') return res.status(403).json({ error: 'Changes have already been approved.' });
  if (session.status !== 'active') return res.status(403).json({ error: 'This link is no longer active.' });

  req.session = session;
  next();
}

function requireActiveOrApproved(req, res, next) {
  const { token } = req.params;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);

  if (!session) return res.status(404).json({ error: 'Link not found.' });
  if (session.status === 'revoked') return res.status(403).json({ error: 'This link has been revoked.' });

  req.session = session;
  next();
}

module.exports = { requireSession, requireActiveOrApproved };
