import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { AgentOrchestrator } from '../orchestrator/AgentOrchestrator';
import { getWebviewContent } from './webviewHtml';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  ProjectState,
  TaskItem,
  TimelineEntry,
  AgentActivity,
  UserQuestion,
  WorkflowPhase,
} from '../types';
import { logInfo, logWarn } from '../utils/logging';

// -----------------------------------------------------------------------
// PanelProvider — WebviewViewProvider for the sidebar
// -----------------------------------------------------------------------
export class PanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'localMultiAgentCoder.sidebar';

  private _view?: vscode.WebviewView;
  private _orchestrator?: AgentOrchestrator;
  private readonly _context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
  }

  // ------------------------------------------------------------------
  // vscode.WebviewViewProvider implementation
  // ------------------------------------------------------------------

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };

    webviewView.webview.html = this._getHtml();

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(
      (raw: unknown) => this._handleWebviewMessage(raw),
      undefined,
      this._context.subscriptions
    );

    // If a workflow was running, restore state
    if (this._orchestrator) {
      this._postState(this._orchestrator.getState());
      this._postActivities(this._orchestrator.getActivities());
    }
  }

  // ------------------------------------------------------------------
  // Command handlers (called from extension.ts)
  // ------------------------------------------------------------------

  async openPanel(): Promise<void> {
    // Focus the sidebar view
    await vscode.commands.executeCommand(`${PanelProvider.viewId}.focus`);
  }

  async startNewProject(): Promise<void> {
    const prompt = await vscode.window.showInputBox({
      prompt: 'Describe the project you want to build',
      placeHolder: 'Build a REST API in Node.js with Express...',
      ignoreFocusOut: true,
    });
    if (!prompt) { return; }

    if (this._view) {
      this._post({ type: 'info', message: 'Starting project from command palette.' });
    }
    await this._startProject(prompt);
  }

  async resumeWorkflow(): Promise<void> {
    await this._resumeWorkflow();
  }

  stopWorkflow(): void {
    this._orchestrator?.stop();
    this._post({ type: 'info', message: 'Stop requested.' });
  }

  async showAgentNotes(): Promise<void> {
    const root = this._getWorkspaceRoot();
    if (!root) { return; }
    const agentsDir = path.join(root, '.agent-workspace', 'agents');
    const uri = vscode.Uri.file(agentsDir);
    await vscode.commands.executeCommand('revealFileInOS', uri);
  }

  async openSettingsFile(): Promise<void> {
    const root = this._getWorkspaceRoot();
    if (!root) { return; }
    const configPath = path.join(root, '.agent-workspace', 'model_config.json');
    const uri = vscode.Uri.file(configPath);
    try {
      await vscode.window.showTextDocument(uri, { preview: false });
    } catch {
      vscode.window.showWarningMessage(
        'Settings file not found. Start a project first to generate it.'
      );
    }
  }

  // ------------------------------------------------------------------
  // Webview message handling
  // ------------------------------------------------------------------

  private async _handleWebviewMessage(raw: unknown): Promise<void> {
    if (!this._isWebviewMessage(raw)) {
      logWarn('Ignored malformed webview message.');
      return;
    }

    const message = raw;
    logInfo(`Webview message: ${message.type}`);

    switch (message.type) {
      case 'ready':
      case 'requestState':
        if (this._orchestrator) {
          this._postState(this._orchestrator.getState());
        } else {
          await this._postPersistedState();
        }
        break;

      case 'startProject':
        await this._startProject(message.prompt);
        break;

      case 'resumeWorkflow':
        await this._resumeWorkflow();
        break;

      case 'stopWorkflow':
        this._orchestrator?.stop();
        break;

      case 'submitAnswer':
        if (!this._orchestrator) { break; }
        this._orchestrator.submitAnswer(message.questionId, message.answer);
        this._postState(this._orchestrator.getState());

        // Auto-resume only after all pending questions have been answered.
        if (
          !this._orchestrator.isRunning() &&
          this._orchestrator.getState().status === 'waiting_for_user' &&
          this._orchestrator.getState().openQuestions.length === 0
        ) {
          await this._resumeWorkflow();
        }
        break;

      case 'openNotes':
        await this.showAgentNotes();
        break;

      case 'openSettings':
        await this.openSettingsFile();
        break;

      case 'approvePatch':
        this._orchestrator?.resolvePatchApproval(message.patchId, message.approved);
        break;

      case 'approveCommand':
        this._orchestrator?.resolveCommandApproval(message.commandId, message.approved);
        break;
    }
  }

  // ------------------------------------------------------------------
  // Orchestrator management
  // ------------------------------------------------------------------

  private async _startProject(prompt: string): Promise<void> {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      vscode.window.showWarningMessage('Enter a project description before starting.');
      return;
    }

    if (this._orchestrator?.isRunning()) {
      vscode.window.showWarningMessage('A workflow is already running. Stop it before starting a new project.');
      return;
    }

    const root = this._getWorkspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage(
        'No workspace folder open. Please open a folder before starting the agent workflow.'
      );
      return;
    }

    this._orchestrator = this._createOrchestrator(root);

    // Check Ollama connection first
    const { OllamaClient } = await import('../ollama/OllamaClient');
    const { AgentWorkspace } = await import('../workspace/AgentWorkspace');
    const ws = new AgentWorkspace(root);
    await ws.initialize();
    const config = ws.readModelConfig();
    const client = new OllamaClient(config.ollamaBaseUrl, undefined, config.requestTimeoutMs);
    const connected = await client.checkConnection();
    if (!connected) {
      vscode.window.showErrorMessage(
        `Cannot connect to Ollama at ${config.ollamaBaseUrl}.\nPlease start Ollama and try again.`,
        'Dismiss'
      );
      this._post({
        type: 'error',
        message: `Cannot connect to Ollama at ${config.ollamaBaseUrl}. Please start Ollama and try again.`,
      });
      return;
    }

    this._post({ type: 'appendLog', log: 'Starting workflow...', level: 'info' });
    // Non-blocking: run the workflow and handle errors
    this._orchestrator.start(trimmedPrompt).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      this._post({ type: 'error', message: msg });
    });
  }

  private async _resumeWorkflow(): Promise<void> {
    const root = this._getWorkspaceRoot();
    if (!root) { return; }

    if (!this._orchestrator) {
      this._orchestrator = this._createOrchestrator(root);
    }

    this._post({ type: 'appendLog', log: 'Resuming workflow...', level: 'info' });
    this._orchestrator.resume().catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      this._post({ type: 'error', message: msg });
    });
  }

  private _createOrchestrator(workspaceRoot: string): AgentOrchestrator {
    const orchestrator = new AgentOrchestrator(workspaceRoot);

    orchestrator.setCallbacks({
      onPhaseChange: (phase: WorkflowPhase, message: string) => {
        this._post({ type: 'updatePhase', phase, message });
      },
      onLog: (msg: string, level: 'info' | 'warn' | 'error') => {
        this._post({ type: 'appendLog', log: msg, level });
      },
      onQuestionNeeded: (question: UserQuestion) => {
        this._post({ type: 'askQuestion', question });
      },
      onTaskUpdate: (tasks: TaskItem[]) => {
        this._post({ type: 'updateTasks', tasks });
      },
      onTimelineUpdate: (timeline: TimelineEntry[]) => {
        this._post({ type: 'updateTimeline', timeline });
      },
      onActivityUpdate: (activities: AgentActivity[]) => {
        this._postActivities(activities);
      },
      onComplete: (report: string) => {
        this._post({ type: 'finalReport', report });
      },
      onError: (message: string) => {
        this._post({ type: 'error', message });
        vscode.window.showErrorMessage(`Agent Workflow Error: ${message}`);
      },
      onStateUpdate: (state: ProjectState) => {
        this._postState(state);
      },
      onPatchApprovalNeeded: (patchId: string, preview: string, targetFiles: string[]) => {
        this._post({ type: 'showPatchApproval', patchId, preview, targetFiles });
        if (!this._view) {
          vscode.window.showWarningMessage(
            `Approve file changes for patch ${patchId}?`,
            { modal: true, detail: targetFiles.join('\n') },
            'Apply',
            'Reject'
          ).then(selection => {
            orchestrator.resolvePatchApproval(patchId, selection === 'Apply');
          });
        }
      },
      onCommandApprovalNeeded: (commandId: string, command: string, reason: string) => {
        this._post({ type: 'showCommandApproval', commandId, command, reason });
        if (!this._view) {
          vscode.window.showWarningMessage(
            `Approve command?\n\n${command}`,
            { modal: true, detail: reason },
            'Run',
            'Reject'
          ).then(selection => {
            orchestrator.resolveCommandApproval(commandId, selection === 'Run');
          });
        }
      },
    });

    return orchestrator;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private _post(message: ExtensionToWebviewMessage): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private _postState(state: ProjectState): void {
    this._post({ type: 'updateState', state });
  }

  private _postActivities(activities: AgentActivity[]): void {
    this._post({ type: 'updateActivities', activities });
  }

  private async _postPersistedState(): Promise<void> {
    const root = this._getWorkspaceRoot();
    if (!root) { return; }

    const { AgentWorkspace } = await import('../workspace/AgentWorkspace');
    const workspace = new AgentWorkspace(root);
    this._postState(workspace.readProjectState());
  }

  private _getHtml(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    return getWebviewContent(nonce);
  }

  private _getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return null; }
    return folders[0].uri.fsPath;
  }

  private _isWebviewMessage(message: unknown): message is WebviewToExtensionMessage {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return false;
    }

    const msg = message as Partial<WebviewToExtensionMessage>;
    switch (msg.type) {
      case 'ready':
      case 'requestState':
      case 'resumeWorkflow':
      case 'stopWorkflow':
      case 'openNotes':
      case 'openSettings':
        return true;
      case 'startProject':
        return typeof (msg as { prompt?: unknown }).prompt === 'string';
      case 'submitAnswer': {
        const answerMessage = msg as { questionId?: unknown; answer?: unknown };
        return typeof answerMessage.questionId === 'string' && typeof answerMessage.answer === 'string';
      }
      case 'approvePatch': {
        const approvalMessage = msg as { patchId?: unknown; approved?: unknown };
        return typeof approvalMessage.patchId === 'string' && typeof approvalMessage.approved === 'boolean';
      }
      case 'approveCommand': {
        const approvalMessage = msg as { commandId?: unknown; approved?: unknown };
        return typeof approvalMessage.commandId === 'string' && typeof approvalMessage.approved === 'boolean';
      }
      default:
        return false;
    }
  }
}
