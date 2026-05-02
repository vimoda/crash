const { EventEmitter } = require('events');
const { generateServerSeed, hashServerSeed, calculateCrashPoint } = require('./provably-fair');

const STATES = {
  WAITING: 'waiting',
  RUNNING: 'running',
  CRASHED: 'crashed',
};

const TICK_MS = 100;           // multiplier tick interval
const WAITING_MS = 7000;       // countdown before each round
const POST_CRASH_MS = 3000;    // pause between crash and next waiting phase
const GROWTH_RATE = 0.00006;   // multiplier = e^(GROWTH_RATE * elapsedMs), 2x ≈ 11.5s

class GameEngine extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.state = STATES.WAITING;
    this.roundId = 0;
    this.serverSeed = null;
    this.serverSeedHash = null;
    this.crashPoint = null;
    this.startTime = null;
    this.roundEndsAt = null;   // waiting phase end timestamp
    this.currentMultiplier = 1.00;
    // Map<userId, { username, amount, autoCashout, cashedOut, cashedOutAt, profit }>
    this.bets = new Map();
    this._tick = null;
    this._waitTimer = null;
    this._nextTimer = null;
  }

  start() {
    this._beginWaiting();
  }

  // ─── State transitions ────────────────────────────────────────────────────

  _beginWaiting() {
    this._clearTimers();
    this.state = STATES.WAITING;
    this.roundId += 1;
    this.serverSeed = generateServerSeed();
    this.serverSeedHash = hashServerSeed(this.serverSeed);
    this.crashPoint = calculateCrashPoint(this.serverSeed, this.roundId);
    this.currentMultiplier = 1.00;
    this.startTime = null;
    this.bets.clear();
    this.roundEndsAt = Date.now() + WAITING_MS;

    console.log(`[engine] WAITING  round=${this.roundId} crashPoint=${this.crashPoint.toFixed(2)} hash=${this.serverSeedHash.slice(0,12)}…`);

    this.emit('waiting', {
      roundId: this.roundId,
      serverSeedHash: this.serverSeedHash,
      endsAt: this.roundEndsAt,
      houseBalance: this.db.getHouseBalance(),
    });

    this._waitTimer = setTimeout(() => this._beginRunning(), WAITING_MS);
  }

  _beginRunning() {
    this._clearTimers();
    this.state = STATES.RUNNING;
    this.startTime = Date.now();
    this.currentMultiplier = 1.00;

    console.log(`[engine] RUNNING  round=${this.roundId} bets=${this.bets.size}`);

    this.emit('running', {
      roundId: this.roundId,
      serverSeedHash: this.serverSeedHash,
      startTime: this.startTime,
      houseBalance: this.db.getHouseBalance(),
    });

    this._tick = setInterval(() => this._onTick(), TICK_MS);
  }

  _onTick() {
    const elapsed = Date.now() - this.startTime;
    this.currentMultiplier = Math.max(1.00, Math.floor(100 * Math.exp(GROWTH_RATE * elapsed)) / 100);

    // Process any pending auto cash-outs before checking crash
    for (const [userId, bet] of this.bets.entries()) {
      if (!bet.cashedOut && bet.autoCashout !== null && this.currentMultiplier >= bet.autoCashout) {
        console.log(`[engine] AUTO-CASHOUT userId=${userId} at=${bet.autoCashout}x mult=${this.currentMultiplier}`);
        this._doCashOut(userId, bet.autoCashout);
      }
    }

    if (this.currentMultiplier >= this.crashPoint) {
      this._beginCrash();
      return;
    }

    this.emit('tick', { multiplier: this.currentMultiplier, elapsed });
  }

  _beginCrash() {
    this._clearTimers();
    this.state = STATES.CRASHED;

    // Persist round — losses are implicit (bets were deducted at placement)
    const betsSnapshot = Array.from(this.bets.entries()).map(([userId, b]) => ({
      userId,
      username: b.username,
      amount: b.amount,
      cashedOut: b.cashedOut,
      cashedOutAt: b.cashedOutAt,
      profit: b.profit,
    }));

    const winners = betsSnapshot.filter(b => b.cashedOut).length;
    console.log(`[engine] CRASHED  round=${this.roundId} crashPoint=${this.crashPoint.toFixed(2)} bets=${betsSnapshot.length} winners=${winners}`);

    this.db.addRound({
      id: this.roundId,
      serverSeed: this.serverSeed,
      serverSeedHash: this.serverSeedHash,
      crashPoint: this.crashPoint,
      bets: betsSnapshot,
    });

    for (const [userId, b] of this.bets.entries()) {
      this.db.addPlayerRound(userId, {
        roundId: this.roundId,
        amount: b.amount,
        cashedOutAt: b.cashedOut ? b.cashedOutAt : null,
        profit: b.cashedOut ? b.profit - b.amount : -b.amount,
        won: b.cashedOut,
      });
    }

    this.emit('crash', {
      roundId: this.roundId,
      crashPoint: this.crashPoint,
      serverSeed: this.serverSeed,      // revealed for provably-fair verification
      serverSeedHash: this.serverSeedHash,
      bets: betsSnapshot,
      houseBalance: this.db.getHouseBalance(),
    });

    this._nextTimer = setTimeout(() => this._beginWaiting(), POST_CRASH_MS);
  }

  // ─── Player actions ───────────────────────────────────────────────────────

  placeBet(userId, username, amount, autoCashout = null) {
    if (this.state !== STATES.WAITING) {
      throw new Error('Bets are only accepted during the waiting phase');
    }
    if (this.bets.has(userId)) {
      throw new Error('You already have a bet on this round');
    }

    const numAmount = parseFloat(amount);
    if (!Number.isFinite(numAmount) || numAmount < 0.01 || numAmount > 10000) {
      throw new Error('Bet amount must be between 0.01 and 10,000');
    }

    let numAuto = null;
    if (autoCashout !== null && autoCashout !== '' && autoCashout !== undefined) {
      numAuto = parseFloat(autoCashout);
      if (!Number.isFinite(numAuto) || numAuto < 1.01) {
        throw new Error('Auto cash-out must be ≥ 1.01');
      }
    }

    const user = this.db.findUserById(userId);
    if (!user) throw new Error('User not found');

    const housebal = this.db.getHouseBalance();
    const maxBet = Math.min(10000, Math.floor(housebal * 0.01 * 100) / 100);
    if (numAmount > maxBet) {
      throw new Error(`Max bet is ${maxBet.toFixed(2)} (1% of house bankroll)`);
    }

    const rounded = Math.round(numAmount * 100) / 100;
    if (user.balance < rounded) throw new Error('Insufficient balance');

    // Deduct immediately — loss is confirmed at crash, win is credited at cash-out
    this.db.updateBalance(userId, -rounded);
    this.db.updateHouseBalance(rounded);

    this.bets.set(userId, {
      username,
      amount: rounded,
      autoCashout: numAuto,
      cashedOut: false,
      cashedOutAt: null,
      profit: 0,
    });

    console.log(`[engine] BET      userId=${userId} amount=${rounded} autoCashout=${numAuto} round=${this.roundId}`);
    return { amount: rounded, autoCashout: numAuto };
  }

  // Queue bet for next round
  queueBet(userId, username, amount, autoCashout = null) {
    const existing = this.pendingBets && this.pendingBets.get(userId);
    if (existing) {
      throw new Error('You already have a queued bet');
    }
    const numAmount = parseFloat(amount);
    if (!Number.isFinite(numAmount) || numAmount < 0.01 || numAmount > 10000) {
      throw new Error('Bet amount must be between 0.01 and 10,000');
    }
    let numAuto = null;
    if (autoCashout !== null && autoCashout !== '' && autoCashout !== undefined) {
      numAuto = parseFloat(autoCashout);
      if (!Number.isFinite(numAuto) || numAuto < 1.01) {
        throw new Error('Auto cash-out must be ≥ 1.01');
      }
    }
    if (!this.pendingBets) this.pendingBets = new Map();
    this.pendingBets.set(userId, {
      username,
      amount: Math.round(numAmount * 100) / 100,
      autoCashout: numAuto,
    });
    console.log(`[engine] QUEUE   userId=${userId} amount=${Math.round(numAmount * 100) / 100} autoCashout=${numAuto}`);
    return { amount: Math.round(numAmount * 100) / 100, autoCashout: numAuto };
  }

  // Process queued bets when entering waiting phase
  _processQueuedBets() {
    if (!this.pendingBets || this.pendingBets.size === 0) return;
    for (const [userId, q] of this.pendingBets.entries()) {
      const user = this.db.findUserById(userId);
      if (!user) continue;
      if (user.balance < q.amount) {
        console.log(`[engine] QUEUESKIP userId=${userId} insufficient balance`);
        continue;
      }
      const housebal = this.db.getHouseBalance();
      const maxBet = Math.min(10000, Math.floor(housebal * 0.01 * 100) / 100);
      if (q.amount > maxBet) {
        console.log(`[engine] QUEUESKIP userId=${userId} bet exceeds max`);
        continue;
      }
      this.db.updateBalance(userId, -q.amount);
      this.db.updateHouseBalance(q.amount);
      this.bets.set(userId, {
        username: q.username,
        amount: q.amount,
        autoCashout: q.autoCashout,
        cashedOut: false,
        cashedOutAt: null,
        profit: 0,
      });
      console.log(`[engine] QUEUEAPPLY userId=${userId} amount=${q.amount} round=${this.roundId}`);
      io.emit('betPlaced', {
        userId,
        username: q.username,
        amount: q.amount,
        autoCashout: q.autoCashout,
      });
    }
    this.pendingBets.clear();
  }

  // Get pending bet for user
  getQueuedBet(userId) {
    if (!this.pendingBets) return null;
    return this.pendingBets.get(userId) || null;
  }

  // Remove queued bet
  cancelQueuedBet(userId) {
    if (this.pendingBets) {
      this.pendingBets.delete(userId);
    }
  }

  cancelBet() {
    throw new Error('Bets cannot be cancelled once placed');
  }

  cashOut(userId) {
    if (this.state !== STATES.RUNNING) {
      throw new Error('Cannot cash out right now');
    }
    const bet = this.bets.get(userId);
    if (!bet) throw new Error('No active bet this round');
    if (bet.cashedOut) throw new Error('Already cashed out');
    return this._doCashOut(userId, this.currentMultiplier);
  }

  _doCashOut(userId, multiplier) {
    const bet = this.bets.get(userId);
    if (!bet || bet.cashedOut) return null;

    bet.cashedOut = true;
    bet.cashedOutAt = multiplier;
    // payout = bet * multiplier; profit = payout - bet
    bet.profit = Math.round(bet.amount * multiplier * 100) / 100;

    this.db.updateBalance(userId, bet.profit);
    this.db.updateHouseBalance(-bet.profit);

    console.log(`[engine] CASHOUT  userId=${userId} at=${multiplier.toFixed(2)}x amount=${bet.amount} payout=${bet.profit}`);

    this.emit('cashout', {
      userId,
      username: bet.username,
      multiplier,
      amount: bet.amount,
      profit: bet.profit,
    });

    return bet;
  }

  // ─── State snapshot (for new connections) ────────────────────────────────

  getState() {
    const betsArr = Array.from(this.bets.entries()).map(([userId, b]) => ({
      userId,
      username: b.username,
      amount: b.amount,
      cashedOut: b.cashedOut,
      cashedOutAt: b.cashedOutAt,
    }));

    const base = {
      state: this.state,
      roundId: this.roundId,
      serverSeedHash: this.serverSeedHash,
      bets: betsArr,
      houseBalance: this.db.getHouseBalance(),
    };

    if (this.state === STATES.WAITING) {
      return { ...base, endsAt: this.roundEndsAt };
    }
    if (this.state === STATES.RUNNING) {
      return {
        ...base,
        startTime: this.startTime,
        currentMultiplier: this.currentMultiplier,
        elapsed: Date.now() - this.startTime,
      };
    }
    // CRASHED
    return {
      ...base,
      crashPoint: this.crashPoint,
      serverSeed: this.serverSeed,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _clearTimers() {
    clearInterval(this._tick);
    clearTimeout(this._waitTimer);
    clearTimeout(this._nextTimer);
    this._tick = null;
    this._waitTimer = null;
    this._nextTimer = null;
  }
}

module.exports = { GameEngine, STATES, GROWTH_RATE };
