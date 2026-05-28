import * as vscode from 'vscode';
import type { AppGenerator } from '../services/appGeneratorService';
import type { GeneratedApp, PromptModel } from '../models';

/**
 * Command to generate an application from a user prompt.
 * This command is registered in the extension's activation function.
 */
export class GenerateAppCommand {
  private appGenerator: AppGenerator;

  constructor(appGenerator: AppGenerator) {
    this.appGenerator = appGenerator;
  }

  /**
   * Execute the command to generate an application.
   * @param context The VSCode extension context
   * @returns Promise that resolves when the command completes
   */
  public async execute(_context: vscode.ExtensionContext): Promise<void> {
    try {
      const promptContent = await this.getUserPrompt();
      if (!promptContent) {
        return;
      }

      const prompt: PromptModel = this.createPromptModel(promptContent);

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Generating Application...',
        cancellable: false,
      }, async (progress) => {
        progress.report({ message: 'Processing prompt...' });
        const generatedApp = await this.appGenerator.generate(prompt);
        progress.report({ message: 'Writing files...' });
        await this.writeGeneratedApp(generatedApp);
      });

      vscode.window.showInformationMessage('Application generated successfully!');
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Get user prompt through input box with validation.
   * @returns User prompt or undefined if cancelled
   */
  private async getUserPrompt(): Promise<string | undefined> {
    return await vscode.window.showInputBox({
      prompt: 'Enter your application requirements:',
      placeHolder: 'e.g., Create a React app with TypeScript',
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Please enter a valid prompt';
        }
        return null;
      },
    });
  }

  /**
   * Create a prompt model from user input.
   * @param content The user's prompt content
   * @returns Formatted prompt model
   */
  private createPromptModel(content: string): PromptModel {
    return {
      content: content,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Write the generated application files to the workspace.
   * @param app The generated application
   */
  private async writeGeneratedApp(app: GeneratedApp): Promise<void> {
    // Implementation for writing files to the workspace
    // This would use vscode.workspace.fs or similar APIs
    console.log(`Generated app: ${app.name} with ${app.files.length} files`);
  }

  /**
   * Handle errors and show appropriate messages to the user.
   * @param error The error to handle
   */
  private handleError(error: unknown): void {
    let message = 'An unknown error occurred';
    if (error instanceof Error) {
      message = error.message;
    }
    vscode.window.showErrorMessage(`Failed to generate application: ${message}`);
    console.error('Error generating application:', error);
  }
}
