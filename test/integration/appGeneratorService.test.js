"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Import necessary modules and services
const appGeneratorService_1 = require("../../src/services/appGeneratorService");
// Mock dependencies if needed
jest.mock('../../src/services/templateMatcherService');
jest.mock('../../src/services/codeGenerationService');
jest.mock('../../src/services/dependencyResolverService');
// Test suite for AppGeneratorService
describe('AppGeneratorService', () => {
    let appGenerator;
    beforeEach(() => {
        appGenerator = new appGeneratorService_1.AppGenerator();
    });
    // Existing test case to ensure basic functionality
    it('should generate an application from a valid prompt', async () => {
        const prompt = { content: 'Create a simple web app', timestamp: new Date() };
        const expectedApp = { name: 'SimpleWebApp', files: [], dependencies: [] };
        // Mock the generate method to return the expected app
        jest.spyOn(appGenerator, 'generate').mockResolvedValue(expectedApp);
        const result = await appGenerator.generate(prompt);
        expect(result).toEqual(expectedApp);
    });
    // New test case to handle empty prompt content
    it('should throw an error for an empty prompt content', async () => {
        const prompt = { content: '', timestamp: new Date() };
        await expect(appGenerator.generate(prompt)).rejects.toThrow('Prompt content cannot be empty');
    });
    // New test case to handle invalid template matching
    it('should throw an error if no template matches the prompt', async () => {
        const prompt = { content: 'Create a non-existent app type', timestamp: new Date() };
        await expect(appGenerator.generate(prompt)).rejects.toThrow('No template found for the given prompt');
    });
});
//# sourceMappingURL=appGeneratorService.test.js.map