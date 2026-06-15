const express = require('express');
const path = require('path');
const createAdminRouter = require('./routes/admin');
const createReviewRouter = require('./routes/review');

// Build the Express app with its dependencies injected. Production wires the
// real database and GitHub adapter; tests wire an in-memory db and a fake
// GitHub, exercising the same routes without touching the network.
function createApp({ db, github }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  app.use('/admin', createAdminRouter({ db, github }));
  app.use('/review', createReviewRouter({ db, github }));

  return app;
}

module.exports = createApp;
