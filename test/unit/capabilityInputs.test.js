const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentOrchestrator } = require('../../out/orchestrator/AgentOrchestrator');

function orchestratorFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-inputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new AgentOrchestrator(root);
}

// Share the locked brief without importing the benchmark (which starts real models).
const benchmarkPrompt = require('../../benchmarks/goals/brick-breaker.v1.json').goal;

test('exact Brick Breaker benchmark prompt does not imply a CV or runtime file input', async t => {
  assert.equal(typeof benchmarkPrompt, 'string', 'Keep this regression tied to the actual benchmark prompt');
  assert.match(benchmarkPrompt, /pause\/resume/);
  const orchestrator = orchestratorFor(t);
  await orchestrator.workspace.initialize();
  orchestrator.modelConfig = orchestrator.workspace.readModelConfig();
  orchestrator.modelConfig.assetLibrary = { ...orchestrator.modelConfig.assetLibrary, enabled: true };
  orchestrator.workspace.writeUserPrompt(benchmarkPrompt);
  const savedPrompt = orchestrator.workspace.readUserPrompt();

  assert.deepEqual(orchestrator._assessGoalCapabilities(benchmarkPrompt).needsUserFiles, []);
  await orchestrator._preflightCapabilities(benchmarkPrompt);

  assert.equal(orchestrator.workspace.readUserPrompt(), savedPrompt);
  assert.equal(orchestrator.fileManager.fileExists('examples/sample_resume.txt'), false);
  assert.doesNotMatch(orchestrator.workspace.readFile(orchestrator.workspace.assumptionsPath) ?? '', /CV\/resume|runtime inputs/i);
});

test('resume controls and continuation verbs do not require a document', t => {
  const orchestrator = orchestratorFor(t);
  for (const prompt of [
    'Build a game with pause and resume controls.',
    'Resume the previous workflow from its checkpoint.',
    'Build a downloader that can resume downloads.',
    'Build a music player with a resume playback button.',
    'Create a resume button for the game menu.',
    'Add your resume button to the toolbar.',
    'Build a background job runner that supports pause/resume.',
  ]) {
    assert.deepEqual(orchestrator._assessGoalCapabilities(prompt).needsUserFiles, [], prompt);
  }
});

test('actual CV and resume documents still produce an explicit user-file requirement', t => {
  const orchestrator = orchestratorFor(t);
  for (const prompt of [
    'Read my resume and find suitable jobs.',
    'Build a resume parser and rank candidate matches.',
    'Analyze the uploaded resume.',
    'Review resumes for software engineer roles.',
    'Build a tool to process resume.pdf.',
    'Create a professional résumé.',
    'Build a résumé reviewer.',
    'Create a resume for a software engineer.',
    'Parse a curriculum vitae.',
    'Tạo agent đọc CV người dùng và tìm việc phù hợp.',
    'Build a resume parser with pause/resume for batch processing.',
  ]) {
    assert.match(orchestrator._assessGoalCapabilities(prompt).needsUserFiles.join('\n'), /CV\/resume/, prompt);
  }
});
