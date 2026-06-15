require('dotenv').config();
const createApp = require('./app');
const createDb = require('./db');
const github = require('./github');

const db = createDb(process.env.DB_PATH || './data/sessions.db');
const app = createApp({ db, github });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`md-collaborator running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
});
