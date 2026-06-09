require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use('/admin', require('./routes/admin'));
app.use('/review', require('./routes/review'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`md-collaborator running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
});
