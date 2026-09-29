const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { CommandPolicy } = require('../../out/terminal/CommandPolicy');
const { TerminalRunner } = require('../../out/terminal/TerminalRunner');

// These strings are classification fixtures only. Never execute them.
const root = path.resolve('/workspace/project');
const external = path.resolve(root, '../outside.txt');
const risk = (policy, command) => policy.evaluate(command, root).risk;

for (const network of [false, true]) {
  for (const externalWrites of [false, true]) {
    test(`command flags are independent: network=${network}, externalWrites=${externalWrites}`, () => {
      const policy = new CommandPolicy({
        requireApprovalForNetwork: network,
        requireApprovalForExternalWrites: externalWrites,
        approvedPrefixes: ['curl', 'echo'],
      });
      assert.equal(risk(policy, 'npm install'), network ? 'needs_approval' : 'safe');
      assert.equal(risk(policy, 'curl https://example.invalid'), network ? 'needs_approval' : 'safe');
      assert.equal(risk(policy, 'echo test > ../outside.txt'), externalWrites ? 'needs_approval' : 'safe');
      assert.equal(risk(policy, `echo test > "${external}"`), externalWrites ? 'needs_approval' : 'safe');
      assert.equal(risk(policy, 'npm install > ../outside.txt'), network || externalWrites ? 'needs_approval' : 'safe');
      assert.equal(risk(policy, 'npm test > local.log'), 'safe');
    });
  }
}

test('network detection examines normalized argv and options before approved prefixes', () => {
  const policy = new CommandPolicy({ approvedPrefixes: ['npm', 'python3', '/usr/bin/curl'] });
  for (const command of [
    'npm ci', 'pnpm add example', 'yarn', 'pip3 install -r requirements.txt',
    'npm --silent install', 'n"pm" "install"', 'python3 -m pip install example',
    '/usr/bin/curl https://example.invalid', 'curl.exe https://example.invalid', 'git -C . fetch', 'npx example',
  ]) {
    assert.equal(risk(policy, command), 'needs_approval', command);
  }
});

test('output redirections resolve quoted and adjacent relative/absolute targets', () => {
  const policy = new CommandPolicy();
  for (const command of [
    'echo test>../outside.txt', 'node app.js 2>>../outside.txt',
    'npm test &>> "../outside file.txt"', 'echo test >sub/../../outside.txt',
    `npm test >>'${external}'`, 'echo test >|../outside.txt',
    'echo test <>../outside.txt', 'echo test >',
  ]) {
    assert.equal(risk(policy, command), 'needs_approval', command);
  }
  for (const command of [
    'node app.js > "local file.log"', 'npm test 2>>out.log',
    'echo test >..cache', 'echo test > sub/../out.log',
    'npm test 2>&1', 'npm test &>out.log',
    `npm test > "${path.join(root, 'local file.log')}"`,
    'echo "literal > ../outside.txt"',
  ]) {
    assert.equal(risk(policy, command), 'safe', command);
  }
  assert.equal(policy.evaluate('echo test > local.log').risk, 'needs_approval', 'unknown working directory');
});

test('compound commands and substitutions cannot fall through the default safe decision', () => {
  const policy = new CommandPolicy({ requireApprovalForNetwork: false, requireApprovalForExternalWrites: false });
  for (const command of [
    'npm test && echo done', 'npm test; echo done', 'npm test || echo retry',
    'npm test | cat', 'npm test & echo done', 'npm test\necho done',
    'npm test # harmless comment\necho next',
    'echo $(whoami)', 'echo `whoami`', 'echo "$HOME"', 'echo test > ~/outside.txt',
    'echo test > $TARGET', 'npm test <(echo input)', 'echo "unterminated',
  ]) {
    assert.equal(risk(policy, command), 'needs_approval', command);
  }
  assert.equal(risk(policy, 'echo "literal ; && | >"'), 'safe');
  assert.equal(risk(policy, "echo 'literal $HOME'"), 'safe');
  assert.equal(risk(policy, 'npm test # comment only'), 'safe');
});

test('inline interpreters need approval even with approved prefixes and disabled I/O flags', () => {
  const policy = new CommandPolicy({
    requireApprovalForNetwork: false, requireApprovalForExternalWrites: false,
    approvedPrefixes: ['bash', 'node', 'python3'],
  });
  for (const command of [
    'node -e "require(\'fs\').writeFileSync(\'../outside.txt\', \'x\')"',
    'node --eval="console.log(1)"', 'node -p "1+1"', 'node -r ./hook.js app.js',
    'python3 -c "print(1)"', 'python3 -cprint(1)',
    'bash -c "echo test"', '/bin/sh script.sh', 'node -', 'node.exe -e "1"',
    'env node app.js', 'MODE=test bash script.sh', '. ./script.sh',
  ]) {
    assert.equal(risk(policy, command), 'needs_approval', command);
  }
  for (const command of ['node app.js', 'node --check app.js', 'node -c app.js', 'node --test test/*.js', 'python3 app.py', 'python3 -m unittest', 'node --version']) {
    assert.equal(risk(policy, command), 'safe', command);
  }
});

test('external write operands and destination options require approval with network disabled', () => {
  const policy = new CommandPolicy({ requireApprovalForNetwork: false });
  for (const command of [
    'npm install --prefix ../elsewhere', 'npm --prefix=../elsewhere install',
    'npm install -g example', 'npm install --location=global example', 'pip3 install --target ../elsewhere example',
    'pnpm --dir ../elsewhere install', 'pip3 install -t ../elsewhere example',
    'npm install --cache ../elsewhere',
    'npm run build -- --output ../outside.txt', 'go build -o../outside',
    'tee ../outside.txt', 'cp local.txt ../outside.txt', 'touch ../outside.txt',
    'dd if=local.txt of=../outside.txt',
  ]) {
    assert.equal(risk(policy, command), 'needs_approval', command);
  }
  for (const command of ['npm install --prefix .', 'npm test', 'go build -o ./bin/app', 'touch local.txt']) {
    assert.equal(risk(policy, command), 'safe', command);
  }
});

test('explicitly approved install uses the authorized execution path without weakening policy', async () => {
  const runner = new TerminalRunner(root, path.join(root, 'unused.log'));
  const calls = [];
  // Stub the only execution method: no fixture shell command reaches the OS.
  runner._run = async (command, timeoutMs) => {
    calls.push({ command, timeoutMs });
    return { command, exitCode: 0, stdout: '', stderr: '', durationMs: 0, success: true };
  };
  await assert.rejects(runner.runSafeCommand('npm install'));
  assert.equal(calls.length, 0);
  assert.equal((await runner.runApprovedCommand('npm install', 600000)).success, true);
  assert.deepEqual(calls, [{ command: 'npm install', timeoutMs: 600000 }]);
  assert.equal(runner.evaluateCommand('npm install').risk, 'needs_approval');
});
