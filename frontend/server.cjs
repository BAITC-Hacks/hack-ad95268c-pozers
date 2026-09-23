const path = require('node:path');
const express = require('express');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const app = express();
app.use(express.static(__dirname, { dotfiles: 'deny' }));
const port = process.env.FRONTEND_PORT || 4173;
app.listen(port, 'localhost', error => {
  if (error) {
    console.error('Frontend could not start. Check that its port is available.');
    process.exitCode = 1;
    return;
  }
  console.log(`Frontend running at http://localhost:${port}`);
});
