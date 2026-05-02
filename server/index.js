const crypto = require('crypto');
const path = require('path');
const http = require('http');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { Server: SocketIO } = require('socket.io');

const db = require('./db');
const authRouter = require('./routes/auth');
const { GameEngine } = require('./game/engine');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,   // take full control — avoids Helmet's script-src-attr:'none'
    directives: {
      defaultSrc:       ["'self'"],
      scriptSrc:        ["'self'", "'unsafe-inline'"],
      scriptSrcAttr:    ["'unsafe-inline'"], // allow onclick= handlers in HTML
      connectSrc:       ["'self'", 'ws:', 'wss:'],
      styleSrc:         ["'self'", "'unsafe-inline'"],
      imgSrc:           ["'self'", 'data:'],
      objectSrc:        ["'none'"],
      baseUri:          ["'self'"],
      formAction:       ["'self'"],
      frameAncestors:   ["'self'"],
    },
  },
}));

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '10kb' }));

// Rate limiters
const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many auth attempts, try again later' } });

app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);

// Static frontend
app.use(express.static(path.join(__dirname, '../public')));

// Auth routes
app.use('/api/auth', authRouter(db, JWT_SECRET));

// Game history (public)
app.get('/api/game/history', (_req, res) => {
  const rounds = db.getRecentRounds(30).map(r => ({
    id: r.id,
    crashPoint: r.crashPoint,
    serverSeedHash: r.serverSeedHash,
    serverSeed: r.serverSeed, // revealed — verifiable
  }));
  res.json({ rounds });
});

// Verify a past round
app.get('/api/game/verify/:roundId', (req, res) => {
  const { verifyRound } = require('./game/provably-fair');
  const { serverSeed, serverSeedHash, crashPoint } = req.query;
  const roundId = parseInt(req.params.roundId, 10);
  if (!serverSeed || !serverSeedHash || !crashPoint || isNaN(roundId)) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  const ok = verifyRound(serverSeed, serverSeedHash, roundId, parseFloat(crashPoint));
  res.json({ valid: ok });
});

// ─── HTTP + Socket.io ─────────────────────────────────────────────────────────

const httpServer = http.createServer(app);

const io = new SocketIO(httpServer, {
  cors: { origin: '*' },
  pingInterval: 10_000,
  pingTimeout: 5_000,
});

// Socket auth middleware — guests allowed (no userId set)
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.userId = payload.userId;
      socket.username = payload.username;
      console.log(`[socket] auth OK  id=${socket.id} user=${payload.username}`);
    } catch (err) {
      console.warn(`[socket] auth FAIL id=${socket.id} err="${err.message}" — treating as guest`);
    }
  }
  next();
});

// ─── Game engine ──────────────────────────────────────────────────────────────

const game = new GameEngine(db);

game.on('waiting', data => io.emit('gameWaiting', data));
game.on('running', data => io.emit('gameRunning', data));
game.on('tick',    data => io.emit('gameTick', data));
game.on('crash',   data => io.emit('gameCrash', data));
game.on('cashout', data => io.emit('playerCashout', data));

// ─── Socket event handlers ────────────────────────────────────────────────────

// Simple per-socket rate limit map
const socketActionTimes = new WeakMap();

function socketRateLimit(socket, action, minIntervalMs) {
  const times = socketActionTimes.get(socket) || {};
  const last = times[action] || 0;
  if (Date.now() - last < minIntervalMs) return false;
  times[action] = Date.now();
  socketActionTimes.set(socket, times);
  return true;
}

io.on('connection', socket => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log(`[socket] CONNECT  id=${socket.id} ip=${ip} user=${socket.username || 'guest'}`);

  // Send current game state so the client can sync immediately
  const state = game.getState();
  console.log(`[socket] SYNC     id=${socket.id} gameState=${state.state} round=${state.roundId}`);
  socket.emit('gameState', state);

  socket.on('disconnect', reason => {
    console.log(`[socket] DISCONN  id=${socket.id} user=${socket.username || 'guest'} reason=${reason}`);
  });

  socket.on('error', err => {
    console.error(`[socket] ERROR    id=${socket.id} err="${err.message}"`);
  });

  // ── Place bet ────────────────────────────────────────────────────────────
  socket.on('placeBet', ({ amount, autoCashout } = {}, cb) => {
    if (typeof cb !== 'function') return;

    if (!socket.userId) return cb({ error: 'You must be logged in to bet' });
    if (!socketRateLimit(socket, 'placeBet', 500)) {
      console.warn(`[socket] RATELIMIT placeBet id=${socket.id}`);
      return cb({ error: 'Too fast' });
    }

    try {
      const result = game.placeBet(socket.userId, socket.username, amount, autoCashout);
      const user = db.findUserById(socket.userId);

      io.emit('betPlaced', {
        userId: socket.userId,
        username: socket.username,
        amount: result.amount,
        autoCashout: result.autoCashout,
      });

      cb({ ok: true, balance: user.balance });
    } catch (err) {
      console.warn(`[socket] placeBet ERR id=${socket.id} err="${err.message}"`);
      cb({ error: err.message });
    }
  });

  // ── Cash out ─────────────────────────────────────────────────────────────
  socket.on('cashOut', (_, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.userId) return cb({ error: 'Not authenticated' });
    if (!socketRateLimit(socket, 'cashOut', 200)) {
      console.warn(`[socket] RATELIMIT cashOut id=${socket.id}`);
      return cb({ error: 'Too fast' });
    }

    try {
      const result = game.cashOut(socket.userId);
      const user = db.findUserById(socket.userId);
      cb({ ok: true, multiplier: result.cashedOutAt, profit: result.profit, balance: user.balance });
    } catch (err) {
      console.warn(`[socket] cashOut ERR id=${socket.id} err="${err.message}"`);
      cb({ error: err.message });
    }
  });

  // ── Get balance ──────────────────────────────────────────────────────────
  socket.on('getBalance', (_, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.userId) return cb({ error: 'Not authenticated' });
    const user = db.findUserById(socket.userId);
    if (!user) return cb({ error: 'User not found' });
    cb({ balance: user.balance });
  });

  // ── Get player history ───────────────────────────────────────────────────
  socket.on('getPlayerHistory', (_, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.userId) return cb({ error: 'Not authenticated' });
    cb({ rounds: db.getPlayerRounds(socket.userId, 10) });
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

game.start();

httpServer.listen(PORT, () => {
  console.log(`[crash] server listening on http://localhost:${PORT}`);
});
