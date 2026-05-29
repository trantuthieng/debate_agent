import assert from 'node:assert/strict';
import test from 'node:test';

import { AppGeneratorService } from '../../src/services/appGeneratorService';
import { CodeGenerationService } from '../../src/services/codeGenerationService';
import { DependencyResolverService } from '../../src/services/dependencyResolverService';
import { TemplateMatcherService } from '../../src/services/templateMatcherService';
import type { FileModel, GeneratedApp, PromptModel } from '../../src/models';

test('app generator coordinates template, code, and dependency services', async () => {
  const prompt: PromptModel = { content: 'Sample prompt', timestamp: new Date().toISOString() };
  const generatedFiles: FileModel[] = [
    {
      filePath: 'README.md',
      fileContent: '# Sample',
      programmingLanguage: 'markdown',
    },
  ];

  const calls: unknown[][] = [];
  class MockTemplateMatcher extends TemplateMatcherService {
    override async matchTemplate(receivedPrompt: PromptModel): Promise<string> {
      calls.push(['matchTemplate', receivedPrompt]);
      return 'template-key';
    }
  }

  class MockCodeGenerator extends CodeGenerationService {
    override async generateCode(template: string, variables: Record<string, unknown>): Promise<FileModel[]> {
      calls.push(['generateCode', template, variables]);
      return generatedFiles;
    }
  }

  class MockDependencyResolver extends DependencyResolverService {
    override async resolveDependencies(app: GeneratedApp): Promise<string[]> {
      calls.push(['resolveDependencies', app]);
      return ['express'];
    }
  }

  const appGenerator = new AppGeneratorService(
    new MockTemplateMatcher(),
    new MockCodeGenerator(),
    new MockDependencyResolver()
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
  class FailingTemplateMatcher extends TemplateMatcherService {
    override async matchTemplate(): Promise<string> {
      throw new Error('template matcher should not run');
    }
  }

  const appGenerator = new AppGeneratorService(new FailingTemplateMatcher());

  await assert.rejects(
    () => appGenerator.generate({ content: '   ', timestamp: new Date().toISOString() }),
    /Prompt content cannot be empty/
  );
});

test('app generator surfaces missing template errors', async () => {
  class EmptyTemplateMatcher extends TemplateMatcherService {
    override async matchTemplate(): Promise<string> {
      return '';
    }
  }

  const appGenerator = new AppGeneratorService(new EmptyTemplateMatcher());

  await assert.rejects(
    () => appGenerator.generate({ content: 'Build something', timestamp: new Date().toISOString() }),
    /No template found for the given prompt/
  );
});
