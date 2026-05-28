// src/services/appGeneratorService.ts
import type { GeneratedApp, PromptModel } from '../models';
import { CodeGenerationService } from './codeGenerationService';
import { DependencyResolverService } from './dependencyResolverService';
import { TemplateMatcherService } from './templateMatcherService';

/**
 * Interface for the application generator service.
 */
export interface AppGenerator {
  generate(prompt: PromptModel): Promise<GeneratedApp>;
}

/**
 * Service responsible for generating applications from user prompts.
 * This service orchestrates the template matching, code generation, and dependency resolution process.
 */
export class AppGeneratorService implements AppGenerator {
  constructor(
    private readonly templateMatcher = new TemplateMatcherService(),
    private readonly codeGenerator = new CodeGenerationService(),
    private readonly dependencyResolver = new DependencyResolverService()
  ) {}

  /**
   * Generates an application based on the provided prompt.
   * 
   * @param prompt - The user prompt containing the application requirements
   * @returns A promise that resolves to the generated application
   * @throws Error if the prompt is empty or no template is found
   */
  async generate(prompt: PromptModel): Promise<GeneratedApp> {
    const promptContent = prompt.content.trim();
    
    if (!promptContent) {
      throw new Error('Prompt content cannot be empty');
    }

    const template = await this.templateMatcher.matchTemplate(prompt);
    if (!template) {
      throw new Error('No template found for the given prompt');
    }

    const files = await this.codeGenerator.generateCode(template, {
      prompt: promptContent,
      timestamp: prompt.timestamp,
    });

    const generatedApp: GeneratedApp = {
      name: this.deriveAppName(promptContent),
      files,
      dependencies: [],
    };

    generatedApp.dependencies = await this.dependencyResolver.resolveDependencies(generatedApp);

    return generatedApp;
  }

  /**
   * Derives an application name from the prompt content.
   * 
   * @param promptContent - The content of the user prompt
   * @returns A sanitized and formatted application name
   */
  private deriveAppName(promptContent: string): string {
    // Remove special characters and extra spaces
    const sanitized = promptContent
      .replace(/[^a-z0-9\s-]/gi, ' ')
      .trim()
      .replace(/\s+/g, ' ');

    // Extract first 3 words
    const words = sanitized.split(' ').filter(Boolean).slice(0, 3);

    // Return default name if no words found
    if (words.length === 0) {
      return 'GeneratedApp';
    }

    // Capitalize first letter of each word and join
    return words
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }
}
