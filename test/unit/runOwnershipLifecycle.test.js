const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentOrchestrator } = require('../../out/orchestrator/AgentOrchestrator');
const { RunLock } = require('../../out/workspace/RunLock');

for (const method of ['start', 'designAndRunTeam', 'runAutonomousGoal', 'resume']) {
  test(`${method}: failed ownership claim leaves instance retryable and preserves owner state`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-ownership-'));
    const agent = new AgentOrchestrator(root);
    await agent.workspace.initialize();
    const state = agent.workspace.readProjectState();
    state.status = 'stopped';
    agent.workspace.writeProjectState(state);
    const stateBefore = fs.readFileSync(agent.workspace.projectStatePath, 'utf8');
    const owner = new RunLock(agent.workspace.runLockPath);
    owner.acquire();
    const lockBefore = fs.readFileSync(agent.workspace.runLockPath, 'utf8');
    t.after(() => { agent._endRunOwnership(); owner.release(); fs.rmSync(root, { recursive: true, force: true }); });
    await assert.rejects(agent[method]('A competing goal'), /already held/);
    assert.equal(agent.isRunning(), false);
    assert.equal(agent._activeRunLock, null);
    assert.equal(agent._runHeartbeatTimer, null);
    assert.equal(fs.readFileSync(agent.workspace.runLockPath, 'utf8'), lockBefore);
    assert.equal(fs.readFileSync(agent.workspace.projectStatePath, 'utf8'), stateBefore);
    owner.release();
    agent._running = true;
    agent._beginRunOwnership();
    assert.ok(agent._activeRunLock, 'The same instance can claim after the actual owner releases');
    agent._endRunOwnership();
    agent._running = false;
  });
}
