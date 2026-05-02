# AGENTS.md

## Key commands
- `npm start` — production server
- `npm run dev` — dev with nodemon (auto-restart on file changes)

## Important notes
- **No test suite, no linter** — verify manually
- **In-memory DB** — all data lost on server restart
- **JWT_SECRET** — auto-generated on startup; existing tokens invalid after restart unless `JWT_SECRET` env var is set

## Verification workflow
After any code changes:
1. Run `npm run dev` to start server
2. Open `http://localhost:3000` in browser
3. Test game flow: register → login → place bet → wait for crash → verify payout

## Architecture to know
- `server/game/engine.js` — core game state machine (waiting → running → crashed)
- `server/game/provably-fair.js` — crash point calculation (HMAC-SHA256)
- `server/db/index.js` — in-memory user/round storage (Map structures)
- `public/js/app.js` — frontend socket logic and UI state