// Minimal game honouring the acceptance contract; used only to test the harness.
// window.BROKEN = 'paddle' | 'victory' | 'restart' plants one defect for the harness tests.
(() => {
  const broken = window.BROKEN || '';
  const W = 800, H = 600, TOTAL = 20, LIVES = 3;
  const ctx = document.getElementById('c').getContext('2d');
  const keys = {};
  let g;
  const layout = level => { const b = []; for (let r = 0; r < 2 + (level % 3); r++) for (let c = 0; c < 8; c++) b.push({ x: 60 + c * 85, y: 60 + r * 30, w: 70, h: 20, alive: true }); return b; };
  const reset = () => { g = { phase: 'menu', level: 1, score: 0, lives: LIVES, paddle: { x: 400, w: 120 }, ball: { x: 400, y: 500, vx: 4, vy: -4 }, bricks: layout(1) }; };
  const serve = () => { g.ball = { x: g.paddle.x, y: 520, vx: 4 * (Math.random() < 0.5 ? -1 : 1), vy: -5 }; };
  const nextLevel = () => { if (g.level >= TOTAL) { g.phase = broken === 'victory' ? 'playing' : 'victory'; if (broken === 'victory') { g.bricks = layout(g.level); } return; } g.level += 1; g.bricks = layout(g.level); serve(); };
  const loseBall = () => { g.lives -= 1; if (g.lives <= 0) { g.phase = 'gameOver'; } else { serve(); } };
  reset();
  addEventListener('keydown', e => {
    keys[e.key] = true;
    if ((e.key === 'Enter' || e.key === ' ') && g.phase === 'menu') { g.phase = 'playing'; serve(); }
    else if ((e.key === 'Enter' || e.key === 'r') && (g.phase === 'victory' || g.phase === 'gameOver')) { const keep = g.score; reset(); if (broken === 'restart') { g.score = keep; } }
    else if (e.key === 'p' && (g.phase === 'playing' || g.phase === 'paused')) { g.phase = g.phase === 'playing' ? 'paused' : 'playing'; }
  });
  addEventListener('keyup', e => { keys[e.key] = false; });
  window.__gameTest = {
    completeLevel: () => { g.bricks.forEach(b => { b.alive = false; }); g.score += 10; nextLevel(); },
    loseBall: () => { g.ball.y = H + 50; },
  };
  const step = () => {
    if (g.phase === 'playing') {
      if (broken !== 'paddle') {
        if (keys.ArrowLeft) g.paddle.x = Math.max(60, g.paddle.x - 8);
        if (keys.ArrowRight) g.paddle.x = Math.min(W - 60, g.paddle.x + 8);
      }
      const b = g.ball; b.x += b.vx; b.y += b.vy;
      if (b.x < 8) { b.x = 8; b.vx = Math.abs(b.vx); }
      if (b.x > W - 8) { b.x = W - 8; b.vx = -Math.abs(b.vx); }
      b.vx = Math.max(-7, Math.min(7, b.vx));
      if (b.y < 8) b.vy = Math.abs(b.vy);
      if (b.y > 560 && b.y < 575 && Math.abs(b.x - g.paddle.x) < g.paddle.w / 2) { b.vy = -Math.abs(b.vy); b.vx += (b.x - g.paddle.x) / 20; }
      for (const brick of g.bricks) if (brick.alive && b.x > brick.x && b.x < brick.x + brick.w && b.y > brick.y && b.y < brick.y + brick.h) { brick.alive = false; b.vy *= -1; g.score += 10; break; }
      if (g.bricks.every(x => !x.alive)) nextLevel();
      if (b.y > H) loseBall();
    }
    window.__gameState = Object.freeze({ phase: g.phase, level: g.level, totalLevels: TOTAL, score: g.score, lives: g.lives,
      paddle: { x: g.paddle.x }, ball: { x: g.ball.x, y: g.ball.y }, bricksRemaining: g.bricks.filter(x => x.alive).length });
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e44'; g.bricks.forEach(x => x.alive && ctx.fillRect(x.x, x.y, x.w, x.h));
    ctx.fillStyle = '#4ae'; ctx.fillRect(g.paddle.x - g.paddle.w / 2, 565, g.paddle.w, 12);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(g.ball.x, g.ball.y, 7, 0, 7); ctx.fill();
    ctx.fillText(`${g.phase} L${g.level} S${g.score} ♥${g.lives}`, 10, 20);
    requestAnimationFrame(step);
  };
  step();
})();
