# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # production
npm run dev        # dev with nodemon (auto-restart)
```

No test suite, no linter configured.

## Architecture

Full-stack provably fair Crash multiplier game. Node.js/Express + Socket.io backend, vanilla JS frontend. No framework, no build step.

```
server/
  index.js              # Express app, Socket.io, JWT middleware, game event bridge
  db/index.js           # In-memory store (Map) — data lost on restart
  game/engine.js        # GameEngine (EventEmitter), state machine
  game/provably-fair.js # Crash point math
  routes/auth.js        # POST /api/auth/register, POST /api/auth/login

public/
  index.html
  js/app.js             # All frontend logic — socket events, auth, UI state machine
  js/chart.js           # Canvas-based multiplier chart
  css/style.css
```

### Game loop (engine.js)

State machine: `waiting → running → crashed → waiting`.

- **waiting** (7s): bets accepted, server seed committed (hash published, seed hidden)
- **running** (tick every 100ms): multiplier = `e^(GROWTH_RATE * elapsed)`, auto cash-outs processed, crash checked
- **crashed**: server seed revealed for provably-fair verification, round persisted to in-memory DB

Constants: `WAITING_MS=7000`, `POST_CRASH_MS=3000`, `GROWTH_RATE=0.00006` (2× ≈ 11.5s).

### Provably fair (provably-fair.js)

Crash point derived from `HMAC-SHA256(serverSeed, roundId)`. First 52 bits → integer `h`. House edge: if `h % 100 === 0` → instant crash at 1.00×. Otherwise `floor(100 * 2^52 / (2^52 - h)) / 100`. Players verify post-round: `SHA256(serverSeed) === serverSeedHash` then recompute crash.

### Socket.io events

Server → client: `gameState` (on connect), `gameWaiting`, `gameRunning`, `gameTick`, `gameCrash`, `betPlaced`, `betCanceled`, `playerCashout`.

Client → server (all use acknowledgement callbacks): `placeBet`, `cancelBet`, `cashOut`, `getBalance`.

### Auth

JWT stored in `localStorage` (`crash_token`). After login/logout, socket disconnects and reconnects with new `socket.auth.token` so server re-evaluates identity. Guests can watch but cannot bet. `JWT_SECRET` is random on startup unless `process.env.JWT_SECRET` is set — tokens invalidate on restart.

### DB

Pure in-memory (`server/db/index.js`). Users stored in two Maps (by username and by UUID). Rounds stored in a ring buffer (last 100). Production would replace with PostgreSQL/Redis.

### Balance accounting

Bet deducted immediately at placement. Cash-out credits `bet * multiplier`. Losses are implicit (no credit on crash). All amounts rounded to 2 decimal places via `Math.round(x * 100) / 100`.

## Key env vars

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3000` | HTTP listen port |
| `JWT_SECRET` | random 64-byte hex | Set in prod to persist sessions across restarts |
