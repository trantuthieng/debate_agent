const assert = require('node:assert/strict');
const test = require('node:test');

const { AppGeneratorService } = require('../../out/services/appGeneratorService');

test('app generator produces a default README app from a general prompt', async () => {
  const appGenerator = new AppGeneratorService();
  const result = await appGenerator.generate({
    content: 'Create a simple web app',
    timestamp: new Date(),
  });

  assert.equal(result.name, 'CreateASimple');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].filePath, 'README.md');
  assert.match(result.files[0].fileContent, /Template: default-template/);
  assert.deepEqual(result.dependencies, []);
});

test('app generator detects React dependencies from generated content', async () => {
  const appGenerator = new AppGeneratorService();
  const result = await appGenerator.generate({
    content: 'Create a react dashboard',
    timestamp: new Date(),
  });

  assert.equal(result.name, 'CreateAReact');
  assert.deepEqual(result.dependencies.sort(), ['react', 'react-dom']);
});

test('app generator rejects empty prompt content', async () => {
  const appGenerator = new AppGeneratorService();

  await assert.rejects(
    () => appGenerator.generate({ content: '', timestamp: new Date() }),
    /Prompt content cannot be empty/
  );
});
