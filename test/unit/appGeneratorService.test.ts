// appGeneratorService.test.ts
import { AppGeneratorService } from '../../src/services/appGeneratorService';
import { PromptModel } from '../../src/models/prompt.model';
import { GeneratedApp } from '../../src/models/generatedApp.model';

jest.mock('../../src/services/templateMatcherService');
jest.mock('../../src/services/codeGenerationService');
jest.mock('../../src/services/dependencyResolverService');

const mockTemplateMatcher = require('../../src/services/templateMatcherService').default;
const mockCodeGenerator = require('../../src/services/codeGenerationService').default;
const mockDependencyResolver = require('../../src/services/dependencyResolverService').default;

describe('AppGeneratorService', () => {
  let appGenerator: AppGeneratorService;

  beforeEach(() => {
    appGenerator = new AppGeneratorService();
    jest.clearAllMocks();
  });

  describe('generate', () => {
    describe('when prompt is valid', () => {
      it('should successfully generate an app', async () => {
        const mockPrompt: PromptModel = { content: 'Sample prompt', timestamp: new Date() };
        const mockGeneratedApp: GeneratedApp = { name: 'SampleApp', files: [], dependencies: [] };

        mockTemplateMatcher.match.mockResolvedValue('templateKey');
        mockCodeGenerator.generate.mockResolvedValue(mockGeneratedApp);
        mockDependencyResolver.resolveDependencies.mockResolvedValue([]);

        const result = await appGenerator.generate(mockPrompt);

        expect(mockTemplateMatcher.match).toHaveBeenCalledWith(mockPrompt);
        expect(mockCodeGenerator.generate).toHaveBeenCalledWith('templateKey', mockPrompt);
        expect(mockDependencyResolver.resolveDependencies).toHaveBeenCalledWith(mockGeneratedApp);
        expect(result).toEqual(mockGeneratedApp);
      });
    });

    describe('when prompt is invalid', () => {
      it('should throw an error for empty prompt', async () => {
        const mockPrompt: PromptModel = { content: '', timestamp: new Date() };

        mockTemplateMatcher.match.mockResolvedValue(null);

        await expect(appGenerator.generate(mockPrompt)).rejects.toThrow('Invalid prompt');
        expect(mockTemplateMatcher.match).toHaveBeenCalledWith(mockPrompt);
      });

      it('should throw an error when template matching fails', async () => {
        const mockPrompt: PromptModel = { content: 'Invalid prompt', timestamp: new Date() };

        mockTemplateMatcher.match.mockResolvedValue(null);

        await expect(appGenerator.generate(mockPrompt)).rejects.toThrow('Invalid prompt');
        expect(mockTemplateMatcher.match).toHaveBeenCalledWith(mockPrompt);
      });
    });
  });
});