"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// appGeneratorService.test.ts
const appGeneratorService_1 = require("../../src/services/appGeneratorService");
jest.mock('../../src/services/templateMatcherService');
jest.mock('../../src/services/codeGenerationService');
jest.mock('../../src/services/dependencyResolverService');
const mockTemplateMatcher = require('../../src/services/templateMatcherService').default;
const mockCodeGenerator = require('../../src/services/codeGenerationService').default;
const mockDependencyResolver = require('../../src/services/dependencyResolverService').default;
describe('AppGeneratorService', () => {
    let appGenerator;
    beforeEach(() => {
        appGenerator = new appGeneratorService_1.AppGeneratorService();
    });
    it('should generate an app with valid prompt', async () => {
        const mockPrompt = { content: 'Sample prompt', timestamp: new Date() };
        const mockGeneratedApp = { name: 'SampleApp', files: [], dependencies: [] };
        mockTemplateMatcher.match.mockResolvedValue('templateKey');
        mockCodeGenerator.generate.mockResolvedValue(mockGeneratedApp);
        mockDependencyResolver.resolveDependencies.mockResolvedValue([]);
        const result = await appGenerator.generate(mockPrompt);
        expect(result).toEqual(mockGeneratedApp);
    });
    it('should throw an error with invalid prompt', async () => {
        const mockPrompt = { content: '', timestamp: new Date() };
        mockTemplateMatcher.match.mockResolvedValue(null);
        await expect(appGenerator.generate(mockPrompt)).rejects.toThrow('Invalid prompt');
    });
});
//# sourceMappingURL=appGeneratorService.test.js.map