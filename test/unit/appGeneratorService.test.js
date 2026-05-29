const assert = require('node:assert/strict');
const test = require('node:test');

const { AppGeneratorService } = require('../../out/services/appGeneratorService');

test('app generator coordinates template, code, and dependency services', async () => {
  const prompt = { content: 'Sample prompt', timestamp: new Date() };
  const generatedFiles = [
    {
      filePath: 'README.md',
      fileContent: '# Sample',
      programmingLanguage: 'markdown',
    },
  ];

  const calls = [];
  const appGenerator = new AppGeneratorService(
    {
      matchTemplate: async (receivedPrompt) => {
        calls.push(['matchTemplate', receivedPrompt]);
        return 'template-key';
      },
    },
    {
      generateCode: async (template, variables) => {
        calls.push(['generateCode', template, variables]);
        return generatedFiles;
      },
    },
    {
      resolveDependencies: async (app) => {
        calls.push(['resolveDependencies', app]);
        return ['express'];
      },
    }
  );

  const result = await appGenerator.generate(prompt);

  assert.equal(result.name, 'SamplePrompt');
  assert.equal(result.dependencies.length, 1);
  assert.equal(result.dependencies[0], 'express');
  assert.deepEqual(result.files, generatedFiles);
  assert.equal(calls[0][0], 'matchTemplate');
  assert.equal(calls[1][0], 'generateCode');
  assert.equal(calls[1][1], 'template-key');
  assert.deepEqual(calls[1][2], {
    prompt: 'Sample prompt',
    timestamp: prompt.timestamp,
  });
  assert.equal(calls[2][0], 'resolveDependencies');
});

test('app generator rejects empty prompts before matching templates', async () => {
  const appGenerator = new AppGeneratorService({
    matchTemplate: async () => {
      throw new Error('template matcher should not run');
    },
  });

  await assert.rejects(
    () => appGenerator.generate({ content: '   ', timestamp: new Date() }),
    /Prompt content cannot be empty/
  );
});

test('app generator surfaces missing template errors', async () => {
  const appGenerator = new AppGeneratorService({
    matchTemplate: async () => '',
  });

  await assert.rejects(
    () => appGenerator.generate({ content: 'Build something', timestamp: new Date() }),
    /No template found for the given prompt/
  );
});
