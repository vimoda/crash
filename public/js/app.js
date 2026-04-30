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
    _updateUserUI();
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
    console.log('[socket] connected', socket.id);
  });

  socket.on('disconnect', reason => {
    console.warn('[socket] disconnected:', reason);
    showToast('Connection lost — reconnecting…', 'warn');
  });

  // ── Game events ────────────────────────────────────────────────────────────

  socket.on('gameState', data => _applyGameState(data));

  socket.on('gameWaiting', data => {
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
    _renderPhase();
    _startCountdown();
    _updateFairSection();
    _renderBetsTable();
  });

  socket.on('gameRunning', data => {
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
  });

  socket.on('gameCrash', data => {
    state.phase      = 'crashed';
    state.crashPoint = data.crashPoint;
    state.serverSeed = data.serverSeed;

    chart.setCrash(data.crashPoint);
    _renderPhase();
    _updateFairSection();
    _updateBetsAfterCrash(data.bets);

    // History pill
    state.history.unshift({ id: data.roundId, crashPoint: data.crashPoint });
    if (state.history.length > 30) state.history.pop();
    _renderHistory();

    // Was our bet still active?
    if (state.myBet && !state.myCashedOut) {
      showToast(`Crashed at ${data.crashPoint.toFixed(2)}× — lost ${state.myBet.amount.toFixed(2)}`, 'error');
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
  });
}

// ─── Sync to existing game state (on (re)connect) ─────────────────────────────

function _applyGameState(data) {
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

  _renderPhase();
  _renderBetsTable();
  _updateFairSection();

  // Load history
  fetch('/api/game/history')
    .then(r => r.json())
    .then(({ rounds }) => {
      state.history = rounds.map(r => ({ id: r.id, crashPoint: r.crashPoint }));
      _renderHistory();
    })
    .catch(() => {});
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
    actionBtn.disabled = !state.token;
    actionBtn.className = 'btn btn-green btn-action';
    actionBtn.textContent = myBet ? 'Cancel Bet' : 'Place Bet';
    if (myBet) actionBtn.className = 'btn btn-cancel btn-action';
    betInputs.style.opacity  = myBet ? '0.4' : '1';
    betInputs.style.pointerEvents = myBet ? 'none' : 'auto';
    _stopCountdown();
    _startCountdown();

  } else if (phase === 'running') {
    multBig.style.display = 'block';
    _updateMultiplierDisplay(state.currentMult);

    if (myBet && !myCashedOut) {
      actionBtn.disabled    = false;
      actionBtn.className   = 'btn btn-cashout btn-action';
      actionBtn.textContent = 'Cash Out';
    } else if (myBet && myCashedOut) {
      actionBtn.disabled    = true;
      actionBtn.className   = 'btn btn-action';
      actionBtn.textContent = `✓ Cashed ${state.myCashoutMult ? state.myCashoutMult.toFixed(2) + '×' : 'out'}`;
    } else {
      actionBtn.disabled    = true;
      actionBtn.className   = 'btn btn-action';
      actionBtn.textContent = 'In Progress';
    }
    betInputs.style.opacity  = '0.4';
    betInputs.style.pointerEvents = 'none';

  } else if (phase === 'crashed') {
    multBig.style.display = 'none';
    crashedBig.style.display = 'block';
    document.getElementById('crashedVal').textContent = crashPoint.toFixed(2);

    actionBtn.disabled    = true;
    actionBtn.className   = 'btn btn-action';
    actionBtn.textContent = 'Place Bet';
    betInputs.style.opacity  = '0.4';
    betInputs.style.pointerEvents = 'none';
  }

  if (!state.token) {
    actionBtn.disabled = true;
    actionBtn.textContent = phase === 'waiting' ? 'Login to Bet' : actionBtn.textContent;
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
  if (phase === 'waiting') {
    if (myBet) _cancelBet(); else _placeBet();
  } else if (phase === 'running') {
    _cashOut();
  }
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

  state.socket.emit('placeBet', { amount, autoCashout }, (res) => {
    if (res.error) { showToast(res.error, 'error'); return; }
    state.myBet = { amount, autoCashout };
    state.balance = res.balance;
    _updateBalanceUI();
    _renderPhase();
    showToast(`Bet placed: ${amount.toFixed(2)} COINS`, 'ok');
  });
}

function _cancelBet() {
  state.socket.emit('cancelBet', {}, (res) => {
    if (res.error) { showToast(res.error, 'error'); return; }
    state.myBet   = null;
    state.balance = res.balance;
    _updateBalanceUI();
    _renderPhase();
    showToast('Bet cancelled', 'warn');
  });
}

function _cashOut() {
  state.socket.emit('cashOut', {}, (res) => {
    if (res.error) { showToast(res.error, 'error'); return; }
    state.myCashedOut   = true;
    state.myCashoutMult = res.multiplier;
    state.balance       = res.balance;
    _updateBalanceUI();
    _renderPhase();
    const profit = res.profit - state.myBet.amount;
    showToast(
      `Cashed out at ${res.multiplier.toFixed(2)}× → +${profit.toFixed(2)} profit`,
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
  const bets   = Array.from(state.bets.values());

  count.textContent = bets.length + ' bet' + (bets.length !== 1 ? 's' : '');

  if (bets.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No bets this round</td></tr>';
    return;
  }

  // Sort: cashed-out first (they won), then active
  bets.sort((a, b) => (b.cashedOut ? 1 : 0) - (a.cashedOut ? 1 : 0));

  tbody.innerHTML = bets.map(b => {
    const atText  = b.cashedOut ? b.cashedOutAt.toFixed(2) + '×' : '—';
    const profitText = b.cashedOut
      ? '+' + (b.profit - b.amount).toFixed(2)
      : (state.phase === 'crashed' ? '-' + b.amount.toFixed(2) : '…');
    const cls = b.cashedOut ? 'win' : (state.phase === 'crashed' ? 'loss' : 'live');

    return `<tr>
      <td class="player-name">${esc(b.username || 'Guest')}</td>
      <td>${b.amount.toFixed(2)}</td>
      <td class="${cls}">${atText}</td>
      <td class="${cls}">${profitText}</td>
    </tr>`;
  }).join('');
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
    const res  = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; return; }
    _saveSession(data);
    closeAuthModal();
    showToast(`Welcome back, ${data.username}!`);
  } catch {
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
    const res  = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; return; }
    _saveSession(data);
    closeAuthModal();
    showToast(`Account created! Welcome, ${data.username}!`);
  } catch {
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

  // Reconnect with new token so server recognises us (socket.io v4 API)
  state.socket.auth = { token };
  state.socket.disconnect();
  state.socket.connect();

  _updateUserUI();
  _renderPhase();
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
