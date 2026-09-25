const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadEnvFile } = require('../../out/utils/loadEnvFile');

function withTempEnvFile(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadenv-test-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('loads KEY=VALUE pairs from a .env file into process.env', t => {
  const file = withTempEnvFile(t, 'FOO_TEST_A=hello\nFOO_TEST_B=world\n');
  t.after(() => { delete process.env.FOO_TEST_A; delete process.env.FOO_TEST_B; });

  loadEnvFile(file);

  assert.equal(process.env.FOO_TEST_A, 'hello');
  assert.equal(process.env.FOO_TEST_B, 'world');
});

test('ignores blank lines and #-comments', t => {
  const file = withTempEnvFile(t, '# a comment\n\nFOO_TEST_C=value\n  # indented comment\n');
  t.after(() => { delete process.env.FOO_TEST_C; });

  loadEnvFile(file);

  assert.equal(process.env.FOO_TEST_C, 'value');
});

test('strips a single layer of matching quotes from the value', t => {
  const file = withTempEnvFile(t, 'FOO_TEST_D="quoted value"\nFOO_TEST_E=\'single quoted\'\n');
  t.after(() => { delete process.env.FOO_TEST_D; delete process.env.FOO_TEST_E; });

  loadEnvFile(file);

  assert.equal(process.env.FOO_TEST_D, 'quoted value');
  assert.equal(process.env.FOO_TEST_E, 'single quoted');
});

test('a real environment variable always wins over the file', t => {
  process.env.FOO_TEST_F = 'from-shell';
  t.after(() => { delete process.env.FOO_TEST_F; });
  const file = withTempEnvFile(t, 'FOO_TEST_F=from-file\n');

  loadEnvFile(file);

  assert.equal(process.env.FOO_TEST_F, 'from-shell');
});

test('a missing .env file is not an error', () => {
  assert.doesNotThrow(() => loadEnvFile('/nonexistent/path/that/does/not/exist/.env'));
});
