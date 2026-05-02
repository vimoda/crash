/**
 * CrashChart — real-time Canvas chart for the Crash game.
 *
 * Draws:
 *  • Subtle grid with labeled axes
 *  • Exponentially growing curve (white → soft gradient) during play
 *  • Red curve + fill when crashed
 *  • Smooth 60 fps via requestAnimationFrame with multiplier extrapolation
 *  • Animated rocket at the curve tip
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
    this.cashoutMult = null;   // player's cashout multiplier (draw a marker line)
    this.autoCashoutLevel = null; // auto-cashout threshold line

    this.rocketAngle = -Math.PI / 2; // rocket points upward
    this.rocketTrail = []; // trail particles for exhaust effect
    this.explosionParticles = []; // explosion particles on crash
    this.myBetAmount = 0; // user's current bet amount for profit display

    // CSS dimensions (before DPR scaling)
    this.cssW = 0;
    this.cssH = 0;

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
    this.rocketTrail = [];
    this.explosionParticles = [];
  }

  /** Called on gameRunning */
  startRunning(startTime) {
    this.state = 'running';
    this.gameStartTime = startTime;
    this.points = [{ elapsed: 0, mult: 1.00 }];
    this.lastTickTime = Date.now();
    this.lastTickElapsed = 0;
    this.rocketTrail = [];
    this.explosionParticles = [];
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
    const elapsedAtCrash = Math.log(crashPoint) / GROWTH_RATE;
    this.points.push({ elapsed: elapsedAtCrash, mult: crashPoint });
    this._createExplosion();
  }

  setCashoutMarker(mult) {
    this.cashoutMult = mult;
  }

  clearCashoutMarker() {
    this.cashoutMult = null;
    this.autoCashoutLevel = null;
  }

  setAutoCashoutLine(mult) {
    this.autoCashoutLevel = mult;
  }

  setMyBetAmount(amount) {
    this.myBetAmount = amount;
  }

  _createExplosion() {
    const last = this.points[this.points.length - 1];
    if (!last) return;
    const elapsedAtCrash = last.elapsed;
    const crashPoint = last.mult;
    const crashed = this.state === 'crashed';
    const left = 44, bottom = 24, pad = 30;
    const W = this.cssW;
    const H = this.cssH;
    if (!W || !H) return;
    const plotW = W - left - pad;
    const plotH = H - bottom - pad;
    const maxMult = Math.max(crashPoint * 1.15, 2);
    const maxElapsed = Math.max(elapsedAtCrash * 1.25, 12000);
    const toX = ms => left + (ms / maxElapsed) * plotW;
    const toY = mult => pad + plotH - ((mult - 1) / (maxMult - 1)) * plotH;
    const ex = toX(elapsedAtCrash);
    const ey = toY(crashPoint);
    for (let i = 0; i < 40; i++) {
      const angle = (Math.PI * 2 * i) / 40 + Math.random() * 0.3;
      const speed = 2 + Math.random() * 4;
      this.explosionParticles.push({
        x: ex,
        y: ey,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: 0.015 + Math.random() * 0.02,
        r: 3 + Math.random() * 5,
        hue: Math.random() < 0.5 ? 30 : 0,
      });
    }
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
    const { ctx, state, points, crashedAt } = this;
    const W = this.cssW;
    const H = this.cssH;

    if (W === 0 || H === 0) return; // not ready yet

    ctx.clearRect(0, 0, W, H);

    // Always draw grid
    let maxMult = 1.2;
    let maxElapsed = 12000;
    let currentElapsed = 0;
    let currentMult = 1.0;

    // Always calculate current values
    if (state === 'running' && this.lastTickTime !== null) {
      const since = Date.now() - this.lastTickTime;
      currentElapsed = this.lastTickElapsed + since;
      currentMult = Math.exp(GROWTH_RATE * currentElapsed);
      maxMult = Math.max(currentMult * 1.25, 2);
      maxElapsed = Math.max(currentElapsed * 1.25, 12000);
    } else if (state === 'crashed' && crashedAt) {
      currentMult = crashedAt;
      currentElapsed = Math.log(crashedAt) / GROWTH_RATE;
      maxMult = Math.max(crashedAt * 1.15, 2);
      maxElapsed = Math.max(currentElapsed * 1.25, 12000);
    } else if (points.length > 0) {
      const last = points[points.length - 1];
      currentElapsed = last.elapsed;
      currentMult = last.mult;
      maxMult = Math.max(currentMult * 1.25, 2);
      maxElapsed = Math.max(currentElapsed * 1.25, 12000);
    }

    this._drawGrid(W, H, maxElapsed, maxMult, 30);

    // Always draw curve if we have data
    if (points.length >= 1) {
      this._drawCurve(W, H, maxElapsed, maxMult, currentElapsed, currentMult);
    }
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
    ctx.strokeStyle = 'rgba(0,200,80,0.08)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(0,180,70,0.65)';
    ctx.font = '11px "Courier New", monospace';
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
    if (maxElapsedMs > 0) {
      const xStepMs = niceStep(maxElapsedMs / 1_000 / 4) * 1_000;
      if (xStepMs > 0) {
        for (let ms = 0; ms <= maxElapsedMs; ms += xStepMs) {
          const x = left + (ms / maxElapsedMs) * plotW;
          ctx.fillText((ms / 1_000).toFixed(0) + 's', x, H - 4);
        }
      }
    }

    // ── Axes ───────────────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(0,200,80,0.2)';
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

    const toX = ms => left + (ms / maxElapsedMs) * plotW;
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
      grad.addColorStop(0, 'rgba(255,34,68,0.8)');
      grad.addColorStop(1, 'rgba(255,34,68,1.0)');
    } else {
      grad.addColorStop(0, 'rgba(0,255,136,0.5)');
      grad.addColorStop(0.5, 'rgba(0,220,100,0.9)');
      grad.addColorStop(1, 'rgba(0,255,136,1.0)');
    }

    // ── Path ───────────────────────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(toX(drawPts[0].elapsed), toY(drawPts[0].mult));
    for (let i = 1; i < drawPts.length; i++) {
      const prev = drawPts[i - 1];
      const curr = drawPts[i];
      const midX = (toX(prev.elapsed) + toX(curr.elapsed)) / 2;
      const midY = (toY(prev.mult) + toY(curr.mult)) / 2;
      ctx.quadraticCurveTo(toX(prev.elapsed), toY(prev.mult), midX, midY);
    }
    const last = drawPts[drawPts.length - 1];
    ctx.lineTo(toX(last.elapsed), toY(last.mult));

    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // ── Fill ───────────────────────────────────────────────────────────────
    const baseY = toY(1.0);
    // Reconstruir la curva suave para el fill
    ctx.beginPath();
    ctx.moveTo(toX(drawPts[0].elapsed), toY(drawPts[0].mult));
    for (let i = 1; i < drawPts.length; i++) {
      const prev = drawPts[i - 1];
      const curr = drawPts[i];
      const midX = (toX(prev.elapsed) + toX(curr.elapsed)) / 2;
      const midY = (toY(prev.mult) + toY(curr.mult)) / 2;
      ctx.quadraticCurveTo(toX(prev.elapsed), toY(prev.mult), midX, midY);
    }
    ctx.lineTo(toX(drawPts[drawPts.length - 1].elapsed), toY(drawPts[drawPts.length - 1].mult));
    ctx.lineTo(toX(drawPts[drawPts.length - 1].elapsed), baseY);
    ctx.lineTo(toX(drawPts[0].elapsed), baseY);
    ctx.closePath();

    const fillGrad = ctx.createLinearGradient(0, toY(currentMult), 0, baseY);
    if (crashed) {
      fillGrad.addColorStop(0, 'rgba(255,34,68,0.2)');
      fillGrad.addColorStop(1, 'rgba(255,34,68,0.02)');
    } else {
      fillGrad.addColorStop(0, 'rgba(0,255,136,0.12)');
      fillGrad.addColorStop(1, 'rgba(0,255,136,0.01)');
    }
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // ── Explosion particles ───────────────────────────────────────────
    if (this.explosionParticles.length > 0) {
      for (let i = this.explosionParticles.length - 1; i >= 0; i--) {
        const p = this.explosionParticles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.15;
        p.vx *= 0.98;
        p.life -= p.decay;
        if (p.life <= 0) {
          this.explosionParticles.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
        const alpha = p.life * 0.9;
        const hue = p.hue === 30 ? 30 : (p.hue === 0 ? 0 : 45);
        ctx.fillStyle = `hsla(${hue}, 100%, 50%, ${alpha})`;
        ctx.fill();
      }
    }

    // ── Rocket at tip ───────────────────────────────────────────────
    if (state === 'running') {
      const tx = toX(currentElapsed);
      const ty = toY(Math.min(currentMult, maxMult * 0.98));
      this._drawRocket(ctx, tx, ty, currentMult, currentElapsed, false);
      if (this.myBetAmount > 0) {
        this._drawProfitLabel(ctx, tx, ty + 25, this.myBetAmount, currentMult);
      }
    } else if (state === 'crashed' && this.points.length > 0) {
      const lastCrash = this.points[this.points.length - 1];
      const cx = toX(lastCrash.elapsed);
      const cy = toY(lastCrash.mult);
      this._drawRocket(ctx, cx, cy, lastCrash.mult, lastCrash.elapsed, true);
    }

    // ── Cashout marker (player's cashout point) ────────────────────────────
    if (this.cashoutMult && this.cashoutMult <= maxMult) {
      const my = toY(this.cashoutMult);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,215,0,0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(left, my);
      ctx.lineTo(left + plotW, my);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,215,0,0.9)';
      ctx.font = '11px "Courier New", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`✓ ${this.cashoutMult.toFixed(2)}×`, left + plotW - 4, my - 4);
      ctx.restore();
    }

    // ── Auto cashout threshold line ───────────────────────────────────────
    if (this.autoCashoutLevel && this.autoCashoutLevel <= maxMult && !this.cashoutMult) {
      const ay = toY(this.autoCashoutLevel);
      ctx.save();
      ctx.strokeStyle = 'rgba(0,200,80,0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      ctx.moveTo(left, ay);
      ctx.lineTo(left + plotW, ay);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.restore();
  }

  // ─── Rocket drawing ─────────────────────────────────────────────────────────

  _drawRocket(ctx, x, y, mult, elapsed, isCrashed = false) {
    const speed = Math.min(1.5, 0.3 + mult * 0.08);
    const scale = 2.5; // Make rocket 2.5x larger

    // Exhaust trail particles
    if (this.state === 'running') {
      const numParticles = Math.floor(2 + mult * 0.3);
      for (let i = 0; i < numParticles; i++) {
        this.rocketTrail.push({
          x: x - 8 * scale + Math.random() * 4 * scale - 2 * scale,
          y: y + 10 * scale + Math.random() * 12 * scale,
          vx: (Math.random() - 0.5) * 1.5,
          vy: Math.random() * 2 + speed,
          life: 1,
          decay: 0.04 + Math.random() * 0.04,
          r: Math.random() * 4 + 2,
          hue: Math.random() * 50 + 15,
        });
      }
    }

    // Draw and update trail
    for (let i = this.rocketTrail.length - 1; i >= 0; i--) {
      const p = this.rocketTrail[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05;
      p.life -= p.decay;
      if (p.life <= 0) {
        this.rocketTrail.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      const alpha = p.life * 0.8;
      const sat = 80 + (1 - p.life) * 20;
      ctx.fillStyle = `hsla(${p.hue}, ${sat}%, ${50 + (1 - p.life) * 30}%, ${alpha})`;
      ctx.fill();
    }

    ctx.save();
    ctx.translate(x, y);

    // Calculate rocket angle based on curve tangent
    const left = 44, bottom = 24, pad = 30;
    const W = this.cssW;
    const H = this.cssH;
    const plotW = W - left - pad;
    const plotH = H - bottom - pad;
    const maxMult = Math.max(mult * 1.25, 2);
    const maxElapsed = Math.max(elapsed * 1.25, 12000);

    // Parametric derivatives with respect to elapsed
    // dx/delapsed = plotW / maxElapsed
    // dy/delapsed = -plotH / (maxMult - 1) * GROWTH_RATE * mult
    const dx = plotW / maxElapsed;
    const dy = -plotH / (maxMult - 1) * GROWTH_RATE * mult;
    // Rocket is drawn pointing up (-PI/2), so we need to rotate by tangent angle + PI/2
    const angle = Math.atan2(dy, dx) + Math.PI / 2;
    ctx.rotate(angle);

    ctx.scale(scale, scale);

    // Glow behind rocket
    const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 18);
    glow.addColorStop(0, 'rgba(255,150,30,0.4)');
    glow.addColorStop(0.5, 'rgba(255,80,0,0.15)');
    glow.addColorStop(1, 'rgba(255,50,0,0)');
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();

    // Rocket body (triangle pointing up)
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(-7, 8);
    ctx.lineTo(7, 8);
    ctx.closePath();
    const bodyGrad = ctx.createLinearGradient(0, -14, 0, 8);
    if (isCrashed) {
      bodyGrad.addColorStop(0, '#4a4a4a');
      bodyGrad.addColorStop(0.5, '#2a2a2a');
      bodyGrad.addColorStop(1, '#1a1a1a');
    } else {
      bodyGrad.addColorStop(0, '#e8e8e8');
      bodyGrad.addColorStop(0.5, '#b0b0b0');
      bodyGrad.addColorStop(1, '#888');
    }
    ctx.fillStyle = bodyGrad;
    ctx.fill();
    ctx.strokeStyle = isCrashed ? '#333' : '#555';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Rocket fins
    const finColor = isCrashed ? '#4a2020' : '#c0392b';
    ctx.beginPath();
    ctx.moveTo(-7, 6);
    ctx.lineTo(-12, 12);
    ctx.lineTo(-7, 8);
    ctx.fillStyle = finColor;
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(7, 6);
    ctx.lineTo(12, 12);
    ctx.lineTo(7, 8);
    ctx.fillStyle = finColor;
    ctx.fill();
    ctx.stroke();

    // Window
    ctx.beginPath();
    ctx.arc(0, -2, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = isCrashed ? '#2a3a4a' : '#3498db';
    ctx.fill();
    ctx.strokeStyle = isCrashed ? '#1a2a3a' : '#2980b9';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Flame at bottom (only when not crashed)
    if (!isCrashed) {
      const flameIntensity = Math.min(mult * 0.15, 1.2);
      const flameH = 8 + flameIntensity * 6 + Math.random() * 4;

      ctx.beginPath();
      ctx.moveTo(-5, 8);
      ctx.quadraticCurveTo(0, 8 + flameH, 5, 8);
      ctx.fillStyle = '#f39c12';
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(-3, 8);
      ctx.quadraticCurveTo(0, 8 + flameH * 0.7, 3, 8);
      ctx.fillStyle = '#e74c3c';
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(-1.5, 8);
      ctx.quadraticCurveTo(0, 8 + flameH * 0.4, 1.5, 8);
      ctx.fillStyle = '#f1c40f';
      ctx.fill();
    } else {
      // Draw smoke/charcoal effect when crashed
      ctx.beginPath();
      ctx.arc(0, 10, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(30, 30, 30, 0.7)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(-3, 12, 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(40, 40, 40, 0.5)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(3, 12, 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(40, 40, 40, 0.5)';
      ctx.fill();
    }

    // Speed lines (when multiplier is high)
    if (mult > 2) {
      const numLines = Math.floor(Math.min(mult - 2, 6));
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;
      for (let i = 0; i < numLines; i++) {
        const offsetX = -15 - Math.random() * 10;
        const startY = -5 + Math.random() * 10;
        ctx.beginPath();
        ctx.moveTo(offsetX - 8, startY);
        ctx.lineTo(offsetX, startY);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  _drawProfitLabel(ctx, x, y, betAmount, currentMult) {
    const profit = betAmount * currentMult - betAmount;
    const isProfit = profit >= 0;
    const text = (isProfit ? '+' : '') + profit.toFixed(2) + ' COINS';
    const textColor = isProfit ? '#00ff88' : '#ff4444';
    const bgColor = isProfit ? 'rgba(0, 40, 30, 0.85)' : 'rgba(40, 10, 10, 0.85)';

    ctx.save();
    ctx.font = 'bold 12px "Courier New", monospace';
    const textWidth = ctx.measureText(text).width;
    const padding = 6;
    const boxWidth = textWidth + padding * 2;
    const boxHeight = 20;
    const boxX = x - boxWidth / 2;
    const boxY = y;

    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 4);
    ctx.fill();
    ctx.strokeStyle = isProfit ? 'rgba(0, 255, 136, 0.4)' : 'rgba(255, 68, 68, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + boxHeight / 2);

    ctx.restore();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _resize() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    let w = parent.clientWidth;
    let h = parent.clientHeight;
    // If dimensions are 0, wait and retry
    if (w === 0 || h === 0) {
      setTimeout(() => this._resize(), 50);
      return;
    }
    this.cssW = w;
    this.cssH = h;
    this.canvas.width  = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';
    // Reset transform and scale once
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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