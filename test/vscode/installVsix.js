const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runVSCodeCommand } = require('@vscode/test-electron');

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;

  const manifest = require('../../package.json');
  const vsixPath = path.resolve(
    __dirname,
    '../..',
    'dist',
    `${manifest.name}-${manifest.version}.vsix`
  );
  assert.ok(fs.existsSync(vsixPath), `VSIX does not exist: ${vsixPath}`);

  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmac-vsix-'));
  const extensionsDir = path.join(profileRoot, 'extensions');
  const userDataDir = path.join(profileRoot, 'user');
  try {
    await runVSCodeCommand([
      `--extensions-dir=${extensionsDir}`,
      `--user-data-dir=${userDataDir}`,
      '--install-extension',
      vsixPath,
      '--force',
    ]);

    const installed = fs.readdirSync(extensionsDir)
      .find(name => name.startsWith(`${manifest.publisher}.${manifest.name}-${manifest.version}`));
    assert.ok(installed, 'VS Code CLI returned success but the packaged extension was not installed.');
    const installedManifest = JSON.parse(
      fs.readFileSync(path.join(extensionsDir, installed, 'package.json'), 'utf8')
    );
    assert.equal(installedManifest.name, manifest.name);
    assert.equal(installedManifest.version, manifest.version);
    assert.ok(fs.existsSync(path.join(extensionsDir, installed, 'out', 'extension.js')));
    console.log(`VSIX install smoke test passed: ${installed}`);
  } finally {
    fs.rmSync(profileRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('VSIX install smoke test failed:', error);
  process.exitCode = 1;
});
