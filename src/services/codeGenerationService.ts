// src/services/codeGenerationService.ts
import type { FileModel } from '../models';

/**
 * Custom error for code generation failures
 */
class CodeGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeGenerationError';
  }
}

/**
 * Service responsible for generating code from templates and variables
 */
export class CodeGenerationService {
  /**
   * Generates code files based on a template and provided variables
   * @param template - The template name or identifier
   * @param variables - Object containing variables for template substitution
   * @returns Promise resolving to array of generated FileModel objects
   * @throws CodeGenerationError if generation fails
   */
  async generateCode(
    template: string,
    variables: Record<string, unknown>
  ): Promise<FileModel[]> {
    try {
      // Validate inputs
      this.validateInputs(template, variables);

      // Extract prompt with fallback
      const prompt = this.extractPrompt(variables);

      // Generate the base files
      const files = this.generateBaseFiles(template, prompt);

      return files;
    } catch (error) {
      if (error instanceof Error) {
        throw new CodeGenerationError(`Failed to generate code: ${error.message}`);
      }
      throw new CodeGenerationError('Failed to generate code due to unknown error');
    }
  }

  /**
   * Validates the input parameters
   * @param template - Template to validate
   * @param variables - Variables to validate
   * @throws Error if validation fails
   */
  private validateInputs(
    template: string,
    variables: Record<string, unknown>
  ): void {
    if (!template || typeof template !== 'string') {
      throw new Error('Template must be a non-empty string');
    }

    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
      throw new Error('Variables must be a non-null object');
    }
  }

  /**
   * Extracts the prompt from variables with a fallback value
   * @param variables - Variables object to extract prompt from
   * @returns Extracted prompt string
   */
  private extractPrompt(variables: Record<string, unknown>): string {
    return typeof variables.prompt === 'string' && variables.prompt.trim() !== ''
      ? variables.prompt
      : 'Generated application';
  }

  /**
   * Generates the base set of files for the application
   * @param template - Template name
   * @param prompt - User prompt
   * @returns Array of FileModel objects
   */
  private generateBaseFiles(template: string, prompt: string): FileModel[] {
    return [
      {
        filePath: 'README.md',
        fileContent: `# Generated App

Template: ${template}

Prompt: ${prompt}
`,
        programmingLanguage: 'markdown',
      },
    ];
  }
}
