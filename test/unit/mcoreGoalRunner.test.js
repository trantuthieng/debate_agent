const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { parseArgs, loadBrief, bindWorkspace, captureImplementation, buildReport } = require('../mcore_goal_e2e');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcore-runner-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const valid = ['--goal-id', 'local-notes', '--workspace', '/tmp/example-goal', '--budget-minutes', '120'];
function json(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); }

test('runner arguments require a locked goal, explicit workspace/budget and explicit resume', () => {
  assert.equal(parseArgs(valid).resume, false);
  assert.equal(parseArgs([...valid, '--resume']).resume, true);
  assert.equal(parseArgs(valid).budgetMinutes, 120);
  for (const args of [[], valid.slice(0, 4), [...valid, '--goal-id', 'tasks-cli'], [...valid, '--mock-model'],
    ['--goal-id', '../notes', '--workspace', '/tmp/x', '--budget-minutes', '1'],
    ['--goal-id', 'tasks-cli', '--workspace', '/tmp/x', '--budget-minutes', '0'],
    ['--goal-id', 'tasks-cli', '--workspace', '--resume']]) assert.throws(() => parseArgs(args));
});

test('locked brief bytes are hashed and requirements retained without model imports', () => {
  for (const id of ['local-notes', 'tasks-cli']) {
    const brief = loadBrief(id);
    assert.equal(brief.id, id);
    assert.equal(brief.requirements.length, 8);
    assert.match(brief.sha256, /^[a-f0-9]{64}$/);
    assert.equal(brief.sha256, require('node:crypto').createHash('sha256').update(fs.readFileSync(brief.source)).digest('hex'));
  }
  assert.throws(() => loadBrief('../tasks-cli'));
  assert.equal(Object.keys(require.cache).some(file => /out[/\\]orchestrator[/\\]AgentOrchestrator/.test(file)), false);
});

test('resume refuses foreign or altered briefs and never silently reuses a failed workspace', t => {
  const workspace = fixture(t);
  const brief = loadBrief('local-notes');
  const args = { workspace, resume: false };
  bindWorkspace(args, brief);
  json(path.join(workspace, '.agent-workspace/project_state.json'), { status: 'failed', currentPhase: 'coding' });
  const checkpoint = fs.readFileSync(path.join(workspace, '.agent-workspace/project_state.json'));
  assert.throws(() => bindWorkspace(args, brief), /empty workspace/);
  assert.doesNotThrow(() => bindWorkspace({ ...args, resume: true }, brief));
  assert.throws(() => bindWorkspace({ ...args, resume: true }, { ...brief, sha256: 'changed' }), /binding/);
  assert.throws(() => bindWorkspace({ ...args, resume: true }, loadBrief('tasks-cli')), /binding/);
  assert.deepEqual(fs.readFileSync(path.join(workspace, '.agent-workspace/project_state.json')), checkpoint);
});

test('resume rejects missing checkpoint state even if brief binding matches', t => {
  const workspace = fixture(t);
  const brief = loadBrief('tasks-cli');
  bindWorkspace({ workspace, resume: false }, brief);
  assert.throws(() => bindWorkspace({ workspace, resume: true }, brief), /project_state/);
});

test('completed pipelines and four round headings remain unverified independent acceptance', t => {
  const workspace = fixture(t);
  const dir = path.join(workspace, '.agent-workspace');
  const brief = loadBrief('tasks-cli');
  const agents = Array.from({ length: 5 }, (_, index) => ({ id: `a${index}`, model: `model${index}:latest` }));
  json(path.join(dir, 'project_state.json'), { status: 'completed', fixRetryCount: 2 });
  json(path.join(dir, 'model_config.json'), { local: true });
  json(path.join(dir, 'agents/dynamic_team_plan.json'), { agents });
  fs.writeFileSync(path.join(dir, 'agents/dynamic_team_debate.md'), [1, 2, 3, 4].map(round => `## Round ${round} — evidence`).join('\n'));
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs/ollama_calls.jsonl'), agents.map(agent => JSON.stringify({ model: agent.model, agentRole: `dynamic:${agent.id}`, success: true })).join('\n') + '\ninvalid-json');
  const context = { args: { workspace, resume: true, budgetMinutes: 60 }, brief, startedAt: new Date().toISOString(), invocationId: 'fixture',
    invocationDir: path.join(workspace, 'report'), initial: { config: {} }, initialCallCount: 2, phases: [], turns: [], checkpointHistory: [], implementation: { revision: 'fixture' } };
  const report = buildReport(context, 'pipeline-completed');
  assert.equal(report.pipeline.completed, true);
  assert.equal(report.acceptance.status, 'unverified');
  assert.equal(report.debate.evidenceStatus, 'unverified');
  assert.deepEqual(report.debate.transcriptRounds, [1, 2, 3, 4]);
  assert.equal(report.debate.atLeastFiveObservedModels, true);
  assert.equal(report.calls.cumulative.total, 5);
  assert.equal(report.calls.invocation.total, 3);
  assert.equal(report.calls.malformedLines, 1);
  assert.equal(buildReport(context, 'failed', 'fixture failure').pipeline.completed, false);
  assert.equal(buildReport(context, 'failed', 'fixture failure').pipeline.error, 'fixture failure');
});

test('implementation evidence hashes staged/unstaged/untracked source and actual compiled code', t => {
  const repo = fixture(t);
  const git = args => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git(['init', '-q']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'out/\n');
  fs.writeFileSync(path.join(repo, 'source.js'), 'original');
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  fs.mkdirSync(path.join(repo, 'out'));
  fs.writeFileSync(path.join(repo, 'out/main.js'), 'compiled-one');
  const clean = captureImplementation(repo);
  assert.equal(clean.dirty, false);
  fs.writeFileSync(path.join(repo, 'source.js'), 'changed');
  fs.writeFileSync(path.join(repo, 'untracked.js'), 'new source');
  const changed = captureImplementation(repo);
  assert.equal(changed.revision, clean.revision);
  assert.equal(changed.dirty, true);
  assert.notEqual(changed.dirtyHash, clean.dirtyHash);
  assert.ok(changed.untrackedHashes['untracked.js']);
  git(['add', 'source.js']);
  assert.notEqual(captureImplementation(repo).dirtyHash, changed.dirtyHash);
  fs.writeFileSync(path.join(repo, 'out/main.js'), 'compiled-two');
  assert.notEqual(captureImplementation(repo).compiledHash, clean.compiledHash);
});
