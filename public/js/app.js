/**
 * Crash Game — frontend application
 *
 * Manages:
 *  • Socket.io connection + all game events
 *  • Authentication (JWT stored in localStorage)
 *  • Bet / Cancel / Cash-out actions
 *  • UI state machine mirroring the server's game states
 *  • Provably-fair section updates
 */

// ─── Logger ───────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[crash]';
function log(tag, msg, data)  { console.log(`${LOG_PREFIX} ${tag.padEnd(10)} ${msg}`, data !== undefined ? data : ''); }
function warn(tag, msg, data) { console.warn(`${LOG_PREFIX} ${tag.padEnd(10)} ${msg}`, data !== undefined ? data : ''); }
function err(tag, msg, data)  { console.error(`${LOG_PREFIX} ${tag.padEnd(10)} ${msg}`, data !== undefined ? data : ''); }

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  socket: null,
  token: null,
  username: null,
  balance: 0,

  phase: 'waiting',    // waiting | running | crashed
  roundId: 0,
  serverSeedHash: '',
  endsAt: null,        // waiting phase end (ms)
  startTime: null,     // running phase start (ms, server clock adjusted)
  currentMult: 1.00,
  crashPoint: null,
  serverSeed: null,

  myBet: null,         // { amount, autoCashout } | null
  myCashedOut: false,
  myCashoutMult: null,

  bets: new Map(),     // userId → { username, amount, cashedOut, cashedOutAt }
  history: [],         // recent rounds [{id, crashPoint}]

  countdownTimer: null,

  houseBalance: 0,
  myHistory: [],    // { roundId, amount, cashedOutAt, profit, won }
};

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Restore session
  const savedToken    = localStorage.getItem('crash_token');
  const savedUsername = localStorage.getItem('crash_username');
  const savedBalance  = localStorage.getItem('crash_balance');

  if (savedToken && savedUsername) {
    state.token    = savedToken;
    state.username = savedUsername;
    state.balance  = parseFloat(savedBalance) || 0;
    log('INIT', `session restored user=${savedUsername}`);
    _updateUserUI();
  } else {
    log('INIT', 'no saved session — connecting as guest');
  }

  _connect();
  _initChart();
  _addToastContainer();

  document.getElementById('fairBody').style.display = 'none';
});

// ─── Canvas chart ─────────────────────────────────────────────────────────────

let chart;

function _initChart() {
  const canvas = document.getElementById('chartCanvas');
  chart = new CrashChart(canvas);
}

// ─── Socket connection ────────────────────────────────────────────────────────

function _connect() {
  const socket = io({ auth: { token: state.token } }); // polling + websocket fallback
  state.socket = socket;

  socket.on('connect', () => {
    log('SOCKET', `connected id=${socket.id} transport=${socket.io.engine.transport.name}`);
  });

  socket.on('connect_error', (e) => {
    err('SOCKET', `connect_error: ${e.message}`);
  });

  socket.on('disconnect', reason => {
    warn('SOCKET', `disconnected reason=${reason}`);
    showToast('Connection lost — reconnecting…', 'warn');
  });

  // ── Game events ────────────────────────────────────────────────────────────

  socket.on('gameState', data => {
    log('EVENT', `gameState state=${data.state} round=${data.roundId} bets=${(data.bets||[]).length}`);
    _applyGameState(data);
  });

  socket.on('gameWaiting', data => {
    log('EVENT', `gameWaiting round=${data.roundId}`);
    state.phase         = 'waiting';
    state.roundId       = data.roundId;
    state.serverSeedHash = data.serverSeedHash;
    state.endsAt        = data.endsAt;
    state.crashPoint    = null;
    state.serverSeed    = null;
    state.myBet         = null;
    state.myCashedOut   = false;
    state.myCashoutMult = null;
    state.bets.clear();

    chart.reset();
    chart.clearCashoutMarker();
    if (data.houseBalance !== undefined) {
      state.houseBalance = data.houseBalance;
      _updateBankrollUI();
    }
    _renderPhase();
    _startCountdown();
    _updateFairSection();
    _renderBetsTable();
  });

  socket.on('gameRunning', data => {
    log('EVENT', `gameRunning round=${data.roundId}`);
    state.phase     = 'running';
    state.startTime = data.startTime;

    chart.startRunning(data.startTime);
    _renderPhase();
    _stopCountdown();
  });

  socket.on('gameTick', ({ multiplier, elapsed }) => {
    state.currentMult = multiplier;
    chart.addPoint(elapsed, multiplier);
    _updateMultiplierDisplay(multiplier);
    _updateLiveProfits(multiplier);
  });

  socket.on('gameCrash', data => {
    log('EVENT', `gameCrash round=${data.roundId} crashPoint=${data.crashPoint}x bets=${(data.bets||[]).length}`);
    state.phase      = 'crashed';
    state.crashPoint = data.crashPoint;
    state.serverSeed = data.serverSeed;

    chart.setCrash(data.crashPoint);
    _renderPhase();
    _updateFairSection();
    _updateBetsAfterCrash(data.bets);
    const card = document.querySelector('.game-card');
    if (card) { card.classList.add('crash-flash'); setTimeout(() => card.classList.remove('crash-flash'), 500); }

    // History pill
    state.history.unshift({ id: data.roundId, crashPoint: data.crashPoint });
    if (state.history.length > 30) state.history.pop();
    _renderHistory();
    _renderGameHistory();

    if (data.houseBalance !== undefined) {
      state.houseBalance = data.houseBalance;
      _updateBankrollUI();
    }

    // Was our bet still active?
    if (state.myBet && !state.myCashedOut) {
      showToast(`Crashed at ${data.crashPoint.toFixed(2)}× — lost ${state.myBet.amount.toFixed(2)}`, 'error');
      // Track loss in personal history
      state.myHistory.unshift({
        roundId: data.roundId,
        amount: state.myBet.amount,
        cashedOutAt: null,
        profit: -state.myBet.amount,
        won: false,
      });
      if (state.myHistory.length > 10) state.myHistory.pop();
      _renderMyHistory();
    }
  });

  socket.on('betPlaced', data => {
    state.bets.set(data.userId, {
      username:  data.username,
      amount:    data.amount,
      autoCashout: data.autoCashout,
      cashedOut: false,
      cashedOutAt: null,
    });
    _renderBetsTable();
  });

  socket.on('betCanceled', ({ userId }) => {
    state.bets.delete(userId);
    _renderBetsTable();
  });

  socket.on('playerCashout', ({ userId, username, multiplier, amount, profit }) => {
    const bet = state.bets.get(userId);
    if (bet) {
      bet.cashedOut   = true;
      bet.cashedOutAt = multiplier;
      bet.profit      = profit;
    }
    _renderBetsTable();
    if (username === state.username && state.myBet && !state.myCashedOut) {
      state.myCashedOut = true;
      state.myCashoutMult = multiplier;
      state.socket.emit('getBalance', {}, (r) => { if (!r.error) { state.balance = r.balance; _updateBalanceUI(); } });
      _renderPhase();
      const netProfit = profit - amount;
      showToast(`Auto cash-out at ${multiplier.toFixed(2)}× → +${netProfit.toFixed(2)} profit`, 'ok');
      showWinAnimation(multiplier, netProfit);
      // Track auto-cashout in personal history
      state.myHistory.unshift({
        roundId: state.roundId,
        amount: state.myBet.amount,
        cashedOutAt: multiplier,
        profit: profit - amount,
        won: true,
      });
      if (state.myHistory.length > 10) state.myHistory.pop();
      chart.setCashoutMarker(multiplier);
      _renderMyHistory();
    }
  });
}

// ─── Sync to existing game state (on (re)connect) ─────────────────────────────

function _applyGameState(data) {
  log('SYNC', `state=${data.state} round=${data.roundId} bets=${(data.bets||[]).length}`);
  state.phase          = data.state;
  state.roundId        = data.roundId;
  state.serverSeedHash = data.serverSeedHash;
  state.bets.clear();

  (data.bets || []).forEach(b => {
    state.bets.set(b.userId, {
      username:    b.username,
      amount:      b.amount,
      cashedOut:   b.cashedOut,
      cashedOutAt: b.cashedOutAt,
    });
  });

  if (data.state === 'waiting') {
    state.endsAt = data.endsAt;
    chart.reset();
    _startCountdown();
  } else if (data.state === 'running') {
    state.startTime    = data.startTime;
    state.currentMult  = data.currentMultiplier;
    chart.startRunning(data.startTime);
    chart.seedPoints(data.elapsed);
  } else if (data.state === 'crashed') {
    state.crashPoint = data.crashPoint;
    state.serverSeed = data.serverSeed;
    chart.seedPoints(Math.log(data.crashPoint) / GROWTH_RATE);
    chart.setCrash(data.crashPoint);
  }

  if (data.houseBalance !== undefined) {
    state.houseBalance = data.houseBalance;
    _updateBankrollUI();
  }

  _renderPhase();
  _renderBetsTable();
  _updateFairSection();

  // Load history
  fetch('/api/game/history')
    .then(r => r.json())
    .then(({ rounds }) => {
      state.history = rounds.map(r => ({ id: r.id, crashPoint: r.crashPoint }));
      _renderHistory();
      _renderGameHistory();
    })
    .catch(() => {});

  _renderMyHistory();
  _fetchPlayerHistory();
}

// ─── Phase rendering ──────────────────────────────────────────────────────────

function _renderPhase() {
  const { phase, crashPoint, myBet, myCashedOut } = state;

  const multBig    = document.getElementById('multiplierBig');
  const countdown  = document.getElementById('countdownBig');
  const crashedBig = document.getElementById('crashedBig');
  const actionBtn  = document.getElementById('actionBtn');
  const betInputs  = document.getElementById('betInputs');

  multBig.style.display    = 'none';
  countdown.style.display  = 'none';
  crashedBig.style.display = 'none';
  multBig.classList.remove('crashed');

  document.getElementById('roundIdDisplay').textContent = '#' + state.roundId;
  document.getElementById('fairRoundId').textContent    = '#' + state.roundId;

  if (phase === 'waiting') {
    countdown.style.display = 'block';
    _stopCountdown();
    _startCountdown();

    if (!state.token) {
      actionBtn.disabled = true;
      actionBtn.className = 'btn btn-action';
      actionBtn.textContent = 'Login to Bet';
      betInputs.style.opacity = '1';
      betInputs.style.pointerEvents = 'auto';
    } else if (myBet) {
      // Bet placed — cannot cancel
      actionBtn.disabled = true;
      actionBtn.className = 'btn btn-green btn-action';
      actionBtn.textContent = '✓ Bet Placed';
      betInputs.style.opacity = '0.4';
      betInputs.style.pointerEvents = 'none';
    } else {
      actionBtn.disabled = false;
      actionBtn.className = 'btn btn-green btn-action';
      actionBtn.textContent = 'Place Bet';
      betInputs.style.opacity = '1';
      betInputs.style.pointerEvents = 'auto';
    }

  } else if (phase === 'running') {
    multBig.style.display = 'block';
    _updateMultiplierDisplay(state.currentMult);

    if (myBet && !myCashedOut) {
      // User is actively playing — block inputs, show cashout
      actionBtn.disabled    = false;
      actionBtn.className   = 'btn btn-cashout btn-action';
      actionBtn.textContent = 'Cash Out';
      betInputs.style.opacity = '0.4';
      betInputs.style.pointerEvents = 'none';
    } else if (myBet && myCashedOut) {
      // Already cashed out — inputs free to prepare next bet
      actionBtn.disabled    = true;
      actionBtn.className   = 'btn btn-action';
      actionBtn.textContent = `✓ ${state.myCashoutMult ? state.myCashoutMult.toFixed(2) + '×' : 'Cashed Out'}`;
      betInputs.style.opacity = '1';
      betInputs.style.pointerEvents = 'auto';
    } else {
      // No active bet — allow editing inputs for next round
      actionBtn.disabled    = true;
      actionBtn.className   = 'btn btn-action';
      actionBtn.textContent = 'Next Round...';
      betInputs.style.opacity = '1';
      betInputs.style.pointerEvents = 'auto';
    }

  } else if (phase === 'crashed') {
    multBig.style.display = 'none';
    crashedBig.style.display = 'block';
    document.getElementById('crashedVal').textContent = crashPoint.toFixed(2);

    actionBtn.disabled    = true;
    actionBtn.className   = 'btn btn-action';
    actionBtn.textContent = 'Place Bet';
    betInputs.style.opacity = '1';
    betInputs.style.pointerEvents = 'auto';
  }
}

function _updateMultiplierDisplay(mult) {
  document.getElementById('multVal').textContent = mult.toFixed(2);
}

// ─── Countdown timer ──────────────────────────────────────────────────────────

function _startCountdown() {
  _stopCountdown();
  state.countdownTimer = setInterval(() => {
    if (state.phase !== 'waiting') { _stopCountdown(); return; }
    const remaining = Math.max(0, (state.endsAt - Date.now()) / 1000);
    document.getElementById('countdownVal').textContent = remaining.toFixed(1);
    if (remaining <= 0) _stopCountdown();
  }, 50);
}

function _stopCountdown() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}

// ─── Bet / Cancel / Cash-out ──────────────────────────────────────────────────

function handleAction() {
  const { phase, myBet } = state;
  if (phase === 'waiting' && !myBet) _placeBet();
  else if (phase === 'running' && myBet && !state.myCashedOut) _cashOut();
}

function _placeBet() {
  const amount     = parseFloat(document.getElementById('betAmount').value);
  const autoRaw    = document.getElementById('autoCashout').value.trim();
  const autoCashout = autoRaw ? parseFloat(autoRaw) : null;

  if (isNaN(amount) || amount <= 0) {
    showToast('Enter a valid bet amount', 'error'); return;
  }
  if (autoCashout !== null && (isNaN(autoCashout) || autoCashout < 1.01)) {
    showToast('Auto cash-out must be ≥ 1.01', 'error'); return;
  }

  log('ACTION', `placeBet amount=${amount} autoCashout=${autoCashout}`);
  if (autoCashout) chart.setAutoCashoutLine(autoCashout);
  state.socket.emit('placeBet', { amount, autoCashout }, (res) => {
    if (res.error) { err('ACTION', `placeBet failed: ${res.error}`); showToast(res.error, 'error'); return; }
    log('ACTION', `placeBet OK balance=${res.balance}`);
    state.myBet = { amount, autoCashout };
    state.balance = res.balance;
    _updateBalanceUI();
    _renderPhase();
    showToast(`Bet placed: ${amount.toFixed(2)} COINS`, 'ok');
  });
}


function _cashOut() {
  log('ACTION', `cashOut at mult=${state.currentMult}`);
  state.socket.emit('cashOut', {}, (res) => {
    if (res.error) { err('ACTION', `cashOut failed: ${res.error}`); showToast(res.error, 'error'); return; }
    log('ACTION', `cashOut OK at=${res.multiplier}x profit=${res.profit} balance=${res.balance}`);
    state.myCashedOut   = true;
    state.myCashoutMult = res.multiplier;
    state.balance       = res.balance;
    _updateBalanceUI();
    _renderPhase();
    chart.setCashoutMarker(res.multiplier);
    // Add to personal history
    state.myHistory.unshift({
      roundId: state.roundId,
      amount: state.myBet.amount,
      cashedOutAt: res.multiplier,
      profit: res.profit - state.myBet.amount,
      won: true,
    });
    if (state.myHistory.length > 10) state.myHistory.pop();
    _renderMyHistory();
    const netProfit = res.profit - state.myBet.amount;
    showWinAnimation(res.multiplier, netProfit);
    showToast(
      `Cashed out at ${res.multiplier.toFixed(2)}× → +${netProfit.toFixed(2)} profit`,
      'ok'
    );
  });
}

// ─── Bet amount helpers ───────────────────────────────────────────────────────

function adjustAmount(delta) {
  const el = document.getElementById('betAmount');
  const v  = parseFloat(el.value) || 0;
  el.value = Math.max(0.01, Math.round((v + delta) * 100) / 100);
}

function halfAmount() {
  const el = document.getElementById('betAmount');
  el.value = Math.max(0.01, Math.round(parseFloat(el.value) / 2 * 100) / 100);
}

function doubleAmount() {
  const el = document.getElementById('betAmount');
  el.value = Math.min(10000, Math.round(parseFloat(el.value) * 2 * 100) / 100);
}

// ─── Bets table ───────────────────────────────────────────────────────────────

function _renderBetsTable() {
  const tbody  = document.getElementById('betsTbody');
  const count  = document.getElementById('betCount');
  const bets   = Array.from(state.bets.entries());

  count.textContent = bets.length + ' bet' + (bets.length !== 1 ? 's' : '');

  if (bets.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No bets this round</td></tr>';
    return;
  }

  // Sort: cashed-out first (they won), then active
  bets.sort(([, a], [, b]) => (b.cashedOut ? 1 : 0) - (a.cashedOut ? 1 : 0));

  tbody.innerHTML = bets.map(([userId, b]) => {
    const atText  = b.cashedOut ? b.cashedOutAt.toFixed(2) + '×' : '—';
    let profitText, cls;
    if (b.cashedOut) {
      profitText = '+' + (b.profit - b.amount).toFixed(2);
      cls = 'win';
    } else if (state.phase === 'crashed') {
      profitText = '-' + b.amount.toFixed(2);
      cls = 'loss';
    } else if (state.phase === 'running') {
      const live = b.amount * state.currentMult - b.amount;
      profitText = '+' + live.toFixed(2);
      cls = 'live';
    } else {
      profitText = '—';
      cls = 'live';
    }

    return `<tr data-userid="${esc(String(userId))}">
      <td class="player-name">${esc(b.username || 'Guest')}</td>
      <td>${b.amount.toFixed(2)}</td>
      <td class="${cls}">${atText}</td>
      <td class="${cls} live-profit">${profitText}</td>
    </tr>`;
  }).join('');
}

function _updateLiveProfits(mult) {
  if (state.phase !== 'running') return;
  const tbody = document.getElementById('betsTbody');
  if (!tbody) return;
  for (const [userId, bet] of state.bets.entries()) {
    if (bet.cashedOut) continue;
    const cell = tbody.querySelector(`tr[data-userid="${userId}"] .live-profit`);
    if (cell) {
      cell.textContent = '+' + (bet.amount * mult - bet.amount).toFixed(2);
    }
  }
}

function _updateBetsAfterCrash(serverBets) {
  if (!serverBets) return;
  serverBets.forEach(sb => {
    const local = state.bets.get(sb.userId);
    if (local) {
      local.cashedOut   = sb.cashedOut;
      local.cashedOutAt = sb.cashedOutAt;
      local.profit      = sb.profit;
    }
  });
  _renderBetsTable();
}

// ─── History bar ──────────────────────────────────────────────────────────────

function _renderHistory() {
  const bar = document.getElementById('historyBar');
  const recent = state.history.slice(0, 20);

  bar.innerHTML = recent.map(r => {
    const cls   = crashClass(r.crashPoint);
    const label = r.crashPoint.toFixed(2) + '×';
    return `<span class="hist-pill ${cls}" title="Round #${r.id}">
      <span class="hist-dot"></span>${label}
    </span>`;
  }).join('');

  // Also update the top-3 in the game card
  const pills = document.getElementById('recentPills');
  pills.innerHTML = recent.slice(0, 5).map(r => {
    const cls = crashClass(r.crashPoint);
    return `<span class="hist-pill ${cls}" style="font-size:11px">
      <span class="hist-dot"></span>#${r.id} ${r.crashPoint.toFixed(2)}×
    </span>`;
  }).join('');
}

function crashClass(cp) {
  if (cp < 2)   return 'low';
  if (cp < 5)   return 'mid';
  if (cp < 10)  return 'high';
  return 'mega';
}

// ─── Provably fair section ────────────────────────────────────────────────────

function _updateFairSection() {
  document.getElementById('fairRoundId').textContent    = '#' + state.roundId;
  document.getElementById('fairServerHash').textContent = state.serverSeedHash || '—';

  const seedRow  = document.getElementById('fairSeedRow');
  const crashRow = document.getElementById('fairCrashRow');

  if (state.phase === 'crashed' && state.serverSeed) {
    seedRow.style.display  = 'flex';
    crashRow.style.display = 'flex';
    document.getElementById('fairServerSeed').textContent  = state.serverSeed;
    document.getElementById('fairCrashPoint').textContent  = state.crashPoint + '×';
  } else {
    seedRow.style.display  = 'none';
    crashRow.style.display = 'none';
  }
}

function toggleFair() {
  const body    = document.getElementById('fairBody');
  const toggle  = document.getElementById('fairToggle');
  const visible = body.style.display !== 'none';
  body.style.display   = visible ? 'none' : 'flex';
  toggle.textContent   = visible ? '▼' : '▲';
}

// ─── Authentication ───────────────────────────────────────────────────────────

function openAuthModal() {
  document.getElementById('authModal').style.display = 'flex';
}

function closeAuthModal() {
  document.getElementById('authModal').style.display = 'none';
  document.getElementById('loginError').textContent  = '';
  document.getElementById('regError').textContent    = '';
}

function switchTab(tab) {
  document.getElementById('formLogin').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('formRegister').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('tabLogin').classList.toggle('active', tab === 'login');
  document.getElementById('tabRegister').classList.toggle('active', tab === 'register');
}

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl    = document.getElementById('loginError');
  errEl.textContent = '';

  if (!username || !password) { errEl.textContent = 'Fill in all fields'; return; }

  try {
    log('AUTH', `login attempt user=${username}`);
    const res  = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { err('AUTH', `login failed: ${data.error}`); errEl.textContent = data.error; return; }
    log('AUTH', `login OK user=${data.username} balance=${data.balance}`);
    _saveSession(data);
    closeAuthModal();
    showToast(`Welcome back, ${data.username}!`);
  } catch (e) {
    err('AUTH', `login network error: ${e.message}`);
    errEl.textContent = 'Network error';
  }
}

async function doRegister() {
  const username = document.getElementById('regUsername').value.trim();
  const password = document.getElementById('regPassword').value;
  const errEl    = document.getElementById('regError');
  errEl.textContent = '';

  if (!username || !password) { errEl.textContent = 'Fill in all fields'; return; }

  try {
    log('AUTH', `register attempt user=${username}`);
    const res  = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { err('AUTH', `register failed: ${data.error}`); errEl.textContent = data.error; return; }
    log('AUTH', `register OK user=${data.username}`);
    _saveSession(data);
    closeAuthModal();
    showToast(`Account created! Welcome, ${data.username}!`);
  } catch (e) {
    err('AUTH', `register network error: ${e.message}`);
    errEl.textContent = 'Network error';
  }
}

function doLogout() {
  state.token    = null;
  state.username = null;
  state.balance  = 0;
  state.myBet    = null;
  localStorage.removeItem('crash_token');
  localStorage.removeItem('crash_username');
  localStorage.removeItem('crash_balance');

  // Reconnect as guest (drop auth token)
  state.socket.auth = {};
  state.socket.disconnect();
  state.socket.connect();

  state.myHistory = [];
  _renderMyHistory();
  _updateUserUI();
  _renderPhase();
  showToast('Logged out');
}

function _saveSession({ token, username, balance }) {
  state.token    = token;
  state.username = username;
  state.balance  = balance;
  localStorage.setItem('crash_token', token);
  localStorage.setItem('crash_username', username);
  localStorage.setItem('crash_balance', balance);

  log('AUTH', `session saved user=${username} — reconnecting socket with token`);
  // Reconnect with new token so server recognises us (socket.io v4 API)
  state.socket.auth = { token };
  state.socket.disconnect();
  state.socket.connect();

  _updateUserUI();
  _renderPhase();
  _fetchPlayerHistory();
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function _updateUserUI() {
  const balancePill = document.getElementById('balancePill');
  const btnAuth     = document.getElementById('btnAuth');
  const userChip    = document.getElementById('userChip');
  const usernameEl  = document.getElementById('usernameDisplay');
  const avatarEl    = document.getElementById('userAvatar');

  if (state.username) {
    balancePill.style.display = 'flex';
    btnAuth.style.display     = 'none';
    userChip.style.display    = 'flex';
    usernameEl.textContent    = state.username;
    avatarEl.textContent      = state.username[0].toUpperCase();
    _updateBalanceUI();
  } else {
    balancePill.style.display = 'none';
    btnAuth.style.display     = '';
    userChip.style.display    = 'none';
  }
}

function _updateBalanceUI() {
  document.getElementById('balanceAmount').textContent = state.balance.toFixed(2);
  localStorage.setItem('crash_balance', state.balance);
}

// ─── Toast notifications ──────────────────────────────────────────────────────

function _addToastContainer() {
  const div = document.createElement('div');
  div.id = 'toastContainer';
  document.body.appendChild(div);
}

function showToast(msg, type = 'ok') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : type === 'warn' ? ' warn' : '');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ─── Bankroll + Player history ────────────────────────────────────────────────

function _updateBankrollUI() {
  const el = document.getElementById('bankrollAmount');
  if (el) el.textContent = state.houseBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _fetchPlayerHistory() {
  if (!state.token || !state.socket) return;
  state.socket.emit('getPlayerHistory', {}, (res) => {
    if (res.error || !res.rounds) return;
    // Merge server rounds with client-tracked ones (server is source of truth)
    state.myHistory = res.rounds;
    _renderMyHistory();
  });
}

function _renderMyHistory() {
  const section = document.getElementById('playerHistorySection');
  const tbody   = document.getElementById('myHistoryTbody');
  const count   = document.getElementById('myHistoryCount');
  if (!section || !tbody) return;

  if (!state.token || state.myHistory.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  count.textContent = state.myHistory.length + ' round' + (state.myHistory.length !== 1 ? 's' : '');

  tbody.innerHTML = state.myHistory.slice(0, 10).map(r => {
    const cashText = r.cashedOutAt ? r.cashedOutAt.toFixed(2) + '×' : '—';
    const profitText = (r.profit >= 0 ? '+' : '') + r.profit.toFixed(2);
    const cls = r.won ? 'win' : 'loss';
    return `<tr>
      <td>#${r.roundId}</td>
      <td>${r.amount.toFixed(2)}</td>
      <td class="${cls}">${cashText}</td>
      <td class="${cls}">${profitText}</td>
    </tr>`;
  }).join('');
}

function _renderGameHistory() {
  const tbody = document.getElementById('gameHistoryTbody');
  if (!tbody || state.history.length === 0) return;

  // state.history has {id, crashPoint} — we need full data from server
  fetch('/api/game/history')
    .then(r => r.json())
    .then(({ rounds }) => {
      if (!rounds || rounds.length === 0) return;
      tbody.innerHTML = rounds.slice(0, 20).map(r => {
        const hashShort = r.serverSeedHash ? r.serverSeedHash.slice(0, 16) + '…' : '—';
        const hasData = r.serverSeed && r.serverSeedHash;
        return `<tr>
          <td>#${r.id}</td>
          <td class="${r.crashPoint < 2 ? 'loss' : r.crashPoint < 5 ? 'live' : 'win'}">${r.crashPoint.toFixed(2)}×</td>
          <td style="font-size:10px;font-family:monospace">${hashShort}</td>
          <td>${hasData
            ? `<button class="btn-verify" onclick="verifyRound(${r.id},'${r.serverSeed}','${r.serverSeedHash}',${r.crashPoint},this)">VERIFY</button>`
            : '—'
          }</td>
        </tr>`;
      }).join('');
    })
    .catch(() => {});
}

function verifyRound(roundId, serverSeed, serverSeedHash, crashPoint, btn) {
  btn.textContent = '...';
  const params = new URLSearchParams({ serverSeed, serverSeedHash, crashPoint });
  fetch(`/api/game/verify/${roundId}?${params}`)
    .then(r => r.json())
    .then(({ valid }) => {
      btn.textContent = valid ? '✓ VALID' : '✗ INVALID';
      btn.className = 'btn-verify ' + (valid ? 'valid' : 'invalid');
    })
    .catch(() => { btn.textContent = 'ERROR'; });
}

// ─── Win Animation ────────────────────────────────────────────────────────────

function showWinAnimation(multiplier, profit) {
  const el = document.createElement('div');
  el.className = 'win-screen';
  el.innerHTML = `
    <div class="win-content">
      <div class="win-title">★ WINNER ★</div>
      <div class="win-mult-display">${multiplier.toFixed(2)}×</div>
      <div class="win-profit-display">+ ${profit.toFixed(2)} COINS</div>
    </div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
  _spawnCoins();
}

function _spawnCoins() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5999;';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const palette = ['#ffd700','#ffaa00','#00ff88','#ffcc44','#ff8800'];
  const coins = Array.from({ length: 55 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * 180,
    vx: (Math.random() - 0.5) * 7,
    vy: Math.random() * 2 + 1,
    r: Math.random() * 9 + 4,
    rot: Math.random() * Math.PI * 2,
    vrot: (Math.random() - 0.5) * 0.18,
    color: palette[Math.floor(Math.random() * palette.length)],
  }));
  let start = null;
  (function frame(ts) {
    if (!start) start = ts;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let any = false;
    for (const c of coins) {
      c.x += c.vx; c.y += c.vy; c.vy += 0.13; c.rot += c.vrot;
      if (c.y < canvas.height + 30) any = true;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      const scaleY = Math.abs(Math.cos(c.rot * 3)) * 0.45 + 0.1;
      ctx.beginPath();
      ctx.ellipse(0, 0, c.r, c.r * scaleY, 0, 0, Math.PI * 2);
      ctx.fillStyle = c.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    if (any && ts - start < 3500) requestAnimationFrame(frame);
    else canvas.remove();
  })(0);
}

// ─── XSS-safe escaping ────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Enter key on login/register forms
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const modal = document.getElementById('authModal');
  if (modal.style.display === 'none') return;
  const loginVisible = document.getElementById('formLogin').style.display !== 'none';
  if (loginVisible) doLogin(); else doRegister();
});
