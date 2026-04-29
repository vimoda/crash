/**
 * CrashChart — real-time Canvas chart for the Crash game.
 *
 * Draws:
 *  • Subtle grid with labeled axes
 *  • Exponentially growing curve (white → soft gradient) during play
 *  • Red curve + fill when crashed
 *  • Smooth 60 fps via requestAnimationFrame with multiplier extrapolation
 */

const GROWTH_RATE = 0.00006; // must match server/game/engine.js

class CrashChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Data points accumulated during a round: [{elapsed, mult}]
    this.points = [];

    this.state = 'waiting'; // waiting | running | crashed
    this.crashedAt = null;

    // For smooth inter-tick interpolation
    this.lastTickElapsed = 0;
    this.lastTickTime = null; // wall-clock ms when last tick arrived

    this.rafId = null;
    this._resize();

    window.addEventListener('resize', () => this._resize());
    this._loop();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Called on gameWaiting — clears the chart */
  reset() {
    this.points = [];
    this.state = 'waiting';
    this.crashedAt = null;
    this.lastTickElapsed = 0;
    this.lastTickTime = null;
  }

  /** Called on gameRunning */
  startRunning(startTime) {
    this.state = 'running';
    this.gameStartTime = startTime;
    this.points = [{ elapsed: 0, mult: 1.00 }];
    this.lastTickTime = Date.now();
    this.lastTickElapsed = 0;
  }

  /** Called on gameTick */
  addPoint(elapsed, mult) {
    this.points.push({ elapsed, mult });
    this.lastTickElapsed = elapsed;
    this.lastTickTime = Date.now();
  }

  /** Called on gameCrash */
  setCrash(crashPoint) {
    this.state = 'crashed';
    this.crashedAt = crashPoint;
    // Add the exact crash point as final data point
    const elapsedAtCrash = Math.log(crashPoint) / GROWTH_RATE;
    this.points.push({ elapsed: elapsedAtCrash, mult: crashPoint });
  }

  /** If the page loaded mid-round, seed existing points */
  seedPoints(elapsed) {
    this.points = [];
    for (let e = 0; e <= elapsed; e += 200) {
      this.points.push({ elapsed: e, mult: Math.exp(GROWTH_RATE * e) });
    }
    this.lastTickElapsed = elapsed;
    this.lastTickTime = Date.now();
  }

  // ─── Render loop ───────────────────────────────────────────────────────────

  _loop() {
    this.rafId = requestAnimationFrame(() => {
      this._draw();
      this._loop();
    });
  }

  _draw() {
    const { ctx, canvas, state, points, crashedAt } = this;
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    if (state === 'waiting' || points.length < 2) {
      this._drawGrid(W, H, 0, 1.2, 30);
      return;
    }

    // ── Extrapolate current position for smooth animation ──────────────────
    let currentElapsed, currentMult;
    if (state === 'running' && this.lastTickTime !== null) {
      const since = Date.now() - this.lastTickTime;
      currentElapsed = this.lastTickElapsed + since;
      currentMult = Math.exp(GROWTH_RATE * currentElapsed);
    } else {
      const last = points[points.length - 1];
      currentElapsed = last.elapsed;
      currentMult = last.mult;
    }

    // ── Determine visible ranges (auto-scale with head-room) ───────────────
    const maxMult = state === 'crashed'
      ? Math.max(crashedAt * 1.15, 2)
      : Math.max(currentMult * 1.25, 2);

    const maxElapsed = Math.max(currentElapsed * 1.25, 12000); // at least 12s visible

    this._drawGrid(W, H, maxElapsed, maxMult, 30);
    this._drawCurve(W, H, maxElapsed, maxMult, currentElapsed, currentMult);
  }

  // ─── Grid ──────────────────────────────────────────────────────────────────

  _drawGrid(W, H, maxElapsedMs, maxMult, pad) {
    const { ctx } = this;
    const left = 44, bottom = 24;
    const plotW = W - left - pad;
    const plotH = H - bottom - pad;

    ctx.save();

    // Background
    ctx.fillStyle = 'rgba(13,24,33,0.0)';
    ctx.fillRect(0, 0, W, H);

    // ── Y axis labels + grid lines ─────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(90,122,144,0.8)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';

    const yStep = niceStep((maxMult - 1) / 4);
    for (let m = 1 + yStep; m < maxMult; m = +(m + yStep).toFixed(6)) {
      const y = pad + plotH - ((m - 1) / (maxMult - 1)) * plotH;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + plotW, y);
      ctx.stroke();
      ctx.fillText(m.toFixed(1) + '×', left - 4, y + 4);
    }

    // ── X axis labels ──────────────────────────────────────────────────────
    ctx.textAlign = 'center';
    const xStepMs = niceStep(maxElapsedMs / 1000 / 4) * 1000;
    for (let ms = 0; ms <= maxElapsedMs; ms += xStepMs) {
      const x = left + (ms / maxElapsedMs) * plotW;
      ctx.fillText((ms / 1000).toFixed(0) + 's', x, H - 4);
    }

    // ── Axes ───────────────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, pad);
    ctx.lineTo(left, pad + plotH);
    ctx.lineTo(left + plotW, pad + plotH);
    ctx.stroke();

    ctx.restore();
  }

  // ─── Curve ────────────────────────────────────────────────────────────────

  _drawCurve(W, H, maxElapsedMs, maxMult, currentElapsed, currentMult) {
    const { ctx, state, points } = this;
    const left = 44, bottom = 24, pad = 30;
    const plotW = W - left - pad;
    const plotH = H - bottom - pad;

    const toX = ms   => left + (ms / maxElapsedMs) * plotW;
    const toY = mult => pad + plotH - ((mult - 1) / (maxMult - 1)) * plotH;

    // Build draw points: saved ticks + extrapolated current tip
    const drawPts = [...points];
    if (state === 'running') {
      drawPts.push({ elapsed: currentElapsed, mult: Math.min(currentMult, maxMult * 0.99) });
    }

    if (drawPts.length < 2) return;

    // ── Gradient stroke ────────────────────────────────────────────────────
    const crashed = state === 'crashed';
    const x0 = toX(drawPts[0].elapsed);
    const xN = toX(drawPts[drawPts.length - 1].elapsed);
    const grad = ctx.createLinearGradient(x0, 0, xN, 0);

    if (crashed) {
      grad.addColorStop(0, 'rgba(255, 69, 69, 0.7)');
      grad.addColorStop(1, 'rgba(255, 69, 69, 1.0)');
    } else {
      grad.addColorStop(0, 'rgba(255,255,255,0.5)');
      grad.addColorStop(0.5, 'rgba(180,200,255,0.85)');
      grad.addColorStop(1, 'rgba(140,170,255,1.0)');
    }

    // ── Path ───────────────────────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(toX(drawPts[0].elapsed), toY(drawPts[0].mult));
    for (let i = 1; i < drawPts.length; i++) {
      ctx.lineTo(toX(drawPts[i].elapsed), toY(drawPts[i].mult));
    }

    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // ── Fill ───────────────────────────────────────────────────────────────
    const baseY = toY(1.0);
    ctx.lineTo(toX(drawPts[drawPts.length - 1].elapsed), baseY);
    ctx.lineTo(toX(drawPts[0].elapsed), baseY);
    ctx.closePath();

    const fillGrad = ctx.createLinearGradient(0, toY(currentMult), 0, baseY);
    if (crashed) {
      fillGrad.addColorStop(0, 'rgba(255,69,69,0.18)');
      fillGrad.addColorStop(1, 'rgba(255,69,69,0.02)');
    } else {
      fillGrad.addColorStop(0, 'rgba(140,170,255,0.15)');
      fillGrad.addColorStop(1, 'rgba(140,170,255,0.01)');
    }
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // ── Dot at tip ────────────────────────────────────────────────────────
    if (!crashed) {
      const tx = toX(currentElapsed);
      const ty = toY(Math.min(currentMult, maxMult * 0.98));
      ctx.beginPath();
      ctx.arc(tx, ty, 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(200,220,255,0.9)';
      ctx.fill();
      // glow
      ctx.beginPath();
      ctx.arc(tx, ty, 9, 0, Math.PI * 2);
      const glow = ctx.createRadialGradient(tx, ty, 2, tx, ty, 9);
      glow.addColorStop(0, 'rgba(200,220,255,0.3)');
      glow.addColorStop(1, 'rgba(200,220,255,0)');
      ctx.fillStyle = glow;
      ctx.fill();
    }

    ctx.restore();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _resize() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.canvas.width  = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.scale(dpr, dpr);
  }
}

/** Choose a "nice" step for axis labels (1, 2, 5, 10, 20, 50 …) */
function niceStep(rawStep) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  if (normalized < 1.5) return magnitude;
  if (normalized < 3.5) return 2 * magnitude;
  if (normalized < 7.5) return 5 * magnitude;
  return 10 * magnitude;
}
