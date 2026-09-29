const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runTasksCliAtomicAcceptance } = require('./acceptance/tasksCliAtomicAcceptance');

for (const mode of ['rename', 'direct', 'swallow', 'unobserved']) {
  test(`T06 fault harness distinguishes ${mode} storage`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-harness-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let source = fs.readFileSync(path.join(__dirname, 'fixtures/tasks-cli-contract/cli.js'), 'utf8');
    if (mode === 'direct') source = source.replace('fs.renameSync(temporary, file);', 'fs.writeFileSync(file, fs.readFileSync(temporary));');
    if (mode === 'swallow') source = source.replace('fs.renameSync(temporary, file);', 'try { fs.renameSync(temporary, file); } catch {}');
    // File descriptor writes are outside this probe's supported tracing. They
    // must remain unverified, not pass just because the preload was present.
    if (mode === 'unobserved') source = source.replace('fs.renameSync(temporary, file);',
      "const fd = fs.openSync(file, 'w'); fs.writeSync(fd, fs.readFileSync(temporary)); fs.closeSync(fd);");
    const script = path.join(root, 'cli.js');
    fs.writeFileSync(script, source);
    const report = runTasksCliAtomicAcceptance({ workspaceRoot: root, commandArgv: [process.execPath, script] });
    assert.equal(report.status, mode === 'rename' ? 'passed' : mode === 'unobserved' ? 'unverified' : 'failed', JSON.stringify(report));
    if (mode === 'rename') assert.ok(report.operations.some(item => item.operation === 'rename-fault'));
  });
}
