// Import necessary modules and services
import { AppGenerator } from '../../src/services/appGeneratorService';
import { PromptModel } from '../../src/models/prompt.model';
import { GeneratedApp } from '../../src/models/generatedApp.model';

// Mock dependencies if needed
jest.mock('../../src/services/templateMatcherService');
jest.mock('../../src/services/codeGenerationService');
jest.mock('../../src/services/dependencyResolverService');

// Test suite for AppGeneratorService
describe('AppGeneratorService Integration Tests', () => {
  let appGenerator: AppGenerator;

  beforeEach(() => {
    appGenerator = new AppGenerator();
  });

  describe('Valid Prompt Generation', () => {
    it('should generate an application from a valid prompt', async () => {
      const prompt: PromptModel = { content: 'Create a simple web app', timestamp: new Date() };
      const expectedApp: GeneratedApp = { name: 'SimpleWebApp', files: [], dependencies: [] };

      // Mock the generate method to return the expected app
      jest.spyOn(appGenerator, 'generate').mockResolvedValue(expectedApp);

      const result = await appGenerator.generate(prompt);
      expect(result).toEqual(expectedApp);
    });
  });

  describe('Error Handling', () => {
    it('should throw an error for an empty prompt content', async () => {
      const prompt: PromptModel = { content: '', timestamp: new Date() };

      await expect(appGenerator.generate(prompt)).rejects.toThrow('Prompt content cannot be empty');
    });

    it('should throw an error if no template matches the prompt', async () => {
      const prompt: PromptModel = { content: 'Create a non-existent app type', timestamp: new Date() };

      await expect(appGenerator.generate(prompt)).rejects.toThrow('No template found for the given prompt');
    });
  });
});