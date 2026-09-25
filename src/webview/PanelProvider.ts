import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { AgentOrchestrator } from '../orchestrator/AgentOrchestrator';
import { getWebviewContent } from './webviewHtml';
import { runSidebarGoal } from './sidebarWorkflow';
import { VSCodeSecretVault } from '../connectors/SecretVault';
import { ConnectorManager } from '../connectors/ConnectorManager';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  ProjectState,
  TaskItem,
  TimelineEntry,
  AgentActivity,
  UserQuestion,
  WorkflowPhase,
  RamOptimizationProposal,
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

  /**
   * "Agent that creates agents": ask for a single goal, then let a meta-agent
   * design a bespoke specialist team and run them through a debate to a verdict.
   */
  async designAgentTeam(): Promise<void> {
    const goal = await vscode.window.showInputBox({
      prompt: 'Describe the goal — a meta-agent will design a specialist team and debate it',
      placeHolder: 'Research and plan a relaxing-music YouTube channel...',
      ignoreFocusOut: true,
    });
    if (!goal) { return; }

    const root = this._getWorkspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
      return;
    }

    this._orchestrator = this._createOrchestrator(root);

    const { OllamaClient } = await import('../ollama/OllamaClient');
    const { AgentWorkspace } = await import('../workspace/AgentWorkspace');
    const ws = new AgentWorkspace(root);
    await ws.initialize();
    const config = ws.readModelConfig();
    const client = new OllamaClient(config.ollamaBaseUrl, undefined, config.requestTimeoutMs);
    if (!(await client.checkConnection())) {
      vscode.window.showErrorMessage(`Cannot connect to Ollama at ${config.ollamaBaseUrl}. Please start Ollama and try again.`);
      return;
    }

    this._post({ type: 'appendLog', log: 'Meta-agent designing a specialist team...', level: 'info' });
    this._orchestrator.designAndRunTeam(goal)
      .then(decision => {
        const winner = decision.ranked.find(r => r.agentId === decision.winningAgentId);
        this._post({ type: 'appendLog', log: `Team verdict: ${decision.winningAgentId} (${decision.weightedScore}/10).`, level: 'info' });
        vscode.window.showInformationMessage(
          `Dynamic team converged (${decision.agreement} agreement, ${decision.weightedScore}/10). Winner: ${winner?.agentId ?? decision.winningAgentId}. See agents/dynamic_team_debate.md.`
        );
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        this._post({ type: 'error', message: msg });
        vscode.window.showErrorMessage(`Dynamic team failed: ${msg}`);
      });
  }

  /**
   * The full "one command → finished product" loop: a meta-agent designs and
   * debates a specialist team, then the proven build pipeline implements the
   * winning direction into a verified product.
   */
  async runAutonomousGoal(): Promise<void> {
    const goal = await vscode.window.showInputBox({
      prompt: 'Describe the goal — agents will self-organize, debate, and build it end-to-end',
      placeHolder: 'Build a CLI tool that summarizes Markdown files...',
      ignoreFocusOut: true,
    });
    if (!goal) { return; }

    const root = this._getWorkspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
      return;
    }

    this._orchestrator = this._createOrchestrator(root);

    const { OllamaClient } = await import('../ollama/OllamaClient');
    const { AgentWorkspace } = await import('../workspace/AgentWorkspace');
    const ws = new AgentWorkspace(root);
    await ws.initialize();
    const config = ws.readModelConfig();
    const client = new OllamaClient(config.ollamaBaseUrl, undefined, config.requestTimeoutMs);
    if (!(await client.checkConnection())) {
      vscode.window.showErrorMessage(`Cannot connect to Ollama at ${config.ollamaBaseUrl}. Please start Ollama and try again.`);
      return;
    }

    this._post({ type: 'appendLog', log: 'Autonomous goal: meta-agent staffing a team, then building...', level: 'info' });
    this._orchestrator.runAutonomousGoal(goal).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      this._post({ type: 'error', message: msg });
    });
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

  async configureYouTubeConnector(): Promise<void> {
    const root = this._getWorkspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage('Open a workspace before configuring YouTube.');
      return;
    }
    const clientId = await vscode.window.showInputBox({ prompt: 'YouTube OAuth client ID', ignoreFocusOut: true });
    if (!clientId) { return; }
    const clientSecret = await vscode.window.showInputBox({ prompt: 'YouTube OAuth client secret', password: true, ignoreFocusOut: true });
    if (!clientSecret) { return; }
    const redirectUri = await vscode.window.showInputBox({
      prompt: 'OAuth redirect URI registered in Google Cloud',
      placeHolder: 'http://127.0.0.1:8765/oauth/callback',
      ignoreFocusOut: true,
    });
    if (!redirectUri) { return; }
    const selectedPolicy = await vscode.window.showQuickPick(['draft-only', 'auto-publish'], {
      placeHolder: 'Choose the maximum publishing authority for this connector',
    });
    if (!selectedPolicy) { return; }
    const policy = selectedPolicy === 'auto-publish' ? 'auto-publish' : 'draft-only';
    const vault = new VSCodeSecretVault(this._context.secrets);
    await vault.store('youtube.clientId', clientId.trim());
    await vault.store('youtube.clientSecret', clientSecret.trim());
    const apiKey = await vscode.window.showInputBox({
      prompt: 'YouTube Data API key for research (optional)',
      password: true,
      ignoreFocusOut: true,
    });
    if (apiKey?.trim()) { await vault.store('youtube.apiKey', apiKey.trim()); }
    const manager = new ConnectorManager(vault, root);
    await manager.grantYouTube(['https://www.googleapis.com/auth/youtube.upload'], policy);
    const state = crypto.randomBytes(24).toString('hex');
    const url = await manager.youtubeAuthorizationUrl(redirectUri.trim(), state);
    await vscode.env.openExternal(vscode.Uri.parse(url));
    const redirectedUrl = await vscode.window.showInputBox({
      prompt: 'After Google consent, paste the full redirected URL from the browser address bar',
      password: true,
      ignoreFocusOut: true,
    });
    if (!redirectedUrl) { return; }
    let callback: URL;
    try { callback = new URL(redirectedUrl.trim()); }
    catch { throw new Error('The OAuth callback must be a valid full URL.'); }
    if (callback.searchParams.get('state') !== state) {
      throw new Error('OAuth state mismatch; authorization was not accepted.');
    }
    const code = callback.searchParams.get('code');
    if (!code) { throw new Error('The OAuth callback URL does not contain an authorization code.'); }
    await manager.exchangeYoutubeAuthorizationCode(code, redirectUri.trim());
    vscode.window.showInformationMessage(`YouTube connector authorized with ${policy} policy.`);
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

    this._post({ type: 'appendLog', log: 'Starting autonomous goal (runtime team → debate → build)...', level: 'info' });
    // Sidebar prompts always use the runtime-designed team. The legacy start()
    // entry point remains available to code-level maintenance callers only.
    runSidebarGoal(this._orchestrator, trimmedPrompt).catch(err => {
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
    const orchestrator = new AgentOrchestrator(workspaceRoot, new VSCodeSecretVault(this._context.secrets));

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
      onRamOptimizationNeeded: (proposal: RamOptimizationProposal) => {
        // Unlike patch/command approval, this always shows the native modal
        // (not only when the sidebar is closed) — there is no webview UI for
        // it, so the modal is the only place the boss can actually answer.
        const appList = proposal.apps.map(a => `${a.name} (~${a.residentMb} MB)`).join('\n');
        vscode.window.showWarningMessage(
          `Free ~${(proposal.targetFreeMb - proposal.currentFreeMb)} MB more for local LLMs by closing these apps?`,
          {
            modal: true,
            detail: `Currently free: ${proposal.currentFreeMb} MB. Target: ${Math.round(proposal.targetFreeMb / 1024)} GB.\n\n${appList}`,
          },
          'Close these apps',
          'Continue without closing'
        ).then(selection => {
          orchestrator.resolveRamOptimization(proposal.id, selection === 'Close these apps');
        });
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
