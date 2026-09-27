/**
 * Gameplay acceptance for the Brick Breaker benchmark (M-Core S3).
 *
 * The benchmark brief asks the product to expose, for automated testing only:
 *   window.__gameState  read-only snapshot updated every frame:
 *     { phase: 'menu'|'playing'|'paused'|'levelComplete'|'gameOver'|'victory',
 *       level, totalLevels, score, lives, paddle: { x }, ball: { x, y }, bricksRemaining }
 *   window.__gameTest   { completeLevel(), loseBall() }  test hooks that act like
 *     clearing the last brick / missing the ball, through the game's own logic.
 *
 * Inputs are real key presses; the hooks only fast-forward the parts a
 * harness cannot play in reasonable time (20 levels, losing every life).
 * Reading state is the only use of __gameState; nothing is written to it.
 */

const STATE = 'JSON.parse(JSON.stringify(window.__gameState ?? null))';

function brickBreakerInteraction() {
  return async page => {
    const checks = [];
    const check = (label, passed, detail) => { checks.push({ label, passed: Boolean(passed), ...(detail ? { detail } : {}) }); return Boolean(passed); };
    const state = () => page.evaluate(STATE);
    const waitFor = async (predicate, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      let last = await state();
      while (Date.now() < deadline) {
        if (last && predicate(last)) { return last; }
        await page.wait(100);
        last = await state();
      }
      return last && predicate(last) ? last : null;
    };
    const hook = name => page.evaluate(`(() => { const h = window.__gameTest && window.__gameTest.${name}; if (typeof h !== 'function') throw new Error('window.__gameTest.${name} is missing'); h(); return true; })()`);
    const start = async (isStarted = s => s.phase === 'playing') => {
      for (const key of ['Enter', ' ']) {
        await page.press(key);
        if (await waitFor(isStarted, 1500)) { return true; }
      }
      await page.click(640, 450);
      return Boolean(await waitFor(isStarted, 1500));
    };
    const summary = s => s ? JSON.stringify({ phase: s.phase, level: s.level, score: s.score, lives: s.lives }) : 'no state';

    // 1. Contract and initial state.
    const initial = await state();
    if (!check('window.__gameState is exposed', initial && typeof initial === 'object', 'The brief requires a read-only window.__gameState for automated acceptance.')) { return checks; }
    check('20 levels are declared', initial.totalLevels === 20, `totalLevels=${initial.totalLevels}`);
    check('the game starts at level 1 with score 0 and lives', initial.level === 1 && initial.score === 0 && initial.lives > 0, summary(initial));
    await page.screenshot('01-start');

    // 2. Start with the keyboard.
    if (!check('Enter/Space (or a click) starts play', await start(), summary(await state()))) { return checks; }

    // 3. Paddle follows the keyboard.
    const before = await state();
    await page.press('ArrowLeft', 400);
    const afterLeft = await state();
    await page.press('ArrowRight', 800);
    const afterRight = await state();
    check('ArrowLeft moves the paddle left', afterLeft.paddle?.x < before.paddle?.x, `x ${before.paddle?.x} → ${afterLeft.paddle?.x}`);
    check('ArrowRight moves the paddle right', afterRight.paddle?.x > afterLeft.paddle?.x, `x ${afterLeft.paddle?.x} → ${afterRight.paddle?.x}`);

    // 4. The ball moves (some games need a launch key first).
    let b0 = await state();
    await page.wait(500);
    let b1 = await state();
    if (b0.ball?.x === b1.ball?.x && b0.ball?.y === b1.ball?.y) { await page.press(' '); await page.press('ArrowUp'); b0 = await state(); await page.wait(500); b1 = await state(); }
    check('the ball moves during play', b0.ball?.x !== b1.ball?.x || b0.ball?.y !== b1.ball?.y, `ball ${JSON.stringify(b0.ball)} → ${JSON.stringify(b1.ball)}`);

    // 5. Real play: follow the ball with the paddle until a brick breaks.
    const bricksAtStart = b1.bricksRemaining;
    const deadline = Date.now() + 20_000;
    let hit = null;
    while (Date.now() < deadline) {
      const s = await state();
      if (s.score > 0 || (typeof bricksAtStart === 'number' && s.bricksRemaining < bricksAtStart)) { hit = s; break; }
      if (s.phase !== 'playing') { await start(); continue; }
      const dx = (s.ball?.x ?? 0) - (s.paddle?.x ?? 0);
      if (Math.abs(dx) > 12) { await page.press(dx < 0 ? 'ArrowLeft' : 'ArrowRight', Math.min(120, Math.abs(dx))); } else { await page.wait(60); }
    }
    check('breaking a brick in real play raises the score', hit && hit.score > 0, hit ? summary(hit) : 'no brick was broken within 20 s of play');
    await page.screenshot('02-play');

    // 6. Pause and resume.
    await page.press('p');
    const paused = await waitFor(s => s.phase === 'paused', 1500);
    if (check('P pauses the game', paused, summary(await state()))) {
      const p0 = await state(); await page.wait(400); const p1 = await state();
      check('the ball stays still while paused', JSON.stringify(p0.ball) === JSON.stringify(p1.ball), `${JSON.stringify(p0.ball)} → ${JSON.stringify(p1.ball)}`);
      await page.press('p');
      check('P resumes the game', await waitFor(s => s.phase === 'playing', 1500), summary(await state()));
    }

    // 7. Missing the ball costs a life.
    const livesBefore = (await state()).lives;
    await hook('loseBall');
    check('missing the ball costs one life', await waitFor(s => s.lives === livesBefore - 1, 4000), `lives ${livesBefore} → ${(await state()).lives}`);
    if ((await state()).phase !== 'playing') { await start(); }

    // 8. Level progression through all 20 levels, then victory.
    let reached = (await state()).level;
    for (let guard = 0; guard < 25; guard++) {
      const s = await state();
      if (s.phase === 'victory') { break; }
      if (s.phase !== 'playing') { await start(s2 => s2.phase === 'playing' || s2.phase === 'victory'); continue; }
      const level = s.level;
      await hook('completeLevel');
      const next = await waitFor(n => n.level === level + 1 || n.phase === 'levelComplete' || n.phase === 'victory', 4000);
      if (!next) { break; }
      if (next.phase === 'levelComplete') { await start(n => n.level === level + 1 || n.phase === 'victory'); }
      reached = (await state()).level;
      if (level === 1) { await page.screenshot('03-level-2'); }
    }
    const end = await state();
    check('clearing a level advances to the next one, up to level 20', reached === 20 || end.phase === 'victory', `reached level ${reached}, ${summary(end)}`);
    check('clearing level 20 shows the victory state', end.phase === 'victory', summary(end));
    await page.screenshot('04-victory');

    // 9. Restart resets the game.
    const restarted = await (async () => {
      for (const key of ['Enter', 'r', ' ']) {
        await page.press(key);
        const s = await waitFor(n => n.level === 1 && n.score === 0 && n.phase !== 'victory', 1500);
        if (s) { return s; }
      }
      return null;
    })();
    check('restart after victory resets level and score', restarted, summary(await state()));

    // 10. Game over when all lives are gone, then restart with full lives.
    if (restarted) {
      if ((await state()).phase !== 'playing') { await start(); }
      const fullLives = (await state()).lives;
      for (let i = 0; i < 12 && (await state()).phase !== 'gameOver'; i++) {
        await hook('loseBall');
        await page.wait(300);
        const s = await state();
        if (s.phase !== 'playing' && s.phase !== 'gameOver') { await start(n => n.phase === 'playing' || n.phase === 'gameOver'); }
      }
      const over = await state();
      check('losing every life ends in game over', over.phase === 'gameOver', summary(over));
      await page.screenshot('05-game-over');
      for (const key of ['Enter', 'r', ' ']) {
        await page.press(key);
        if (await waitFor(n => n.phase !== 'gameOver' && n.lives === fullLives && n.score === 0 && n.level === 1, 1500)) { break; }
      }
      const again = await state();
      check('restart after game over restores lives, level and score', again.phase !== 'gameOver' && again.lives === fullLives && again.level === 1 && again.score === 0, summary(again));
    }
    return checks;
  };
}

module.exports = { brickBreakerInteraction };

// CLI: node test/acceptance/brickBreakerAcceptance.js <workspace> [report.json]
if (require.main === module) {
  const path = require('node:path');
  const fs = require('node:fs');
  const { AppVerificationService } = require('../../out/services/appVerificationService');
  const { TerminalRunner } = require('../../out/terminal/TerminalRunner');
  const { TerminalSessionRunner } = require('../../out/terminal/TerminalSessionRunner');
  const workspace = path.resolve(process.argv[2] ?? '.');
  const reportFile = process.argv[3] ? path.resolve(process.argv[3]) : path.join(workspace, '.agent-workspace', 'logs', 'gameplay_acceptance.json');
  (async () => {
    const result = await new AppVerificationService(workspace,
      new TerminalRunner(workspace, path.join(workspace, '.agent-workspace', 'logs', 'acceptance_terminal.log')),
      new TerminalSessionRunner(workspace, path.join(workspace, '.agent-workspace', 'logs')))
      .verify(brickBreakerInteraction());
    const smoke = result.checks.find(item => /^Browser smoke/.test(item.command));
    let interaction = [];
    try { interaction = JSON.parse(smoke?.stdout || '{}').interaction ?? []; } catch { /* no evidence */ }
    const report = { generatedAt: new Date().toISOString(), workspace, passed: !result.failed && interaction.length > 0 && interaction.every(c => c.passed),
      checks: interaction, smokeErrors: smoke?.stderr ?? '', appVerification: result.summary };
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    for (const c of interaction) { console.log(`${c.passed ? 'PASS' : 'FAIL'}  ${c.label}${c.detail && !c.passed ? ` — ${c.detail}` : ''}`); }
    if (smoke?.stderr) { console.log(`\n${smoke.stderr}`); }
    console.log(`\n${report.passed ? 'ACCEPTED' : 'NOT ACCEPTED'} — report: ${reportFile}`);
    process.exit(report.passed ? 0 : 1);
  })().catch(error => { console.error(error); process.exit(2); });
}
