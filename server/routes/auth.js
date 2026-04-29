const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

module.exports = function authRouter(db, jwtSecret) {
  const router = express.Router();

  router.post('/register', async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–20 alphanumeric characters or underscores' });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (db.findUserByUsername(username)) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = db.createUser(username, passwordHash);
    const token = signToken(user, jwtSecret);

    return res.status(201).json({ token, username: user.username, balance: user.balance });
  });

  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.findUserByUsername(username);
    if (!user) {
      // Constant-time comparison to avoid user enumeration
      await bcrypt.hash('dummy', 12);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(String(password), user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user, jwtSecret);
    return res.json({ token, username: user.username, balance: user.balance });
  });

  return router;
};

function signToken(user, secret) {
  return require('jsonwebtoken').sign(
    { userId: user.id, username: user.username },
    secret,
    { expiresIn: '7d' }
  );
}
