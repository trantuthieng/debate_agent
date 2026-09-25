const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXTENSION_ID = 'local-dev.local-multi-agent-coder';
const EXPECTED_COMMANDS = [
  'localMultiAgentCoder.openPanel',
  'localMultiAgentCoder.startNewProject',
  'localMultiAgentCoder.designAgentTeam',
  'localMultiAgentCoder.runAutonomousGoal',
  'localMultiAgentCoder.resumeWorkflow',
  'localMultiAgentCoder.stopWorkflow',
  'localMultiAgentCoder.showAgentNotes',
  'localMultiAgentCoder.openSettingsFile',
  'localMultiAgentCoder.configureYouTube',
];

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not discovered by the Extension Host.`);

  await extension.activate();
  assert.equal(extension.isActive, true, 'Extension did not activate.');

  const registeredCommands = new Set(await vscode.commands.getCommands(true));
  for (const command of EXPECTED_COMMANDS) {
    assert.ok(registeredCommands.has(command), `Command was not registered: ${command}`);
  }

  // These commands are safe without Ollama or credentials and exercise the
  // actual extension registration and sidebar focus path inside VS Code.
  await vscode.commands.executeCommand('localMultiAgentCoder.openPanel');
  await vscode.commands.executeCommand('localMultiAgentCoder.stopWorkflow');

  console.log(`Extension Host smoke test passed (${EXPECTED_COMMANDS.length} commands).`);
}

module.exports = { run };
