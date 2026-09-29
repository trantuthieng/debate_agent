const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  // Codex/VS Code terminals may inherit this flag. If it reaches the downloaded
  // Electron binary, the workspace path is mistaken for a Node.js entry file.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index');
  const workspacePath = path.resolve(__dirname, 'fixture');
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmac-vscode-'));

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        `--user-data-dir=${path.join(profileRoot, 'user')}`,
        `--extensions-dir=${path.join(profileRoot, 'extensions')}`,
        workspacePath,
      ],
    });
  } finally {
    fs.rmSync(profileRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('VS Code Extension Host smoke test failed:', error);
  process.exitCode = 1;
});
