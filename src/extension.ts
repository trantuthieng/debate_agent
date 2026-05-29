import * as vscode from 'vscode';
import * as path from 'path';
import { PanelProvider } from './webview/PanelProvider';
import { initLogger } from './utils/logging';

// Extension activation entry point
export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = createOutputChannel();
  context.subscriptions.push(outputChannel);

  const workspaceRoot = getWorkspaceRoot();
  const initialLogPath = getInitialLogPath(workspaceRoot);
  initLogger(outputChannel, initialLogPath);

  outputChannel.appendLine('[Local Multi-Agent Coder] Extension activated.');

  const panelProvider = new PanelProvider(context);
  registerWebviewPanelProvider(context, panelProvider);
  registerCommands(context, panelProvider, outputChannel);

  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      const newLogPath = path.join(root, '.agent-workspace', 'logs', 'workflow.log');
      initLogger(outputChannel, newLogPath);
    }
  }, undefined, context.subscriptions);

  outputChannel.appendLine('[Local Multi-Agent Coder] All commands registered.');
}

// Extension deactivation entry point
export function deactivate(): void {
  // No cleanup required - all resources are managed by VS Code context subscriptions
}

function createOutputChannel(): vscode.OutputChannel {
  return vscode.window.createOutputChannel('Local Multi-Agent Coder');
}

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function getInitialLogPath(workspaceRoot: string): string {
  return workspaceRoot
    ? path.join(workspaceRoot, '.agent-workspace', 'logs', 'workflow.log')
    : '';
}

function registerWebviewPanelProvider(context: vscode.ExtensionContext, panelProvider: PanelProvider): void {
  const viewRegistration = vscode.window.registerWebviewViewProvider(
    PanelProvider.viewId,
    panelProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  );
  context.subscriptions.push(viewRegistration);
}

function registerCommands(context: vscode.ExtensionContext, panelProvider: PanelProvider, outputChannel: vscode.OutputChannel): void {
  const commands: Array<[string, () => void | Promise<void>]> = [
    ['localMultiAgentCoder.openPanel', () => panelProvider.openPanel()],
    ['localMultiAgentCoder.startNewProject', () => panelProvider.startNewProject()],
    ['localMultiAgentCoder.resumeWorkflow', () => panelProvider.resumeWorkflow()],
    ['localMultiAgentCoder.stopWorkflow', () => panelProvider.stopWorkflow()],
    ['localMultiAgentCoder.showAgentNotes', () => panelProvider.showAgentNotes()],
    ['localMultiAgentCoder.openSettingsFile', () => panelProvider.openSettingsFile()],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await handler();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Local Multi-Agent Coder: ${msg}`);
          outputChannel.appendLine(`[ERROR] Command ${id}: ${msg}`);
        }
      })
    );
  }
}
