import * as fs from 'fs';
import * as path from 'path';
import type {
  AgentRole,
  AgentActivity,
  ArchitectPlan,
  CodeWorkerOutput,
  DeliveryManifest,
  GitRepositorySnapshot,
  ModelConfig,
  OllamaMessage,
  OrchestratorCallbacks,
  ProjectBrief,
  ProjectState,
  ReviewResult,
  SelfHealingConfig,
  TaskItem,
  TaskPlan,
  TaskResults,
  TesterOutput,
  TerminalRunResult,
  TimelineEntry,
  ToolchainReport,
  UserQuestion,
  WorkflowPhase,
} from '../types';
import { OllamaClient } from '../ollama/OllamaClient';
import { AgentWorkspace } from '../workspace/AgentWorkspace';
import { FileManager } from '../workspace/FileManager';
import { TerminalRunner } from '../terminal/TerminalRunner';
import { GitRepositoryReader } from '../git/GitRepositoryReader';
import { getAgentPrompt, buildUserMessage } from '../prompts/agentPrompts';
import { parseJsonResponse, prettyJson } from '../utils/json';
import { logInfo, logWarn, logError } from '../utils/logging';
import { UserAbortError, WorkflowError, formatError } from '../utils/errors';

// -----------------------------------------------------------------------
// Sentinel thrown to pause workflow and wait for user input
// -----------------------------------------------------------------------
class WaitForUserError extends Error {
  constructor(public readonly questions: UserQuestion[]) {
    super('Workflow paused: waiting for user input.');
    this.name = 'WaitForUserError';
  }
}

interface ProjectCheckResults {
  compileResult: TerminalRunResult | null;
  testResult: TerminalRunResult | null;
  output: string;
  failed: boolean;
  failedCommands: string[];
  skippedChecks: string[];
}

interface PromptFileContext {
  prompt: string;
  context: string;
  files: string[];
}

// -----------------------------------------------------------------------
// AgentOrchestrator
// -----------------------------------------------------------------------
export class AgentOrchestrator {
  private readonly workspace: AgentWorkspace;
  private readonly fileManager: FileManager;
  private readonly gitReader: GitRepositoryReader;
  private ollama!: OllamaClient;
  private terminal!: TerminalRunner;
  private modelConfig!: ModelConfig;
  private callbacks: OrchestratorCallbacks = {};
  private _aborted = false;
  private _running = false;
  private _timeline: TimelineEntry[] = [];
  private _activities: AgentActivity[] = [];
  private _activityCounter = 0;
  private _promptFileContextCache: PromptFileContext | null = null;

  // Pending approvals (patch / command) resolved via user interaction
  private _pendingPatchResolvers = new Map<string, (approved: boolean) => void>();
  private _pendingCommandResolvers = new Map<string, (approved: boolean) => void>();

  constructor(workspaceRoot: string) {
    this.workspace = new AgentWorkspace(workspaceRoot);
    this.fileManager = new FileManager(workspaceRoot);
    this.gitReader = new GitRepositoryReader(workspaceRoot);
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  setCallbacks(callbacks: OrchestratorCallbacks): void {
    this.callbacks = callbacks;
  }

  isRunning(): boolean { return this._running; }

  /**
   * Start a brand-new workflow with the given prompt.
   */
  async start(prompt: string): Promise<void> {
    if (this._running) {
      this._emit('info', 'A workflow is already running.');
      return;
    }
    this._aborted = false;
    this._running = true;

    try {
      await this.workspace.initialize();
      this._loadConfig();

      // Reset state for a new project
      this._activities = [];
      this._activityCounter = 0;
      this._promptFileContextCache = null;
      const state = this._newState(prompt);
      this.workspace.writeProjectState(state);
      this.workspace.writeUserPrompt(prompt);

      this._buildTimeline();
      this._emitTimeline();

      await this._runWorkflow(state);
    } catch (err) {
      this._handleTopLevelError(err);
    } finally {
      this._running = false;
    }
  }

  /**
   * Resume a previously paused workflow.
   */
  async resume(): Promise<void> {
    if (this._running) {
      this._emit('info', 'Workflow is already running.');
      return;
    }

    const state = this.workspace.readProjectState();
    if (state.status !== 'waiting_for_user' && state.status !== 'stopped') {
      this._emit('info', `Cannot resume: current status is "${state.status}".`);
      return;
    }

    this._aborted = false;
    this._running = true;

    try {
      this._loadConfig();
      this._promptFileContextCache = null;
      this._buildTimeline();
      this._emitTimeline();
      state.status = 'running';
      this.workspace.writeProjectState(state);
      await this._runWorkflow(state);
    } catch (err) {
      this._handleTopLevelError(err);
    } finally {
      this._running = false;
    }
  }

  /**
   * Stop the running workflow.
   */
  stop(): void {
    if (!this._running) { return; }
    this._aborted = true;
    this.ollama?.cancelActiveRequests();
    this.terminal?.cancelActiveCommands();
    this._clearPendingApprovals(false);
    this._emit('info', 'Stop requested. Cancelling active model or terminal work...');

    const state = this.workspace.readProjectState();
    state.status = 'stopped';
    this.workspace.writeProjectState(state);
    this.callbacks.onStateUpdate?.(state);
  }

  /**
   * Submit an answer to a pending user question.
   */
  submitAnswer(questionId: string, answer: string): void {
    const state = this.workspace.readProjectState();
    const question = state.openQuestions.find(q => q.id === questionId);
    if (!question) {
      logWarn(`Question "${questionId}" not found in state.`);
      return;
    }

    question.answer = answer;
    question.answeredAt = new Date().toISOString();

    // Move from open to answered in state
    state.openQuestions = state.openQuestions.filter(q => q.id !== questionId);
    this.workspace.writeProjectState(state);

    // Persist to open_questions.md
    this.workspace.appendAnsweredQuestion(question.question, answer);

    logInfo(`Answer recorded for question "${questionId}".`);
  }

  /**
   * Approve or reject a pending patch.
   */
  resolvePatchApproval(patchId: string, approved: boolean): void {
    const resolver = this._pendingPatchResolvers.get(patchId);
    if (resolver) {
      resolver(approved);
      this._pendingPatchResolvers.delete(patchId);
    }
  }

  /**
   * Approve or reject a pending command.
   */
  resolveCommandApproval(commandId: string, approved: boolean): void {
    const resolver = this._pendingCommandResolvers.get(commandId);
    if (resolver) {
      resolver(approved);
      this._pendingCommandResolvers.delete(commandId);
    }
  }

  /**
   * Get the current project state.
   */
  getState(): ProjectState {
    return this.workspace.readProjectState();
  }

  getActivities(): AgentActivity[] {
    return this._activities;
  }

  // ------------------------------------------------------------------
  // Main workflow
  // ------------------------------------------------------------------

  private async _runWorkflow(state: ProjectState): Promise<void> {
    const phase = this._resumePhase(state);

    // Determine which phases to skip (already completed)
    const completedPhases: WorkflowPhase[] = [];
    if (phase !== 'idle' && phase !== 'intake') {
      completedPhases.push('intake');
    }

    // Sequential phase execution based on current state
    try {
      if (!this._phaseAlreadyDone(phase, 'briefing', completedPhases)) {
        await this._phaseBriefing(state);
      }
      if (!this._phaseAlreadyDone(phase, 'brainstorm', completedPhases)) {
        await this._phaseBrainstorm(state);
      }
      if (!this._phaseAlreadyDone(phase, 'critique', completedPhases)) {
        await this._phaseCritique(state);
      }
      if (!this._phaseAlreadyDone(phase, 'second_brainstorm', completedPhases)) {
        await this._phaseSecondBrainstorm(state);
      }
      if (!this._phaseAlreadyDone(phase, 'toolchain_discovery', completedPhases)) {
        await this._phaseToolchainDiscovery(state);
      }
      if (!this._phaseAlreadyDone(phase, 'architecture', completedPhases)) {
        await this._phaseArchitecture(state);
      }
      if (!this._phaseAlreadyDone(phase, 'task_planning', completedPhases)) {
        await this._phaseTaskPlanning(state);
      }
      if (!this._phaseAlreadyDone(phase, 'coding', completedPhases)) {
        await this._phaseCoding(state);
      }
      if (!this._phaseAlreadyDone(phase, 'dependency_install', completedPhases)) {
        await this._phaseDependencyInstall(state);
      }
      if (!this._phaseAlreadyDone(phase, 'testing', completedPhases)) {
        await this._phaseTesting(state);
      }
      if (!this._phaseAlreadyDone(phase, 'artifact_delivery', completedPhases)) {
        await this._phaseArtifactDelivery(state);
      }
      if (!this._phaseAlreadyDone(phase, 'final_integration', completedPhases)) {
        await this._phaseFinalIntegration(state);
      }

      // Completed!
      state.status = 'completed';
      state.currentPhase = 'completed';
      state.currentTaskId = null;
      state.fixRetryCount = 0;
      this.workspace.writeProjectState(state);
      this.callbacks.onStateUpdate?.(state);
      this._updateTimeline('completed', 'completed');
      this._emit('phase', 'completed', 'Workflow completed successfully!');
    } catch (err) {
      if (err instanceof WaitForUserError) {
        // Pause workflow – do not set failed
        state.status = 'waiting_for_user';
        err.questions.forEach(q => {
          if (!state.openQuestions.find(oq => oq.id === q.id)) {
            state.openQuestions.push(q);
          }
        });
        this.workspace.writeProjectState(state);
        this.callbacks.onStateUpdate?.(state);
        err.questions.forEach(q => this.callbacks.onQuestionNeeded?.(q));
        this._emit('phase', 'waiting_for_user', `Waiting for user: ${err.questions.length} question(s)`);
        return;
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Phases
  // ------------------------------------------------------------------

  private async _phaseBriefing(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'briefing', 'Autonomous brief: resolving prompt into a build plan...');

    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    this._persistPromptFileContextNote();
    const { model, fallbackModel } = this._agentConfig('briefBuilder');
    const messages = this._buildMessages('briefBuilder', prompt);

    let brief: ProjectBrief;
    try {
      brief = await this._callWithFallbackJson<ProjectBrief>(
        'briefBuilder', model, fallbackModel, messages,
        this.workspace.projectBriefPath,
        [this.workspace.userPromptPath, ...promptFiles]
      );
    } catch (err) {
      this._emit('log', `Brief builder failed, using deterministic autonomous brief: ${formatError(err)}`, 'warn');
      brief = this._fallbackProjectBrief(prompt);
    }

    brief = this._normalizeProjectBrief(brief, prompt);
    this.workspace.writeFile(this.workspace.projectBriefPath, prettyJson(brief));
    for (const assumption of brief.assumptions) {
      this.workspace.appendAssumption('briefBuilder', assumption);
    }

    this.workspace.appendRollingSummary(
      `## Autonomous Project Brief\n` +
      `Goal: ${brief.goal}\n\n` +
      `Stack: ${brief.chosenStack.join(', ')}\n\n` +
      `Acceptance: ${brief.acceptanceCriteria.join('; ')}`
    );

    this._updateTimeline('briefing', 'completed');
    this._emit('log', 'Autonomous project brief complete.', 'info');
  }

  private async _phaseBrainstorm(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'brainstorm', 'Agent 1: Brainstorming...');

    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const brief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const context = brief ? `# User Prompt\n\n${prompt}\n\n# Autonomous Project Brief\n\n${brief}` : prompt;
    const { model, fallbackModel } = this._agentConfig('brainstorm');
    const messages = this._buildMessages('brainstorm', context);

    let output: string;
    try {
      output = await this._callWithFallback('brainstorm', model, fallbackModel, messages,
        this.workspace.brainstormPath, [this.workspace.userPromptPath, ...promptFiles]);
    } catch (err) {
      output = this._fallbackAgentNote('brainstorm', context, err);
      this.workspace.appendAssumption('brainstorm', `Self-healed failed brainstorm model call: ${formatError(err)}`);
      this._emit('log', 'Brainstorm model call failed; continuing with a deterministic self-healed note.', 'warn');
    }

    this.workspace.writeFile(this.workspace.brainstormPath, this._wrapNote('Brainstorm Analysis', output));
    this.workspace.appendRollingSummary(`## Brainstorm Complete\n${output.substring(0, 500)}`);
    this._recordActivity({
      phase: 'brainstorm',
      agentRole: 'brainstorm',
      title: 'Brainstorm complete',
      detail: 'Initial architecture, feature, risk, and assumption notes are ready.',
      status: 'completed',
    });

    this._updateTimeline('brainstorm', 'completed');
    this._emit('log', 'Brainstorm complete.', 'info');
  }

  private async _phaseCritique(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'critique', `Agent 2: Critiquing (${this._debateRounds()} debate round(s))...`);

    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const brief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const brainstorm = this.workspace.readFile(this.workspace.brainstormPath) ?? '';
    const { model, fallbackModel } = this._agentConfig('critic');
    let priorRounds = '';
    let output = '';

    for (let round = 1; round <= this._debateRounds(); round++) {
      this._checkAborted();
      this._recordActivity({
        phase: 'critique',
        agentRole: 'critic',
        title: `Critic debate round ${round}/${this._debateRounds()}`,
        detail: 'Checking requirement gaps, security risks, scope control, and implementation traps before the architect locks decisions.',
        status: 'running',
        round,
        totalRounds: this._debateRounds(),
      });
      const context =
        `# Debate Round\n\n${round}/${this._debateRounds()}\n\n` +
        `# User Prompt\n\n${prompt}\n\n` +
        `# Autonomous Project Brief\n\n${brief}\n\n` +
        `${brainstorm}\n\n` +
        (priorRounds ? `# Prior Debate Notes\n\n${priorRounds}` : '');
      const messages = this._buildMessages('critic', context);
      const roundPath = this.workspace.agentNotePath(`02_critic_round_${String(round).padStart(2, '0')}.md`);

      try {
        output = await this._callWithFallback('critic', model, fallbackModel, messages,
          roundPath,
          [this.workspace.userPromptPath, ...promptFiles, this.workspace.brainstormPath, this.workspace.projectBriefPath]);
      } catch (err) {
        output = this._fallbackAgentNote('critic', context, err);
        this.workspace.appendAssumption('critic', `Self-healed failed critique round ${round}: ${formatError(err)}`);
        this._emit('log', `Critic round ${round} failed; continuing with a deterministic self-healed critique.`, 'warn');
      }
      const wrapped = this._wrapNote(`Critique Round ${round}`, output);
      this.workspace.writeFile(roundPath, wrapped);
      priorRounds += `\n\n${wrapped}`;
      this._recordActivity({
        phase: 'critique',
        agentRole: 'critic',
        title: `Critic debate round ${round} complete`,
        detail: `Saved findings to ${path.basename(roundPath)}.`,
        status: 'completed',
        round,
        totalRounds: this._debateRounds(),
      });
    }

    this.workspace.writeFile(this.workspace.criticPath, this._wrapNote('Critique', output));
    this._updateTimeline('critique', 'completed');
    this._emit('log', 'Critique complete.', 'info');
  }

  private async _phaseSecondBrainstorm(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'second_brainstorm', `Agent 3: Product/UX debate (${this._debateRounds()} round(s))...`);

    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const brief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const brainstorm = this.workspace.readFile(this.workspace.brainstormPath) ?? '';
    const critique = this.workspace.readFile(this.workspace.criticPath) ?? '';
    const { model, fallbackModel } = this._agentConfig('secondBrainstorm');
    let priorRounds = '';
    let output = '';

    for (let round = 1; round <= this._debateRounds(); round++) {
      this._checkAborted();
      this._recordActivity({
        phase: 'second_brainstorm',
        agentRole: 'secondBrainstorm',
        title: `Product debate round ${round}/${this._debateRounds()}`,
        detail: 'Balancing product flow, user experience, developer setup, quick wins, and final delivery expectations.',
        status: 'running',
        round,
        totalRounds: this._debateRounds(),
      });
      const context =
        `# Debate Round\n\n${round}/${this._debateRounds()}\n\n` +
        `# User Prompt\n\n${prompt}\n\n` +
        `# Autonomous Project Brief\n\n${brief}\n\n` +
        `${brainstorm}\n\n${critique}\n\n` +
        (priorRounds ? `# Prior Product/UX Debate Notes\n\n${priorRounds}` : '');
      const messages = this._buildMessages('secondBrainstorm', context);
      const roundPath = this.workspace.agentNotePath(`03_second_brainstorm_round_${String(round).padStart(2, '0')}.md`);

      try {
        output = await this._callWithFallback('secondBrainstorm', model, fallbackModel, messages,
          roundPath,
          [this.workspace.userPromptPath, ...promptFiles, this.workspace.brainstormPath, this.workspace.criticPath, this.workspace.projectBriefPath]);
      } catch (err) {
        output = this._fallbackAgentNote('secondBrainstorm', context, err);
        this.workspace.appendAssumption('secondBrainstorm', `Self-healed failed product debate round ${round}: ${formatError(err)}`);
        this._emit('log', `Product debate round ${round} failed; continuing with a deterministic self-healed note.`, 'warn');
      }
      const wrapped = this._wrapNote(`Second Brainstorm Round ${round}`, output);
      this.workspace.writeFile(roundPath, wrapped);
      priorRounds += `\n\n${wrapped}`;
      this._recordActivity({
        phase: 'second_brainstorm',
        agentRole: 'secondBrainstorm',
        title: `Product debate round ${round} complete`,
        detail: `Saved product and UX decisions to ${path.basename(roundPath)}.`,
        status: 'completed',
        round,
        totalRounds: this._debateRounds(),
      });
    }

    this.workspace.writeFile(this.workspace.secondBrainstormPath, this._wrapNote('Second Brainstorm', output));
    this._updateTimeline('second_brainstorm', 'completed');
    this._emit('log', 'Second brainstorm complete.', 'info');
  }

  private async _phaseToolchainDiscovery(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'toolchain_discovery', 'Inspecting local toolchain...');

    const packageManager = this.terminal.detectPackageManager();
    const commands: Array<[string, string]> = [
      ['node', 'node --version'],
      ['npm', 'npm --version'],
      ['pnpm', 'pnpm --version'],
      ['yarn', 'yarn --version'],
      ['git', 'git --version'],
      ['java', 'java -version'],
      ['xcodebuild', 'xcodebuild -version'],
      ['android-sdk', 'adb version'],
      ['flutter', 'flutter --version'],
      ['gradle', 'gradle --version'],
    ];

    const checks: ToolchainReport['checks'] = [];
    for (const [name, command] of commands) {
      this._checkAborted();
      this._recordActivity({
        phase: 'toolchain_discovery',
        title: `Checking ${name}`,
        detail: command,
        status: 'running',
      });
      const result = await this.terminal.runSafeCommand(command, 15_000);
      const raw = `${result.stdout}\n${result.stderr}`.trim();
      checks.push({
        name,
        command,
        available: result.success,
        version: result.success ? raw.split('\n').slice(0, 3).join('\n') : undefined,
        error: result.success ? undefined : (raw || result.error || `exit ${result.exitCode}`),
      });
      this._recordActivity({
        phase: 'toolchain_discovery',
        title: result.success ? `${name} available` : `${name} not found`,
        detail: result.success ? raw.split('\n')[0] : (raw || result.error || `exit ${result.exitCode}`),
        status: result.success ? 'completed' : 'warn',
      });
    }

    this._recordActivity({
      phase: 'toolchain_discovery',
      title: 'Reading Git repository',
      detail: 'Collecting branch, status, recent commits, and diff stats.',
      status: 'running',
    });
    const gitSnapshot = await this.gitReader.readSnapshot();
    this.workspace.writeFile(this.workspace.gitSnapshotPath, prettyJson(gitSnapshot));
    this._recordActivity({
      phase: 'toolchain_discovery',
      title: gitSnapshot.isRepository ? 'Git repository snapshot ready' : 'No Git repository detected',
      detail: gitSnapshot.isRepository
        ? `${gitSnapshot.branch ?? 'detached'} @ ${gitSnapshot.head ?? 'unborn'}, ${gitSnapshot.changedFileCount} changed file(s)`
        : (gitSnapshot.error ?? 'Workspace is not inside a Git repository.'),
      status: gitSnapshot.isRepository ? 'completed' : 'warn',
    });

    const report: ToolchainReport = {
      generatedAt: new Date().toISOString(),
      packageManager,
      checks,
      missing: checks.filter(check => !check.available).map(check => check.name),
      notes: [
        'Missing optional toolchains do not stop the workflow unless the generated project requires them during verification.',
        'For signed iOS IPA delivery, Apple signing assets must already exist locally; the agent can still generate and verify the project structure without them.',
      ],
    };

    this.workspace.writeFile(this.workspace.toolchainReportPath, prettyJson(report));
    this.workspace.appendRollingSummary(
      `## Toolchain Discovery\nAvailable: ${checks.filter(c => c.available).map(c => c.name).join(', ') || 'none'}\n` +
      `Missing: ${report.missing.join(', ') || 'none'}\n` +
      `Git: ${gitSnapshot.isRepository ? `${gitSnapshot.branch ?? 'detached'} (${gitSnapshot.changedFileCount} changed file(s))` : 'not a repository'}`
    );

    this._updateTimeline('toolchain_discovery', 'completed');
    this._emit('log', 'Toolchain discovery complete.', 'info');
  }

  private async _phaseArchitecture(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'architecture', 'Agent 4: Designing architecture...');

    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const brief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const toolchain = this.workspace.readFile(this.workspace.toolchainReportPath) ?? '';
    const gitSnapshot = this.workspace.readFile(this.workspace.gitSnapshotPath) ?? '';
    const brainstorm = this.workspace.readFile(this.workspace.brainstormPath) ?? '';
    const critique = this.workspace.readFile(this.workspace.criticPath) ?? '';
    const secondBrainstorm = this.workspace.readFile(this.workspace.secondBrainstormPath) ?? '';
    const openQns = this.workspace.readFile(this.workspace.openQuestionsPath) ?? '';
    const assumptions = this.workspace.readFile(this.workspace.assumptionsPath) ?? '';
    const context =
      `# User Prompt\n\n${prompt}\n\n` +
      `# Autonomous Project Brief\n\n${brief}\n\n` +
      `# Local Toolchain Report\n\n${toolchain}\n\n` +
      `# Git Repository Snapshot\n\n${gitSnapshot}\n\n` +
      `${brainstorm}\n\n${critique}\n\n${secondBrainstorm}\n\n${openQns}\n\n${assumptions}`;

    const { model, fallbackModel } = this._agentConfig('architect');
    const messages = this._buildMessages('architect', context);

    let architectPlan: ArchitectPlan | null = null;
    let output: string;
    try {
      output = await this._callWithFallback('architect', model, fallbackModel, messages,
        this.workspace.architectMdPath,
        [this.workspace.userPromptPath, this.workspace.brainstormPath,
         this.workspace.criticPath, this.workspace.secondBrainstormPath, ...promptFiles]);
    } catch (err) {
      architectPlan = this._fallbackArchitectPlan(prompt, brief, err);
      output = this._formatFallbackArchitecture(architectPlan, err);
      this.workspace.appendAssumption('architect', `Self-healed failed architecture model call: ${formatError(err)}`);
      this._emit('log', 'Architect model call failed; generated a deterministic architecture plan and continued.', 'warn');
    }

    // Save markdown
    this.workspace.writeFile(this.workspace.architectMdPath, this._wrapNote('Architecture Plan', output));

    // Extract JSON plan – if the model omitted the JSON block, retry with a
    // focused extraction call before giving up.
    try {
      if (!architectPlan) {
        architectPlan = parseJsonResponse<ArchitectPlan>(output);
      }
      this.workspace.writeFile(this.workspace.architectJsonPath, prettyJson(architectPlan));
    } catch {
      this._emit('log', 'Architect did not return valid JSON. Retrying JSON extraction...', 'warn');
      try {
        const jsonExtractionMessages: OllamaMessage[] = [
          {
            role: 'system',
            content: 'You are a JSON extraction assistant. Given an architecture document, you output ONLY a valid JSON object – no prose, no markdown fences, no explanations.',
          },
          {
            role: 'user',
            content: `From the architecture document below, extract the key information and return ONLY this JSON object (fill every field accurately):\n{\n  "summary": "one-sentence description of the project",\n  "technology": ["list of core technologies"],\n  "projectStructure": ["list of key directories and files"],\n  "keyDecisions": ["list of key architecture decisions"],\n  "constraints": ["list of key constraints"],\n  "needUserInput": false,\n  "questions": [],\n  "readyToCode": true\n}\n\n---\nARCHITECTURE DOCUMENT:\n${output}`,
          },
        ];
        const jsonRaw = await this.ollama.chat(
          model, jsonExtractionMessages, 'architect',
          this.modelConfig.defaultOptions,
          this.workspace.architectJsonPath, [this.workspace.architectMdPath]
        );
        architectPlan = parseJsonResponse<ArchitectPlan>(jsonRaw);
        this.workspace.writeFile(this.workspace.architectJsonPath, prettyJson(architectPlan));
      } catch (retryErr) {
        architectPlan = this._fallbackArchitectPlan(prompt, brief, retryErr);
        this.workspace.writeFile(this.workspace.architectJsonPath, prettyJson(architectPlan));
        this.workspace.appendAssumption('architect', `Self-healed invalid architecture JSON: ${formatError(retryErr)}`);
        this._emit('log', 'Architecture JSON repair failed; continuing with a deterministic plan.', 'warn');
      }
    }

    // Check if user input is needed
    if (architectPlan?.needUserInput && architectPlan.questions.length > 0) {
      if (this._shouldAskUser()) {
        const questions = architectPlan.questions.map((q, i) =>
          this._createQuestion('architect', state.currentPhase, q, `Architect question ${i + 1}`));
        throw new WaitForUserError(questions);
      }

      for (const question of architectPlan.questions) {
        this.workspace.appendAssumption(
          'architect',
          `Resolved without user input: ${question}\nAssumption: choose the simplest local-first option that satisfies the project brief.`
        );
      }
      architectPlan.needUserInput = false;
      architectPlan.questions = [];
      architectPlan.readyToCode = true;
      architectPlan.constraints = [
        ...(architectPlan.constraints ?? []),
        'Autonomous mode: ambiguity is resolved through recorded assumptions instead of user questions.',
      ];
      this.workspace.writeFile(this.workspace.architectJsonPath, prettyJson(architectPlan));
    }

    this.workspace.appendRollingSummary(`## Architecture Decisions\n${(architectPlan?.keyDecisions ?? []).join('\n')}`);
    this._recordActivity({
      phase: 'architecture',
      agentRole: 'architect',
      title: 'Architecture locked',
      detail: (architectPlan?.summary ?? 'Architecture plan is ready for task planning.'),
      status: 'completed',
    });
    this._updateTimeline('architecture', 'completed');
    this._emit('log', 'Architecture complete.', 'info');
  }

  private async _phaseTaskPlanning(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'task_planning', 'Agent 5: Planning tasks...');

    const architectMd = this.workspace.readFile(this.workspace.architectMdPath) ?? '';
    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const brief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const toolchain = this.workspace.readFile(this.workspace.toolchainReportPath) ?? '';
    const gitSnapshot = this.workspace.readFile(this.workspace.gitSnapshotPath) ?? '';
    const assumptions = this.workspace.readFile(this.workspace.assumptionsPath) ?? '';
    const decisions = this.workspace.readFile(this.workspace.decisionsPath) ?? '';
    const openQns = this.workspace.readFile(this.workspace.openQuestionsPath) ?? '';
    const context =
      `# User Prompt And Referenced Files\n\n${prompt}\n\n` +
      `# Autonomous Project Brief\n\n${brief}\n\n` +
      `# Local Toolchain Report\n\n${toolchain}\n\n` +
      `# Git Repository Snapshot\n\n${gitSnapshot}\n\n` +
      `${architectMd}\n\n${decisions}\n\n${openQns}\n\n${assumptions}`;

    const { model, fallbackModel } = this._agentConfig('taskManager');
    const messages = this._buildMessages('taskManager', context);

    let taskPlan: TaskPlan | null = null;
    let output: string;
    try {
      output = await this._callWithFallback('taskManager', model, fallbackModel, messages,
        this.workspace.taskManagerPath, [this.workspace.architectMdPath, this.workspace.userPromptPath, ...promptFiles]);
    } catch (err) {
      taskPlan = this._fallbackTaskPlan(brief, architectMd, err);
      output = prettyJson(taskPlan);
      this.workspace.appendAssumption('taskManager', `Self-healed failed task planning model call: ${formatError(err)}`);
      this._emit('log', 'Task manager model call failed; generated a deterministic task plan and continued.', 'warn');
    }

    this.workspace.writeFile(this.workspace.taskManagerPath, this._wrapNote('Task Plan', output));

    // Parse task plan
    try {
      if (!taskPlan) {
        taskPlan = parseJsonResponse<TaskPlan>(output);
      }
      // Stamp createdAt on each task if missing
      const now = new Date().toISOString();
      if (!Array.isArray(taskPlan.tasks) || taskPlan.tasks.length === 0) {
        throw new Error('Task plan contains no tasks.');
      }
      taskPlan.tasks = taskPlan.tasks.map((t, index) => ({
        ...t,
        id: t.id || `task-${String(index + 1).padStart(3, '0')}`,
        assignedAgent: t.assignedAgent || 'codeWorker',
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
        allowedFiles: Array.isArray(t.allowedFiles) ? t.allowedFiles : [],
        forbiddenActions: Array.isArray(t.forbiddenActions) ? t.forbiddenActions : [],
        acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : [],
        createdAt: t.createdAt || now,
        status: 'pending',
      }));
      taskPlan.totalTasks = taskPlan.tasks.length;
      taskPlan.createdAt = taskPlan.createdAt || now;
    } catch (err) {
      taskPlan = this._fallbackTaskPlan(brief, architectMd, err);
      output = prettyJson(taskPlan);
      this.workspace.writeFile(this.workspace.taskManagerPath, this._wrapNote('Task Plan', output));
      this.workspace.appendAssumption('taskManager', `Self-healed invalid task plan JSON: ${formatError(err)}`);
      this._emit('log', 'Task Manager returned invalid JSON; continuing with a deterministic task plan.', 'warn');
    }

    this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));

    state.activeTasks = taskPlan.tasks.map(t => t.id);
    state.completedTasks = [];
    state.failedTasks = [];
    this.workspace.writeProjectState(state);

    this.callbacks.onTaskUpdate?.(taskPlan.tasks);
    this._recordActivity({
      phase: 'task_planning',
      agentRole: 'taskManager',
      title: 'Task plan ready',
      detail: `${taskPlan.totalTasks} task(s), ${taskPlan.estimatedComplexity} complexity.`,
      status: 'completed',
    });
    this._emit('log', `Task plan created: ${taskPlan.totalTasks} tasks.`, 'info');
    this._updateTimeline('task_planning', 'completed');
  }

  private async _phaseCoding(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'coding', 'Code Workers: Executing tasks...');

    const taskPlan = this._loadTaskPlan();
    if (!taskPlan) {
      throw new Error('Cannot start coding: task_plan.json is missing or invalid.');
    }

    const taskResults: TaskResults = this._loadTaskResults() ?? { results: {}, updatedAt: new Date().toISOString() };
    const architectMd = this.workspace.readFile(this.workspace.architectMdPath) ?? '';
    const rollingSummary = this.workspace.readFile(this.workspace.rollingSummaryPath) ?? '';

    for (const task of taskPlan.tasks) {
      this._checkAborted();

      // Skip already completed / failed tasks
      if (state.completedTasks.includes(task.id) || state.failedTasks.includes(task.id)) {
        continue;
      }

      // Wait for dependencies
      const unmetDeps = task.dependsOn.filter(dep => !state.completedTasks.includes(dep));
      if (unmetDeps.length > 0) {
        const failedDeps = unmetDeps.filter(dep => state.failedTasks.includes(dep));
        const pendingDeps = unmetDeps.filter(dep => !state.failedTasks.includes(dep));
        if (pendingDeps.length > 0) {
          this._emit('log', `Task "${task.id}" deferred: waiting for dependencies [${pendingDeps.join(', ')}]`, 'warn');
          task.status = 'pending';
          this.workspace.writeProjectState(state);
          this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
          this.callbacks.onTaskUpdate?.(taskPlan.tasks);
          continue;
        }

        if (failedDeps.length > 0 && this._selfHealingConfig().enabled) {
          this._emit('log', `Task "${task.id}" continuing despite failed dependencies [${failedDeps.join(', ')}] via self-healing.`, 'warn');
          this.workspace.appendAssumption(
            'codeWorker',
            `Task ${task.id} continued although dependencies failed: ${failedDeps.join(', ')}. Assumption: downstream tasks should recreate any missing setup they need.`
          );
        } else {
          this._emit('log', `Task "${task.id}" skipped: unmet dependencies [${unmetDeps.join(', ')}]`, 'warn');
          task.status = 'skipped';
          state.activeTasks = state.activeTasks.filter(id => id !== task.id);
          this.workspace.writeProjectState(state);
          this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
          this.callbacks.onTaskUpdate?.(taskPlan.tasks);
          continue;
        }
      }

      // Mark in progress
      task.status = 'in_progress';
      task.startedAt = new Date().toISOString();
      state.currentTaskId = task.id;
      this.workspace.writeProjectState(state);
      this.callbacks.onTaskUpdate?.(taskPlan.tasks);
      this._emit('log', `Starting task: [${task.id}] ${task.title}`, 'info');
      this._recordActivity({
        phase: 'coding',
        agentRole: 'codeWorker',
        title: `Coding ${task.id}`,
        detail: task.title,
        status: 'running',
        taskId: task.id,
        files: task.allowedFiles,
      });

      // Execute code worker
      const workerResult = await this._executeCodeWorker(task, architectMd, rollingSummary, state);
      if (!workerResult) {
        task.status = 'failed';
        task.error = 'Code worker produced no output after self-healing attempts.';
        this._recordFailedTask(state, task.id);
        state.activeTasks = state.activeTasks.filter(id => id !== task.id);
        this.workspace.writeProjectState(state);
        this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
        this.callbacks.onTaskUpdate?.(taskPlan.tasks);
        this.workspace.appendAssumption(
          'codeWorker',
          `Task ${task.id} failed because the code worker produced no output. Self-healing will let dependent tasks continue and verification/fixer phases repair missing files when possible.`
        );
        continue;
      }
      this._normalizeAutonomousWorkerOutput('codeWorker', task, workerResult);

      // Handle user input needed
      if (workerResult.needUserInput && workerResult.questions.length > 0) {
        const questions = workerResult.questions.map((q, i) =>
          this._createQuestion('codeWorker', 'coding', q, `Code worker Q for task ${task.id} #${i + 1}`));
        // Save partial progress before pausing
        taskPlan.tasks.find(t => t.id === task.id)!.status = 'pending';
        this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
        throw new WaitForUserError(questions);
      }

      // Apply file changes (safe mode = ask approval for large changes)
      if (workerResult.files.length > 0) {
        const expandedAllowedFiles = this._selfHealAllowedFiles(task, workerResult, 'codeWorker');
        if (expandedAllowedFiles.length > 0) {
          this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
          this.callbacks.onTaskUpdate?.(taskPlan.tasks);
        }
        const validationErrors = this._validateTaskFileChanges(task, workerResult);
        if (validationErrors.length > 0) {
          task.status = 'failed';
          task.error = validationErrors.join('\n');
          this._recordFailedTask(state, task.id);
          state.activeTasks = state.activeTasks.filter(id => id !== task.id);
          this.workspace.writeProjectState(state);
          this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
          this.callbacks.onTaskUpdate?.(taskPlan.tasks);
          this._emit('error', `Task "${task.id}" produced unsafe file changes: ${task.error}`);
          this._recordActivity({
            phase: 'coding',
            agentRole: 'codeWorker',
            title: `Task ${task.id} blocked`,
            detail: task.error,
            status: 'failed',
            taskId: task.id,
          });
          continue;
        }
        const patchId = `${task.id}-${Date.now()}`;
        const applied = await this._applyCodeChanges(patchId, workerResult, state);
        if (!applied) {
          task.status = 'failed';
          task.error = 'File changes were not applied.';
          this._recordFailedTask(state, task.id);
          state.activeTasks = state.activeTasks.filter(id => id !== task.id);
          this.workspace.writeProjectState(state);
          this.callbacks.onTaskUpdate?.(taskPlan.tasks);
          continue;
        }
      }

      // Run reviewer
      this._setPhase(state, 'reviewing', `Reviewing task: ${task.title}`);
      this._recordActivity({
        phase: 'reviewing',
        agentRole: 'reviewer',
        title: `Reviewing ${task.id}`,
        detail: task.title,
        status: 'running',
        taskId: task.id,
        files: workerResult.files.map(file => file.path),
      });
      const review = await this._executeReviewer(task, workerResult, state);

      if (review.needsFix) {
        // Try to fix
        const maxRetries = this.modelConfig.maxFixRetries;
        let fixed = false;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          this._checkAborted();
          this._emit('log', `Fix attempt ${attempt}/${maxRetries} for task "${task.id}"`, 'warn');
          this._setPhase(state, 'fixing', `Fixing task: ${task.title} (attempt ${attempt})`);
          this._recordActivity({
            phase: 'fixing',
            agentRole: 'fixer',
            title: `Fix attempt ${attempt}/${maxRetries}`,
            detail: `Task ${task.id}: ${review.issues.concat(review.fixSuggestions).slice(0, 2).join(' ') || task.title}`,
            status: 'running',
            round: attempt,
            totalRounds: maxRetries,
            taskId: task.id,
          });
          state.fixRetryCount = attempt;
          this.workspace.writeProjectState(state);

          const fixResult = await this._executeFixer(task, review, state);
          if (!fixResult) { break; }
          this._normalizeAutonomousWorkerOutput('fixer', task, fixResult);

          // Re-apply fix changes
          if (fixResult.files.length > 0) {
            const expandedAllowedFiles = this._selfHealAllowedFiles(task, fixResult, 'fixer');
            if (expandedAllowedFiles.length > 0) {
              this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
              this.callbacks.onTaskUpdate?.(taskPlan.tasks);
            }
            const validationErrors = this._validateTaskFileChanges(task, fixResult);
            if (validationErrors.length > 0) {
              this._emit('error', `Fixer produced unsafe file changes for task "${task.id}": ${validationErrors.join('; ')}`);
              break;
            }
            const patchId = `${task.id}-fix-${attempt}-${Date.now()}`;
            const applied = await this._applyCodeChanges(patchId, fixResult, state);
            if (!applied) { break; }
          }

          // Re-review
          const reReview = await this._executeReviewer(task, fixResult, state);
          if (!reReview.needsFix) {
            fixed = true;
            Object.assign(review, reReview);
            break;
          }
          Object.assign(review, reReview);
        }

        if (!fixed) {
          this._emit('log', `Task "${task.id}" could not be fixed after ${maxRetries} attempts.`, 'warn');
          task.status = 'failed';
          task.error = `Failed after ${maxRetries} fix attempts. Last issues: ${review.issues.join('; ')}`;
          this._recordFailedTask(state, task.id);
          state.activeTasks = state.activeTasks.filter(id => id !== task.id);
          this.workspace.writeProjectState(state);
          this.callbacks.onTaskUpdate?.(taskPlan.tasks);
          continue;
        }
      }

      // Task complete
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      task.reviewResult = review;
      state.completedTasks.push(task.id);
      state.activeTasks = state.activeTasks.filter(id => id !== task.id);
      state.fixRetryCount = 0;
      this.workspace.writeProjectState(state);

      taskResults.results[task.id] = {
        taskId: task.id,
        status: 'completed',
        files: workerResult.files,
        completedAt: task.completedAt,
      };
      taskResults.updatedAt = new Date().toISOString();
      this.workspace.writeFile(this.workspace.taskResultsPath, prettyJson(taskResults));
      this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
      this.callbacks.onTaskUpdate?.(taskPlan.tasks);
      this._emit('log', `Task "${task.id}" completed.`, 'info');
      this._recordActivity({
        phase: 'coding',
        agentRole: 'codeWorker',
        title: `Task ${task.id} complete`,
        detail: `${task.title} (${workerResult.files.length} file change(s))`,
        status: 'completed',
        taskId: task.id,
        files: workerResult.files.map(file => file.path),
      });
    }

    state.currentTaskId = null;
    this.workspace.writeProjectState(state);
    this._updateTimeline('coding', 'completed');
  }

  private async _phaseDependencyInstall(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'dependency_install', 'Installing project dependencies...');

    if (!this.modelConfig.autoInstallDependencies) {
      this.workspace.writeFile(this.workspace.dependencyInstallLogPath, 'Dependency install skipped by configuration.\n');
      this._updateTimeline('dependency_install', 'skipped');
      this._emit('log', 'Dependency install skipped by configuration.', 'info');
      return;
    }

    if (!this.fileManager.fileExists('package.json')) {
      this.workspace.writeFile(this.workspace.dependencyInstallLogPath, 'No package.json found; dependency install skipped.\n');
      this._updateTimeline('dependency_install', 'skipped');
      this._emit('log', 'No package.json found; dependency install skipped.', 'info');
      return;
    }

    const pm = this.terminal.detectPackageManager();
    const command = pm === 'yarn' ? 'yarn install' : pm === 'pnpm' ? 'pnpm install' : 'npm install';
    this._recordActivity({
      phase: 'dependency_install',
      title: 'Installing dependencies',
      detail: command,
      status: 'running',
    });
    const result = await this.terminal.runSafeCommand(command, 600_000);
    this.workspace.writeFile(
      this.workspace.dependencyInstallLogPath,
      this._formatCommandResult('Dependency Install', result)
    );

    if (!result.success) {
      this._recordActivity({
        phase: 'dependency_install',
        title: 'Dependency install failed',
        detail: command,
        status: 'failed',
      });
      throw new WorkflowError(`Dependency install failed: ${command}`, 'dependency_install');
    }

    this._updateTimeline('dependency_install', 'completed');
    this._recordActivity({
      phase: 'dependency_install',
      title: 'Dependencies installed',
      detail: command,
      status: 'completed',
    });
    this._emit('log', 'Dependency install complete.', 'info');
  }

  private async _phaseTesting(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'testing', 'Tester Agent: Running tests...');

    const pm = this.terminal.detectPackageManager();
    this._recordActivity({
      phase: 'testing',
      agentRole: 'tester',
      title: 'Running verification checks',
      detail: 'Compile/build/test scripts are executed and then analyzed by the tester agent.',
      status: 'running',
    });
    let checks = await this._runProjectChecks(pm);
    this.workspace.writeFile(this.workspace.testResultLogPath, checks.output);

    let testerOutput = await this._analyzeProjectChecks(checks);

    this.workspace.writeFile(this.workspace.testerPath, this._wrapNote('Test Results', prettyJson(testerOutput)));

    if (testerOutput.needsFix || checks.failed) {
      const maxRetries = this.modelConfig.maxFixRetries;
      let passedAfterFix = !checks.failed;
      let fixerUnavailable = false;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        this._checkAborted();
        this._emit('log', `Test fix attempt ${attempt}/${maxRetries}`, 'warn');
        this._setPhase(state, 'fixing', `Fixing test failures (attempt ${attempt})`);
        this._recordActivity({
          phase: 'fixing',
          agentRole: 'fixer',
          title: `Verification fix ${attempt}/${maxRetries}`,
          detail: testerOutput.fixDescription ?? checks.failedCommands.join(', '),
          status: 'running',
          round: attempt,
          totalRounds: maxRetries,
        });

        const allowedFiles = this._collectTestFixAllowedFiles(checks, testerOutput);
        if (allowedFiles.length === 0) {
          throw new WorkflowError('Cannot fix project checks because no safe target files were identified.', 'testing');
        }

        const fakeTask: TaskItem = {
          id: `test-fix-${attempt}`,
          title: 'Fix test failures',
          description:
            `${testerOutput.fixDescription ?? 'Fix all test and compile errors'}\n\n` +
            'Preserve the original user requirements, package scripts, and real test coverage. ' +
            'Do not replace failing tests with placeholders or unrelated examples.',
          assignedAgent: 'fixer',
          dependsOn: [],
          allowedFiles,
          forbiddenActions: [],
          acceptanceCriteria: [
            'All configured compile/build/test commands pass',
            'Original user requirements remain implemented',
            'Package scripts and tests are not removed or replaced with placeholders',
          ],
          status: 'in_progress',
          createdAt: new Date().toISOString(),
        };

        const fakeReview = {
          taskId: fakeTask.id,
          approved: false,
          issues: [
            ...checks.failedCommands.map(command => `Command failed: ${command}`),
            ...testerOutput.errors,
          ],
          suggestions: [],
          securityConcerns: [],
          needsFix: true,
          fixSuggestions: [testerOutput.fixDescription ?? 'Fix test errors'],
          reviewedAt: new Date().toISOString(),
        };

        const fixResult = await this._executeFixer(fakeTask, fakeReview, state);
        if (!fixResult) {
          fixerUnavailable = true;
          this._emit('log', `Fixer produced no output for test fix attempt ${attempt}; continuing self-healing attempts.`, 'warn');
          this.workspace.appendFile(
            this.workspace.testerPath,
            `\n\n---\n\n## Fixer Unavailable On Attempt ${attempt}\n\nThe fixer agent produced no output. The workflow kept running and will preserve the verification failure in the final report.\n`
          );
          continue;
        }
        this._normalizeAutonomousWorkerOutput('fixer', fakeTask, fixResult);

        if (fixResult.files.length > 0) {
          this._selfHealAllowedFiles(fakeTask, fixResult, 'fixer');
          const validationErrors = this._validateTaskFileChanges(fakeTask, fixResult);
          if (validationErrors.length > 0) {
            throw new WorkflowError(
              `Fixer produced unsafe file changes: ${validationErrors.join('; ')}`,
              'testing'
            );
          }
          const patchId = `test-fix-${attempt}-${Date.now()}`;
          const applied = await this._applyCodeChanges(patchId, fixResult, state);
          if (!applied) {
            throw new WorkflowError(`Could not apply test fix attempt ${attempt}.`, 'testing');
          }
        }

        checks = await this._runProjectChecks(pm);
        this.workspace.writeFile(this.workspace.testResultLogPath, checks.output);
        this.workspace.appendFile(
          this.workspace.testerPath,
          `\n\n---\n\n## Verification After Fix Attempt ${attempt}\n\n${checks.output}\n`
        );

        if (!checks.failed) {
          this._emit('log', 'Tests passed after fix.', 'info');
          passedAfterFix = true;
          break;
        }

        testerOutput = await this._analyzeProjectChecks(checks);
        this.workspace.appendFile(
          this.workspace.testerPath,
          `\n\n## Tester Analysis After Fix Attempt ${attempt}\n\n${prettyJson(testerOutput)}\n`
        );

        if (attempt === maxRetries) {
          this._emit('log', 'Max test fix retries reached.', 'error');
        }
      }

      if (!passedAfterFix) {
        if (fixerUnavailable && this._selfHealingConfig().enabled) {
          this._emit('log', `Verification still failing after fixer agent failures; continuing workflow with warnings: ${checks.failedCommands.join(', ')}`, 'warn');
          this.workspace.appendFile(
            this.workspace.testerPath,
            `\n\n## Self-Healing Verification Warning\n\nVerification is still failing, but the fixer agent was unavailable. The workflow continued so artifacts and final report can still be produced.\n\nFailed commands: ${checks.failedCommands.join(', ') || 'unknown'}\n`
          );
        } else {
          throw new WorkflowError(
            `Project checks still fail after ${maxRetries} fix attempt(s): ${checks.failedCommands.join(', ')}`,
            'testing'
          );
        }
      }
    }

    this._updateTimeline('testing', 'completed');
    this._recordActivity({
      phase: 'testing',
      agentRole: 'tester',
      title: 'Verification complete',
      detail: checks.failed ? 'Checks still fail; workflow continued with self-healing warnings.' : 'Configured checks passed.',
      status: checks.failed ? 'warn' : 'completed',
    });
    this._emit('log', 'Testing phase complete.', 'info');
  }

  private async _phaseArtifactDelivery(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'artifact_delivery', 'Preparing final delivery artifacts...');

    const artifactDir = this._artifactDir();
    const artifactFullPath = path.join(this.workspace.rootDir, artifactDir);
    if (!fs.existsSync(artifactFullPath)) {
      fs.mkdirSync(artifactFullPath, { recursive: true });
    }

    const filesIncluded = this.fileManager
      .listWorkspaceFiles('')
      .filter(file => !file.startsWith(`${artifactDir}/`));

    let archivePath: string | undefined;
    let archiveCommand: string | undefined;
    let archiveCreated = false;

    if (this.modelConfig.createFinalArchive) {
      const zipPath = `${artifactDir}/final-project.zip`;
      const zipCommand =
        `zip -r ${this._quoteShell(zipPath)} . ` +
        `-x ".agent-workspace/*" "node_modules/*" ".git/*" "out/*" "${artifactDir}/*"`;
      this._recordActivity({
        phase: 'artifact_delivery',
        title: 'Creating final archive',
        detail: zipPath,
        status: 'running',
      });
      const zipResult = await this.terminal.runSafeCommand(zipCommand, 300_000);
      archiveCommand = zipCommand;

      if (zipResult.success) {
        archivePath = zipPath;
        archiveCreated = true;
      } else {
        const tarPath = `${artifactDir}/final-project.tar.gz`;
        const tarCommand =
          `tar --exclude=.agent-workspace --exclude=node_modules --exclude=.git --exclude=out --exclude=${artifactDir} ` +
          `-czf ${this._quoteShell(tarPath)} .`;
        const tarResult = await this.terminal.runSafeCommand(tarCommand, 300_000);
        archiveCommand = tarCommand;
        if (tarResult.success) {
          archivePath = tarPath;
          archiveCreated = true;
        } else {
          this._emit('log', 'Could not create final archive; manifest will still be written.', 'warn');
        }
      }
    }

    const manifest: DeliveryManifest = {
      generatedAt: new Date().toISOString(),
      artifactDir,
      archivePath,
      archiveCommand,
      archiveCreated,
      filesIncluded,
      verificationLog: this.workspace.readFile(this.workspace.testResultLogPath) ?? undefined,
      toolchainReport: this._readToolchainReport(),
      gitSnapshot: this._readGitSnapshot(),
      notes: [
        archiveCreated
          ? `Final archive created at ${archivePath}.`
          : 'Final archive was not created; inspect terminal logs for zip/tar availability.',
        'The manifest excludes agent workspace logs, node_modules, git metadata, build output, and existing artifact files from the archive.',
      ],
    };

    this.workspace.writeFile(this.workspace.deliveryManifestPath, prettyJson(manifest));
    this.workspace.writeFile(path.join(this.workspace.rootDir, artifactDir, 'delivery_manifest.json'), prettyJson(manifest));

    this._updateTimeline('artifact_delivery', 'completed');
    this._recordActivity({
      phase: 'artifact_delivery',
      title: archiveCreated ? 'Delivery archive ready' : 'Delivery manifest ready',
      detail: archivePath ?? `${artifactDir}/delivery_manifest.json`,
      status: archiveCreated ? 'completed' : 'warn',
    });
    this._emit('log', 'Delivery artifacts prepared.', 'info');
  }

  private async _runProjectChecks(packageManager: 'npm' | 'pnpm' | 'yarn'): Promise<ProjectCheckResults> {
    const skippedChecks: string[] = [];

    let compileResult: TerminalRunResult | null = null;
    let compileScript: 'compile' | 'build' | null = null;
    if (this.terminal.hasPackageScript('compile')) {
      compileScript = 'compile';
    } else if (this.terminal.hasPackageScript('build')) {
      compileScript = 'build';
    }

    if (compileScript) {
      compileResult = await this.terminal.runSafeCommand(
        this._packageScriptCommand(packageManager, compileScript)
      );
    } else {
      skippedChecks.push('compile/build script not found');
    }

    const testResult = this.terminal.hasPackageScript('test')
      ? await this.terminal.runTests(packageManager)
      : null;
    if (!testResult) {
      skippedChecks.push('test script not found');
    }

    let nativeResult: TerminalRunResult | null = null;
    if (!compileResult && !testResult) {
      const nativeCommand = this._nativeVerificationCommand();
      if (nativeCommand) {
        nativeResult = await this.terminal.runSafeCommand(nativeCommand, 300_000);
      } else {
        skippedChecks.push('native project verification not found');
      }
    }

    const failedCommands: string[] = [];
    if (compileResult && !compileResult.success) {
      failedCommands.push(compileResult.command);
    }
    if (testResult && !testResult.success) {
      failedCommands.push(testResult.command);
    }
    if (nativeResult && !nativeResult.success) {
      failedCommands.push(nativeResult.command);
    }
    if (this.modelConfig.requireVerificationScripts && !compileResult && !testResult && !nativeResult) {
      failedCommands.push('missing compile/build/test script');
    }

    const output = [
      compileResult
        ? this._formatCommandResult('Compile / Build', compileResult)
        : '## Compile / Build\n_No compile or build script found_',
      testResult
        ? this._formatCommandResult('Tests', testResult)
        : '## Tests\n_No test script found_',
      nativeResult
        ? this._formatCommandResult('Native Project Verification', nativeResult)
        : '## Native Project Verification\n_No native project verification command found_',
      this.modelConfig.requireVerificationScripts && !compileResult && !testResult && !nativeResult
        ? '## Verification Gate\nFailed: generated project must include at least one compile, build, or test script.'
        : '',
    ].join('\n\n');

    return {
      compileResult,
      testResult,
      output,
      failed: failedCommands.length > 0,
      failedCommands,
      skippedChecks,
    };
  }

  private _nativeVerificationCommand(): string | null {
    if (this.fileManager.fileExists('Package.swift')) {
      return 'swift test';
    }

    const workspace = this._findWorkspaceEntryByExtension('.xcworkspace');
    if (workspace) {
      return `xcodebuild -list -workspace ${this._quoteShell(workspace)}`;
    }

    const project = this._findWorkspaceEntryByExtension('.xcodeproj');
    if (project) {
      return `xcodebuild -list -project ${this._quoteShell(project)}`;
    }

    const gradleWrapper = this.fileManager.fileExists('gradlew') ? './gradlew' : null;
    if (gradleWrapper) {
      return `${gradleWrapper} test`;
    }

    return null;
  }

  private _findWorkspaceEntryByExtension(extension: string): string | null {
    const scan = (dir: string): string | null => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'out') {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        const rel = path.relative(this.workspace.rootDir, fullPath).replace(/\\/g, '/');
        if ((entry.isDirectory() || entry.isFile()) && entry.name.endsWith(extension)) {
          return rel;
        }
        if (entry.isDirectory()) {
          const nested = scan(fullPath);
          if (nested) { return nested; }
        }
      }
      return null;
    };

    return scan(this.workspace.rootDir);
  }

  private async _analyzeProjectChecks(checks: ProjectCheckResults): Promise<TesterOutput> {
    const { model, fallbackModel } = this._agentConfig('tester');
    const context =
      `# Test Run Results\n\n${checks.output}\n\n` +
      `# Command Status\n\n` +
      `Failed commands: ${checks.failedCommands.join(', ') || 'none'}\n` +
      `Skipped checks: ${checks.skippedChecks.join(', ') || 'none'}`;
    const messages = this._buildMessages('tester', context);

    let testerOutput: TesterOutput;
    try {
      testerOutput = await this._callWithFallbackJson<TesterOutput>(
        'tester', model, fallbackModel, messages, this.workspace.testerPath, []
      );
    } catch (err) {
      logWarn(`Tester agent failed: ${formatError(err)}.`);
      testerOutput = {
        passed: !checks.failed,
        testsRun: 0,
        errors: checks.failed ? [`Tester agent failed while checks were failing: ${formatError(err)}`] : [],
        warnings: [],
        needsFix: checks.failed,
        fixDescription: checks.failed ? 'Inspect the failing command output and fix the project files.' : undefined,
        rawOutput: checks.output.substring(0, 2000),
      };
    }

    testerOutput.errors = testerOutput.errors ?? [];
    testerOutput.warnings = testerOutput.warnings ?? [];
    testerOutput.rawOutput = testerOutput.rawOutput ?? checks.output.substring(0, 2000);

    // Exit codes are the source of truth. The tester agent may explain failures,
    // but it cannot turn a failing command into a passing verification result.
    if (checks.failed) {
      testerOutput.passed = false;
      testerOutput.needsFix = true;
      if (testerOutput.errors.length === 0) {
        testerOutput.errors.push(`Failing commands: ${checks.failedCommands.join(', ')}`);
      }
      testerOutput.fixDescription = testerOutput.fixDescription
        ?? `Fix failing commands: ${checks.failedCommands.join(', ')}`;
    } else {
      testerOutput.passed = true;
      testerOutput.needsFix = false;
    }

    return testerOutput;
  }

  private _formatCommandResult(label: string, result: TerminalRunResult): string {
    return [
      `## ${label}`,
      `Command: ${result.command}`,
      `Exit: ${result.exitCode}`,
      result.stdout,
      result.stderr,
      result.error ? `Error: ${result.error}` : '',
    ].filter(Boolean).join('\n');
  }

  private _packageScriptCommand(packageManager: 'npm' | 'pnpm' | 'yarn', scriptName: string): string {
    if (packageManager === 'yarn') { return `yarn ${scriptName}`; }
    return `${packageManager} run ${scriptName}`;
  }

  private _userPromptWithFileContext(): string {
    const promptContext = this._promptFileContext();
    if (!promptContext.context) { return promptContext.prompt; }
    return `${promptContext.prompt}\n\n---\n\n${promptContext.context}`;
  }

  private _promptReferencedFilePaths(): string[] {
    return this._promptFileContext().files;
  }

  private _persistPromptFileContextNote(): void {
    const promptContext = this._promptFileContext();
    if (!promptContext.context) { return; }

    this.workspace.writeFile(
      this.workspace.agentNotePath('00_prompt_files.md'),
      promptContext.context
    );
    this._emit('log', `Loaded ${promptContext.files.length} prompt-referenced file(s): ${promptContext.files.join(', ')}`, 'info');
  }

  private _promptFileContext(): PromptFileContext {
    const prompt = this.workspace.readUserPrompt();
    if (this._promptFileContextCache?.prompt === prompt) {
      return this._promptFileContextCache;
    }

    const files = this._resolvePromptReferencedFiles(prompt).slice(0, 10);
    let remainingChars = 40_000;
    const sections: string[] = [];
    const includedFiles: string[] = [];

    for (const file of files) {
      if (remainingChars <= 0) { break; }
      const content = this.fileManager.readWorkspaceFile(file);
      if (content === null) { continue; }

      const maxForFile = Math.min(12_000, remainingChars);
      const displayed = content.length > maxForFile
        ? `${content.slice(0, maxForFile)}\n\n[File truncated after ${maxForFile} characters.]`
        : content;
      sections.push(`## File: ${file}\n\n\`\`\`${this._markdownFenceInfo(file)}\n${displayed}\n\`\`\``);
      includedFiles.push(file);
      remainingChars -= displayed.length;
    }

    const context = sections.length > 0
      ? [
        '# Prompt-Referenced Workspace Files',
        '',
        'The user prompt explicitly referenced these workspace files. Treat note/spec/requirements files as authoritative instructions. If the prompt asks to edit a referenced file, modify that file directly.',
        '',
        ...sections,
      ].join('\n')
      : '';

    this._promptFileContextCache = { prompt, context, files: includedFiles };
    return this._promptFileContextCache;
  }

  private _resolvePromptReferencedFiles(prompt: string): string[] {
    const candidates = this._extractPromptFileCandidates(prompt);
    if (candidates.length === 0) { return []; }

    const workspaceFiles = this.fileManager
      .listWorkspaceFiles('', this._textFileExtensions())
      .filter(file => this._isSafeWorkspaceRelativePath(this._normalizeRelativePath(file)));
    const resolved = new Set<string>();

    for (const candidate of candidates) {
      const file = this._resolvePromptFileCandidate(candidate, workspaceFiles);
      if (file) { resolved.add(file); }
    }

    return [...resolved];
  }

  private _extractPromptFileCandidates(prompt: string): string[] {
    const candidates = new Set<string>();

    for (const file of this._extractWorkspaceFileMentions(prompt)) {
      candidates.add(file);
    }

    const quotedPattern = /[`'"]([^`'"\r\n]+\.[A-Za-z0-9]{1,12})[`'"]/g;
    const atPattern = /@([^\s`'"]+\.[A-Za-z0-9]{1,12})/g;
    const barePattern = /\b(?:read|doc|file|note|notes?|tep|t[eê]p|đọc)\s+(?:file\s+)?([A-Za-z0-9_-]{3,})\b/gi;

    for (const pattern of [quotedPattern, atPattern, barePattern]) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(prompt)) !== null) {
        candidates.add(match[1]);
      }
    }

    return [...candidates];
  }

  private _resolvePromptFileCandidate(candidate: string, workspaceFiles: string[]): string | null {
    const normalized = this._normalizePromptFileCandidate(candidate);
    if (!normalized) { return null; }

    const normalizedLower = normalized.toLowerCase();
    const exact = workspaceFiles.find(file => file.toLowerCase() === normalizedLower);
    if (exact) { return exact; }

    const candidateBase = path.posix.basename(normalized).toLowerCase();
    const candidateExt = path.posix.extname(normalized);
    const candidateStem = candidateExt ? candidateBase.slice(0, -candidateExt.length) : candidateBase;
    const matches = workspaceFiles.filter(file => {
      const fileBase = path.posix.basename(file).toLowerCase();
      const fileExt = path.posix.extname(fileBase);
      const fileStem = fileExt ? fileBase.slice(0, -fileExt.length) : fileBase;
      if (candidateExt) { return fileBase === candidateBase; }
      return fileStem === candidateStem || fileStem === `${candidateStem}s` || `${fileStem}s` === candidateStem;
    });

    return matches.length === 1 ? matches[0] : null;
  }

  private _normalizePromptFileCandidate(candidate: string): string | null {
    let cleaned = candidate
      .trim()
      .replace(/^[@`'"]+/, '')
      .replace(/[`'",.;:)]+$/, '')
      .replace(/\\/g, '/');

    if (!cleaned) { return null; }

    if (path.isAbsolute(cleaned)) {
      const relative = path.relative(this.workspace.rootDir, cleaned).replace(/\\/g, '/');
      if (relative.startsWith('../') || path.isAbsolute(relative)) { return null; }
      cleaned = relative;
    }

    const normalized = this._normalizeRelativePath(cleaned);
    return this._isSafeWorkspaceRelativePath(normalized) ? normalized : null;
  }

  private _textFileExtensions(): string[] {
    return [
      '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.plist',
      '.storyboard', '.swift', '.ts', '.tsx', '.txt', '.xcconfig', '.xib', '.xml',
      '.yml', '.yaml',
    ];
  }

  private _markdownFenceInfo(filePath: string): string {
    return path.posix.extname(filePath).replace('.', '') || 'text';
  }

  private _collectTestFixAllowedFiles(checks: ProjectCheckResults, testerOutput: TesterOutput): string[] {
    const files = new Set<string>();

    for (const file of this._collectChangedFiles()) {
      if (this.fileManager.fileExists(file)) {
        files.add(file);
      }
    }

    for (const file of this._promptReferencedFilePaths()) {
      if (this.fileManager.fileExists(file)) {
        files.add(file);
      }
    }

    const taskPlan = this._loadTaskPlan();
    for (const task of taskPlan?.tasks ?? []) {
      for (const file of task.allowedFiles) {
        const normalized = this._normalizeRelativePath(file);
        if (normalized && normalized !== '..' && !normalized.startsWith('../')) {
          files.add(normalized);
        }
      }
    }

    if (this.fileManager.fileExists('package.json')) {
      files.add('package.json');
    }

    const text = [
      checks.output,
      testerOutput.rawOutput ?? '',
      testerOutput.errors.join('\n'),
      testerOutput.warnings.join('\n'),
      testerOutput.fixDescription ?? '',
    ].join('\n');

    for (const file of this._extractWorkspaceFileMentions(text)) {
      if (this.fileManager.fileExists(file)) {
        files.add(file);
      }
    }

    return [...files].sort();
  }

  private _extractWorkspaceFileMentions(text: string): string[] {
    const files = new Set<string>();
    const pattern = /(?:^|[\s('"`])((?:\.\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:cjs|css|html|js|json|jsx|md|mjs|plist|storyboard|swift|ts|tsx|txt|xcconfig|xib|xml|yml|yaml))/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const normalized = this._normalizeRelativePath(match[1]);
      if (
        normalized &&
        !normalized.startsWith('../') &&
        !normalized.startsWith('.agent-workspace/') &&
        !normalized.includes('/node_modules/')
      ) {
        files.add(normalized);
      }
    }
    return [...files];
  }

  private async _phaseFinalIntegration(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'final_integration', 'Final Integrator: Writing report...');

    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const taskResults = this.workspace.readFile(this.workspace.taskResultsPath) ?? '';
    const architectMd = this.workspace.readFile(this.workspace.architectMdPath) ?? '';
    const testerNote = this.workspace.readFile(this.workspace.testerPath) ?? '';
    const projectBrief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const deliveryManifest = this.workspace.readFile(this.workspace.deliveryManifestPath) ?? '';
    const gitSnapshot = this.workspace.readFile(this.workspace.gitSnapshotPath) ?? '';

    // Gather changed files summary
    const changedFiles = this._collectChangedFiles();

    const context =
      `# Original User Prompt\n\n${prompt}\n\n` +
      `# Autonomous Project Brief\n\n${projectBrief}\n\n` +
      `# Architecture\n\n${architectMd}\n\n` +
      `# Task Results\n\n${taskResults}\n\n` +
      `# Test Results\n\n${testerNote}\n\n` +
      `# Delivery Manifest\n\n${deliveryManifest}\n\n` +
      `# Git Repository Snapshot\n\n${gitSnapshot}\n\n` +
      `# Changed Files\n\n${changedFiles.join('\n')}`;

    const { model, fallbackModel } = this._agentConfig('finalIntegrator');
    const messages = this._buildMessages('finalIntegrator', context);

    let report: string;
    try {
      report = await this._callWithFallback('finalIntegrator', model, fallbackModel, messages,
        this.workspace.finalReportPath,
        [this.workspace.userPromptPath, ...promptFiles, this.workspace.architectMdPath]);
    } catch (err) {
      report = this._fallbackFinalReport(prompt, changedFiles, err);
      this.workspace.appendAssumption('finalIntegrator', `Self-healed failed final report model call: ${formatError(err)}`);
      this._emit('log', 'Final integrator model call failed; generated a deterministic final report.', 'warn');
    }

    this.workspace.writeFile(this.workspace.finalReportPath, this._wrapNote('Final Report', report));
    this._updateTimeline('final_integration', 'completed');
    this._recordActivity({
      phase: 'final_integration',
      agentRole: 'finalIntegrator',
      title: 'Final report ready',
      detail: 'Summary, changed files, verification notes, and delivery instructions are complete.',
      status: 'completed',
    });
    this.callbacks.onComplete?.(report);
    this._emit('log', 'Final report generated.', 'info');
  }

  // ------------------------------------------------------------------
  // Agent execution helpers
  // ------------------------------------------------------------------

  private async _executeCodeWorker(
    task: TaskItem,
    architectMd: string,
    rollingSummary: string,
    _state: ProjectState
  ): Promise<CodeWorkerOutput | null> {
    // Build context: task + architecture + existing file contents
    const existingFilesContent = task.allowedFiles.length > 0
      ? this.fileManager.readFilesAsContext(task.allowedFiles)
      : '';
    const answeredQuestions = this.workspace.readFile(this.workspace.openQuestionsPath) ?? '';
    const assumptions = this.workspace.readFile(this.workspace.assumptionsPath) ?? '';
    const promptWithFiles = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const projectBrief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const toolchain = this.workspace.readFile(this.workspace.toolchainReportPath) ?? '';
    const gitSnapshot = this.workspace.readFile(this.workspace.gitSnapshotPath) ?? '';

    const context =
      `# Task\n\n` +
      `**ID:** ${task.id}\n**Title:** ${task.title}\n\n` +
      `**Description:**\n${task.description}\n\n` +
      `**Allowed Files:** ${task.allowedFiles.join(', ') || 'any'}\n` +
      `**Forbidden Actions:** ${task.forbiddenActions.join(', ') || 'none'}\n\n` +
      `**Acceptance Criteria:**\n${task.acceptanceCriteria.map(c => `- ${c}`).join('\n')}\n\n` +
      `# Original User Prompt And Referenced Files\n\n${promptWithFiles}\n\n` +
      `# Autonomous Project Brief\n\n${projectBrief}\n\n` +
      `# Architecture\n\n${architectMd}\n\n` +
      `# Local Toolchain Report\n\n${toolchain}\n\n` +
      `# Git Repository Snapshot\n\n${gitSnapshot}\n\n` +
      `# Rolling Summary\n\n${rollingSummary}\n\n` +
      `# User Answers And Clarifications\n\n${answeredQuestions}\n\n` +
      `# Autonomous Assumptions\n\n${assumptions}` +
      (existingFilesContent ? `\n\n# Existing File Contents${existingFilesContent}` : '');

    const { model, fallbackModel } = this._agentConfig('codeWorker');
    const messages = this._buildMessages('codeWorker', context);

    try {
      const result = await this._callWithFallbackJson<CodeWorkerOutput>(
        'codeWorker', model, fallbackModel, messages, this.workspace.codeWorkerPath,
        [...task.allowedFiles, ...promptFiles]
      );
      // Normalise content to string — LLMs sometimes return arrays or objects
      if (Array.isArray(result.files)) {
        for (const f of result.files) {
          if (f.content !== undefined && typeof f.content !== 'string') {
            f.content = Array.isArray(f.content)
              ? (f.content as unknown[]).join('\n')
              : String(f.content);
          }
          // Normalise action — LLMs sometimes omit it or use an invalid value
          const validActions = new Set(['create', 'modify', 'append', 'delete']);
          if (!validActions.has(f.action)) {
            f.action = 'modify';
          }
        }
      }
      return result;
    } catch (err) {
      this._emit('error', `Code worker failed for task "${task.id}": ${formatError(err)}`);
      return null;
    }
  }

  private async _executeReviewer(
    task: TaskItem,
    workerOutput: CodeWorkerOutput,
    _state: ProjectState
  ): Promise<ReviewResult> {
    const filesContext = workerOutput.files
      .map(f => `## File: ${f.path}\n\`\`\`\n${(f.content ?? '').substring(0, 3000)}\n\`\`\``)
      .join('\n\n');
    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const projectBrief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const architecture = this.workspace.readFile(this.workspace.architectMdPath) ?? '';
    const gitSnapshot = this.workspace.readFile(this.workspace.gitSnapshotPath) ?? '';

    const context =
      `# Original User Prompt\n\n${prompt}\n\n` +
      `# Autonomous Project Brief\n\n${projectBrief}\n\n` +
      `# Architecture\n\n${architecture.substring(0, 6000)}\n\n` +
      `# Git Repository Snapshot\n\n${gitSnapshot}\n\n` +
      `# Task to Review\n\n**ID:** ${task.id}\n**Title:** ${task.title}\n\n` +
      `**Description:**\n${task.description}\n\n` +
      `**Acceptance Criteria:**\n${task.acceptanceCriteria.map(c => `- ${c}`).join('\n')}\n\n` +
      `**Allowed Files:** ${task.allowedFiles.join(', ') || 'any'}\n` +
      `**Forbidden Actions:** ${task.forbiddenActions.join(', ') || 'none'}\n\n` +
      `# Files Changed\n\n${filesContext}`;

    const { model, fallbackModel } = this._agentConfig('reviewer');
    const messages = this._buildMessages('reviewer', context);

    try {
      const review = await this._callWithFallbackJson<ReviewResult>(
        'reviewer', model, fallbackModel, messages, this.workspace.reviewerPath, promptFiles
      );
      review.taskId = review.taskId || task.id;
      review.reviewedAt = review.reviewedAt || new Date().toISOString();

      // Save review note
      this.workspace.appendFile(this.workspace.reviewerPath, `\n\n---\n\n${prettyJson(review)}`);
      return review;
    } catch (err) {
      logWarn(`Reviewer failed for task "${task.id}": ${formatError(err)}. Falling back to heuristic review.`);
      const issues = this._heuristicReviewIssues(workerOutput);
      return {
        taskId: task.id,
        approved: issues.length === 0,
        issues,
        suggestions: [],
        securityConcerns: [],
        needsFix: issues.length > 0,
        fixSuggestions: issues.length > 0 ? ['Fix the heuristic review issues and return complete file contents.'] : [],
        reviewedAt: new Date().toISOString(),
      };
    }
  }

  private async _executeFixer(
    task: TaskItem,
    review: ReviewResult,
    _state: ProjectState
  ): Promise<CodeWorkerOutput | null> {
    const errorContext = [
      ...review.issues.map(i => `- Issue: ${i}`),
      ...review.securityConcerns.map(c => `- Security: ${c}`),
      ...review.fixSuggestions.map(s => `- Fix: ${s}`),
    ].join('\n');

    const existingFilesContent = task.allowedFiles.length > 0
      ? this.fileManager.readFilesAsContext(task.allowedFiles)
      : '';
    const answeredQuestions = this.workspace.readFile(this.workspace.openQuestionsPath) ?? '';
    const assumptions = this.workspace.readFile(this.workspace.assumptionsPath) ?? '';
    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const projectBrief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const architecture = this.workspace.readFile(this.workspace.architectMdPath) ?? '';
    const toolchain = this.workspace.readFile(this.workspace.toolchainReportPath) ?? '';
    const gitSnapshot = this.workspace.readFile(this.workspace.gitSnapshotPath) ?? '';
    const latestTestOutput = this.workspace.readFile(this.workspace.testResultLogPath) ?? '';

    const context =
      `# Original User Prompt\n\n${prompt}\n\n` +
      `# Autonomous Project Brief\n\n${projectBrief}\n\n` +
      `# Architecture\n\n${architecture.substring(0, 6000)}\n\n` +
      `# Local Toolchain Report\n\n${toolchain}\n\n` +
      `# Git Repository Snapshot\n\n${gitSnapshot}\n\n` +
      `# Task\n\n**ID:** ${task.id}\n**Title:** ${task.title}\n\n` +
      `**Description:**\n${task.description}\n\n` +
      `**Allowed Files:** ${task.allowedFiles.join(', ') || 'none'}\n` +
      `**Acceptance Criteria:**\n${task.acceptanceCriteria.map(c => `- ${c}`).join('\n')}\n\n` +
      `# Errors to Fix\n\n${errorContext}\n\n` +
      `# Latest Verification Output\n\n${latestTestOutput.substring(0, 8000)}\n\n` +
      `# User Answers And Clarifications\n\n${answeredQuestions}\n\n` +
      `# Autonomous Assumptions\n\n${assumptions}\n\n` +
      (existingFilesContent ? `# Current File Contents${existingFilesContent}` : '');

    const { model, fallbackModel } = this._agentConfig('fixer');
    const messages = this._buildMessages('fixer', context);

    try {
      const result = await this._callWithFallbackJson<CodeWorkerOutput>(
        'fixer', model, fallbackModel, messages, this.workspace.codeWorkerPath, [...task.allowedFiles, ...promptFiles]
      );
      // Normalise content and action — LLMs sometimes return arrays, objects, or omit action
      if (Array.isArray(result.files)) {
        for (const f of result.files) {
          if (f.content !== undefined && typeof f.content !== 'string') {
            f.content = Array.isArray(f.content)
              ? (f.content as unknown[]).join('\n')
              : String(f.content);
          }
          const validActions = new Set(['create', 'modify', 'append', 'delete']);
          if (!validActions.has(f.action)) {
            f.action = 'modify';
          }
        }
      }
      return result;
    } catch (err) {
      this._emit('error', `Fixer failed: ${formatError(err)}`);
      return null;
    }
  }

  // ------------------------------------------------------------------
  // File change application with safe mode gate
  // ------------------------------------------------------------------

  private async _applyCodeChanges(
    patchId: string,
    workerOutput: CodeWorkerOutput,
    _state: ProjectState
  ): Promise<boolean> {
    if (workerOutput.files.length === 0) { return true; }

    const preview = this.fileManager.createPatchPreview(workerOutput.files);
    const targetFiles = workerOutput.files.map(f => f.path);

    // Save patch for auditing
    this.fileManager.savePatch(patchId, preview);

    if (this.modelConfig.safeMode && this._requiresPatchApproval(workerOutput) && this._shouldAskUser()) {
      // Request user approval
      const approved = await this._requestPatchApproval(patchId, preview, targetFiles);
      this._checkAborted();
      if (!approved) {
        this._emit('log', `Patch "${patchId}" rejected by user. Skipping file changes.`, 'warn');
        return false;
      }
    } else if (this._requiresPatchApproval(workerOutput) && !this._shouldAskUser()) {
      this._emit('log', `Autonomous mode auto-approved large patch "${patchId}".`, 'warn');
    }

    const result = this.fileManager.applyApprovedChanges(workerOutput.files);
    if (!result.applied) {
      this._emit('error', `Failed to apply changes: ${result.error}`);
      return false;
    } else {
      this._emit('log', `Applied ${workerOutput.files.length} file change(s).`, 'info');
      return true;
    }
  }

  private _requiresPatchApproval(output: CodeWorkerOutput): boolean {
    if (output.files.some(f => f.action === 'delete')) { return true; }
    const totalLines = output.files.reduce((acc, f) => acc + (f.content?.split('\n').length ?? 0), 0);
    return output.files.length > 5 || totalLines > 500;
  }

  private _requestPatchApproval(patchId: string, preview: string, targetFiles: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      this._pendingPatchResolvers.set(patchId, resolve);
      this.callbacks.onPatchApprovalNeeded?.(patchId, preview, targetFiles);
    });
  }

  private _shouldAskUser(): boolean {
    return !this.modelConfig.autonomousMode && this.modelConfig.askPolicy !== 'never';
  }

  private _debateRounds(): number {
    return Math.max(1, Math.min(10, Number(this.modelConfig.debateRounds) || 1));
  }

  private _fallbackProjectBrief(prompt: string): ProjectBrief {
    const lower = prompt.toLowerCase();
    const isMobile = /ios|android|mobile|react native|flutter/.test(lower);
    const isGame = /game|arcade|platformer|puzzle|runner|shooter/.test(lower);
    const isApi = /api|server|backend|rest|graphql/.test(lower);
    const isCli = /cli|command line|terminal/.test(lower);

    const appType = isGame ? 'game' : isMobile ? 'mobile' : isApi ? 'api' : isCli ? 'cli' : 'web';
    const chosenStack = isMobile || isGame
      ? ['Expo', 'React Native', 'TypeScript']
      : isApi
        ? ['Node.js', 'TypeScript']
        : isCli
          ? ['Node.js', 'TypeScript']
          : ['Vite', 'React', 'TypeScript'];

    return {
      projectName: this._slugFromPrompt(prompt),
      goal: prompt.trim() || 'Build a complete local-first software project.',
      appType,
      targetPlatforms: isMobile || isGame ? ['iOS', 'Android'] : ['local development environment'],
      chosenStack,
      coreFeatures: ['Complete implementation of the requested product', 'Usable default UX', 'Documented build and run workflow'],
      assumptions: [
        'Ambiguous product details are resolved with practical defaults.',
        isMobile || isGame
          ? 'Use a cross-platform mobile stack so one codebase targets iOS and Android.'
          : 'Use a lightweight local-first stack that can be verified from package scripts.',
      ],
      nonGoals: [
        'Cloud deployment is not included unless explicitly requested.',
        'Paid signing, store publishing, and external account setup are outside the autonomous local workflow.',
      ],
      acceptanceCriteria: [
        'Project files are generated in the workspace.',
        'At least one build, compile, or test script verifies the project.',
        'A final delivery manifest and archive are produced.',
      ],
      deliveryArtifacts: ['source project', 'README instructions', 'verification log', 'delivery manifest', 'final archive'],
      buildAndRunCommands: ['npm install', 'npm run build or npm test when available'],
      verificationCommands: ['npm run build', 'npm test'],
    };
  }

  private _normalizeProjectBrief(brief: ProjectBrief, prompt: string): ProjectBrief {
    const fallback = this._fallbackProjectBrief(prompt);
    return {
      projectName: brief.projectName || fallback.projectName,
      goal: brief.goal || fallback.goal,
      appType: brief.appType || fallback.appType,
      targetPlatforms: Array.isArray(brief.targetPlatforms) && brief.targetPlatforms.length > 0 ? brief.targetPlatforms : fallback.targetPlatforms,
      chosenStack: Array.isArray(brief.chosenStack) && brief.chosenStack.length > 0 ? brief.chosenStack : fallback.chosenStack,
      coreFeatures: Array.isArray(brief.coreFeatures) && brief.coreFeatures.length > 0 ? brief.coreFeatures : fallback.coreFeatures,
      assumptions: Array.isArray(brief.assumptions) ? brief.assumptions : fallback.assumptions,
      nonGoals: Array.isArray(brief.nonGoals) ? brief.nonGoals : fallback.nonGoals,
      acceptanceCriteria: Array.isArray(brief.acceptanceCriteria) && brief.acceptanceCriteria.length > 0 ? brief.acceptanceCriteria : fallback.acceptanceCriteria,
      deliveryArtifacts: Array.isArray(brief.deliveryArtifacts) && brief.deliveryArtifacts.length > 0 ? brief.deliveryArtifacts : fallback.deliveryArtifacts,
      buildAndRunCommands: Array.isArray(brief.buildAndRunCommands) ? brief.buildAndRunCommands : fallback.buildAndRunCommands,
      verificationCommands: Array.isArray(brief.verificationCommands) ? brief.verificationCommands : fallback.verificationCommands,
    };
  }

  private _fallbackAgentNote(role: AgentRole, context: string, err: unknown): string {
    const title: Record<AgentRole, string> = {
      briefBuilder: 'Autonomous Brief Recovery',
      brainstorm: 'Brainstorm Analysis',
      critic: 'Critique & Improvements',
      secondBrainstorm: 'Product & UX Perspective',
      architect: 'Architecture Recovery',
      taskManager: 'Task Planning Recovery',
      codeWorker: 'Code Worker Recovery',
      reviewer: 'Review Recovery',
      tester: 'Verification Recovery',
      fixer: 'Fix Recovery',
      finalIntegrator: 'Final Project Report',
    };

    return [
      `# ${title[role]}`,
      '',
      '## Self-Healing Recovery',
      `The ${role} model call failed, so the workflow continued with a deterministic recovery note.`,
      '',
      '## Error',
      formatError(err),
      '',
      '## Working Assumptions',
      '- Preserve the original user request as the source of truth.',
      '- Prefer a local-first implementation that can be verified with package scripts.',
      '- Keep scope small enough for the coding and testing phases to complete autonomously.',
      '',
      '## Available Context Excerpt',
      this._truncateMiddle(context, 2_500, '\n\n[context compacted]\n\n'),
    ].join('\n');
  }

  private _fallbackArchitectPlan(prompt: string, briefRaw: string, err?: unknown): ArchitectPlan {
    const brief = this._projectBriefFromRaw(briefRaw, prompt);
    const projectStructure = this._fallbackProjectStructure(brief);
    const constraints = [
      'Autonomous self-healing mode generated this plan after a model or JSON failure.',
      'Use local tooling and package scripts so dependency install, build, and tests can be automated.',
      'Keep implementation scope focused on the project brief acceptance criteria.',
    ];
    if (err) {
      constraints.push(`Recovered from: ${this._truncateMiddle(formatError(err), 400, ' ... ')}`);
    }

    return {
      summary: brief.goal,
      technology: brief.chosenStack.length > 0 ? brief.chosenStack : this._fallbackProjectBrief(prompt).chosenStack,
      projectStructure,
      keyDecisions: [
        `Build a ${brief.appType || 'web'} project named ${brief.projectName}.`,
        'Generate complete source, package scripts, README instructions, and verification coverage.',
        'Resolve missing requirements through recorded assumptions instead of pausing for user input.',
      ],
      constraints,
      needUserInput: false,
      questions: [],
      readyToCode: true,
    };
  }

  private _formatFallbackArchitecture(plan: ArchitectPlan, err: unknown): string {
    return [
      '# Architecture Plan',
      '',
      '## Self-Healing Recovery',
      `The architect model call failed, so a deterministic architecture was generated. Error: ${formatError(err)}`,
      '',
      '## Summary',
      plan.summary,
      '',
      '## Technology',
      plan.technology.map(item => `- ${item}`).join('\n'),
      '',
      '## Project Structure',
      plan.projectStructure.map(item => `- ${item}`).join('\n'),
      '',
      '## Key Decisions',
      plan.keyDecisions.map(item => `- ${item}`).join('\n'),
      '',
      '## Constraints',
      plan.constraints.map(item => `- ${item}`).join('\n'),
      '',
      '```json',
      prettyJson(plan),
      '```',
    ].join('\n');
  }

  private _fallbackTaskPlan(briefRaw: string, architectMd: string, err?: unknown): TaskPlan {
    const brief = this._projectBriefFromRaw(briefRaw, this.workspace.readUserPrompt());
    const structure = this._fallbackProjectStructure(brief);
    const now = new Date().toISOString();
    const scaffoldFiles = structure.filter(file =>
      /^(package\.json|tsconfig\.json|vite\.config\.ts|index\.html|app\.json|README\.md)$/.test(file)
    );
    const sourceFiles = structure.filter(file => file.startsWith('src/'));
    const testFiles = structure.filter(file => file.startsWith('test/') || file.startsWith('tests/'));
    const allFiles = [...new Set([...structure, 'README.md'])];
    const recoveryNote = err ? `\n\nSelf-healing recovery note: ${formatError(err)}` : '';

    return {
      tasks: [
        {
          id: 'task-001',
          title: 'Create project scaffold and scripts',
          description:
            `Create the project metadata, package scripts, entry points, and README for: ${brief.goal}.${recoveryNote}`,
          assignedAgent: 'codeWorker',
          dependsOn: [],
          allowedFiles: scaffoldFiles.length > 0 ? scaffoldFiles : allFiles,
          forbiddenActions: ['Do not create files outside the workspace.'],
          acceptanceCriteria: [
            'Project has install, build or test scripts in package.json when applicable.',
            'README explains how to run and verify the project locally.',
          ],
          status: 'pending',
          createdAt: now,
        },
        {
          id: 'task-002',
          title: 'Implement core application behavior',
          description:
            `Implement the core features from the autonomous brief using the architecture context below.\n\n${this._truncateMiddle(architectMd, 3_000, '\n\n[architecture compacted]\n\n')}`,
          assignedAgent: 'codeWorker',
          dependsOn: ['task-001'],
          allowedFiles: sourceFiles.length > 0 ? sourceFiles : allFiles,
          forbiddenActions: ['Do not remove verification scripts.'],
          acceptanceCriteria: brief.acceptanceCriteria.length > 0
            ? brief.acceptanceCriteria
            : ['The requested product behavior is implemented with complete source files.'],
          status: 'pending',
          createdAt: now,
        },
        {
          id: 'task-003',
          title: 'Add verification coverage and delivery documentation',
          description:
            'Add or update tests, smoke checks, and documentation so the testing phase can verify the generated project.',
          assignedAgent: 'codeWorker',
          dependsOn: ['task-002'],
          allowedFiles: [...new Set([...testFiles, 'package.json', 'README.md'])],
          forbiddenActions: ['Do not replace real tests with placeholders.'],
          acceptanceCriteria: [
            'At least one compile, build, or test script can be run by the workflow.',
            'Tests or smoke checks cover the main user-facing behavior.',
          ],
          status: 'pending',
          createdAt: now,
        },
      ],
      totalTasks: 3,
      estimatedComplexity: allFiles.length > 7 ? 'medium' : 'low',
      notes: 'Generated by deterministic self-healing task planner after model output failed or was invalid.',
      createdAt: now,
    };
  }

  private _fallbackProjectStructure(brief: ProjectBrief): string[] {
    const appType = (brief.appType || '').toLowerCase();
    if (/api|server|backend/.test(appType)) {
      return ['package.json', 'tsconfig.json', 'src/index.ts', 'src/server.ts', 'test/server.test.ts', 'README.md'];
    }
    if (/cli|command/.test(appType)) {
      return ['package.json', 'tsconfig.json', 'src/index.ts', 'test/index.test.ts', 'README.md'];
    }
    if (/mobile|game/.test(appType)) {
      return ['package.json', 'app.json', 'src/App.tsx', 'src/game.ts', 'test/app.test.ts', 'README.md'];
    }
    return [
      'package.json',
      'tsconfig.json',
      'vite.config.ts',
      'index.html',
      'src/main.tsx',
      'src/App.tsx',
      'src/styles.css',
      'test/app.test.ts',
      'README.md',
    ];
  }

  private _projectBriefFromRaw(raw: string, prompt: string): ProjectBrief {
    try {
      return this._normalizeProjectBrief(parseJsonResponse<ProjectBrief>(raw), prompt);
    } catch {
      return this._fallbackProjectBrief(prompt);
    }
  }

  private _fallbackFinalReport(prompt: string, changedFiles: string[], err: unknown): string {
    return [
      '# Final Project Report',
      '',
      '## Summary',
      'The workflow reached final integration using deterministic self-healing after the final report model call failed.',
      '',
      '## Original Request',
      prompt,
      '',
      '## Files Created / Modified',
      changedFiles.length > 0 ? changedFiles.map(file => `- ${file}`).join('\n') : '- No task result files were recorded.',
      '',
      '## Recovery Note',
      formatError(err),
      '',
      '## Next Steps',
      '- Inspect the generated files and verification log.',
      '- Run the package scripts listed in README or package.json.',
    ].join('\n');
  }

  private _normalizeAutonomousWorkerOutput(
    role: 'codeWorker' | 'fixer',
    task: TaskItem,
    output: CodeWorkerOutput
  ): void {
    if (this._shouldAskUser() || !output.needUserInput || output.questions.length === 0) {
      return;
    }

    for (const question of output.questions) {
      this.workspace.appendAssumption(
        role,
        `Task ${task.id} requested clarification: ${question}\nAssumption: proceed with the simplest implementation that satisfies the task acceptance criteria.`
      );
    }
    output.needUserInput = false;
    output.questions = [];
    output.blockedReason = undefined;
  }

  private _heuristicReviewIssues(workerOutput: CodeWorkerOutput): string[] {
    const issues: string[] = [];
    if (!Array.isArray(workerOutput.files) || workerOutput.files.length === 0) {
      issues.push('No file changes were produced.');
      return issues;
    }

    for (const file of workerOutput.files) {
      const content = file.content ?? '';
      if (file.action !== 'delete' && content.trim().length === 0) {
        issues.push(`${file.path} is empty.`);
      }
      if (/\bTODO\b|not implemented|throw new Error\(["']not implemented/i.test(content)) {
        issues.push(`${file.path} appears to contain placeholder implementation text.`);
      }
    }
    return issues;
  }

  private _artifactDir(): string {
    const configured = this._normalizeRelativePath(this.modelConfig.artifactDir || 'dist');
    if (!configured || configured === '..' || configured.startsWith('../')) {
      return 'dist';
    }
    return configured.replace(/\/+$/, '') || 'dist';
  }

  private _readToolchainReport(): ToolchainReport | undefined {
    const raw = this.workspace.readFile(this.workspace.toolchainReportPath);
    if (!raw) { return undefined; }
    try { return JSON.parse(raw) as ToolchainReport; } catch { return undefined; }
  }

  private _readGitSnapshot(): GitRepositorySnapshot | undefined {
    const raw = this.workspace.readFile(this.workspace.gitSnapshotPath);
    if (!raw) { return undefined; }
    try { return JSON.parse(raw) as GitRepositorySnapshot; } catch { return undefined; }
  }

  private _quoteShell(value: string): string {
    return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
  }

  private _slugFromPrompt(prompt: string): string {
    const slug = prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    return slug || 'autonomous-project';
  }

  // ------------------------------------------------------------------
  // Internal utilities
  // ------------------------------------------------------------------

  private _loadConfig(): void {
    this.modelConfig = this.workspace.readModelConfig();
    this.ollama = new OllamaClient(
      this.modelConfig.ollamaBaseUrl,
      this.workspace.ollamaCallsLogPath,
      this.modelConfig.requestTimeoutMs
    );
    this.terminal = new TerminalRunner(
      this.workspace.rootDir,
      this.workspace.terminalLogPath
    );
  }

  private _agentConfig(role: AgentRole): { model: string; fallbackModel: string } {
    return this.modelConfig.agents[role];
  }

  private _buildMessages(role: AgentRole, userContent: string): OllamaMessage[] {
    const { systemPrompt } = getAgentPrompt(role);
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: buildUserMessage(userContent, role) },
    ];
  }

  private async _callWithFallback(
    role: AgentRole,
    model: string,
    fallbackModel: string,
    messages: OllamaMessage[],
    outputFile: string,
    inputFiles: string[]
  ): Promise<string> {
    try {
      return await this.ollama.callWithFallback(
        model, fallbackModel, messages, role,
        this.modelConfig.defaultOptions, outputFile, inputFiles
      );
    } catch (err) {
      return await this._selfHealTextModelCall(role, model, fallbackModel, messages, outputFile, inputFiles, err);
    }
  }

  private async _callWithFallbackJson<T>(
    role: AgentRole,
    model: string,
    fallbackModel: string,
    messages: OllamaMessage[],
    outputFile: string,
    inputFiles: string[]
  ): Promise<T> {
    try {
      return await this.ollama.callWithFallbackJson<T>(
        model, fallbackModel, messages, role,
        this.modelConfig.defaultOptions, outputFile, inputFiles
      );
    } catch (err) {
      return await this._selfHealJsonModelCall<T>(role, model, fallbackModel, messages, outputFile, inputFiles, err);
    }
  }

  private async _selfHealTextModelCall(
    role: AgentRole,
    model: string,
    fallbackModel: string,
    messages: OllamaMessage[],
    outputFile: string,
    inputFiles: string[],
    originalError: unknown
  ): Promise<string> {
    const healing = this._selfHealingConfig();
    if (!healing.enabled) { throw originalError; }

    this._emit('log', `Self-healing model call for ${role}: ${formatError(originalError)}`, 'warn');
    const recoveryMessages = this._compactMessagesForRecovery(messages, healing.compactContextChars);
    let lastError = originalError;

    for (let attempt = 1; attempt <= healing.modelCallRetries; attempt++) {
      this._checkAborted();
      await this._delay(healing.retryDelayMs * attempt);
      try {
        this._emit('log', `Retrying ${role} model call (${attempt}/${healing.modelCallRetries}) with compact context...`, 'warn');
        return await this.ollama.callWithFallback(
          model, fallbackModel, recoveryMessages, role,
          this.modelConfig.defaultOptions, outputFile, inputFiles
        );
      } catch (err) {
        lastError = err;
        logWarn(`Self-healing retry ${attempt} for ${role} failed: ${formatError(err)}`);
      }
    }

    for (const alternateModel of await this._alternateModels([model, fallbackModel], healing.alternateModelLimit)) {
      this._checkAborted();
      try {
        this._emit('log', `Trying alternate local model "${alternateModel}" for ${role}...`, 'warn');
        return await this.ollama.chat(
          alternateModel, recoveryMessages, role,
          this.modelConfig.defaultOptions, outputFile, inputFiles
        );
      } catch (err) {
        lastError = err;
        logWarn(`Alternate model "${alternateModel}" for ${role} failed: ${formatError(err)}`);
      }
    }

    throw lastError;
  }

  private async _selfHealJsonModelCall<T>(
    role: AgentRole,
    model: string,
    fallbackModel: string,
    messages: OllamaMessage[],
    outputFile: string,
    inputFiles: string[],
    originalError: unknown
  ): Promise<T> {
    const healing = this._selfHealingConfig();
    if (!healing.enabled) { throw originalError; }

    this._emit('log', `Self-healing JSON model call for ${role}: ${formatError(originalError)}`, 'warn');
    const recoveryMessages = this._compactMessagesForRecovery(messages, healing.compactContextChars);
    let lastError = originalError;

    for (let attempt = 1; attempt <= healing.modelCallRetries; attempt++) {
      this._checkAborted();
      await this._delay(healing.retryDelayMs * attempt);
      try {
        this._emit('log', `Retrying ${role} JSON call (${attempt}/${healing.modelCallRetries}) with compact context...`, 'warn');
        return await this.ollama.callWithFallbackJson<T>(
          model, fallbackModel, recoveryMessages, role,
          this.modelConfig.defaultOptions, outputFile, inputFiles
        );
      } catch (err) {
        lastError = err;
        logWarn(`Self-healing JSON retry ${attempt} for ${role} failed: ${formatError(err)}`);
      }
    }

    for (const alternateModel of await this._alternateModels([model, fallbackModel], healing.alternateModelLimit)) {
      this._checkAborted();
      try {
        this._emit('log', `Trying alternate local model "${alternateModel}" for ${role} JSON...`, 'warn');
        return await this.ollama.chatJson<T>(
          alternateModel, recoveryMessages, role,
          this.modelConfig.defaultOptions, outputFile, inputFiles
        );
      } catch (err) {
        lastError = err;
        logWarn(`Alternate JSON model "${alternateModel}" for ${role} failed: ${formatError(err)}`);
      }
    }

    throw lastError;
  }

  private _selfHealingConfig(): SelfHealingConfig {
    return this.modelConfig.selfHealing ?? {
      enabled: true,
      modelCallRetries: 2,
      retryDelayMs: 5_000,
      alternateModelLimit: 3,
      compactContextChars: 12_000,
    };
  }

  private _compactMessagesForRecovery(messages: OllamaMessage[], maxUserChars: number): OllamaMessage[] {
    return messages.map(message => {
      if (message.role !== 'user' || message.content.length <= maxUserChars) {
        return message;
      }
      const marker =
        '\n\n[Self-healing note: middle context was compacted after a model failure. ' +
        'Continue with the available requirements and output the requested schema.]\n\n';
      return {
        ...message,
        content: this._truncateMiddle(message.content, Math.max(2_000, maxUserChars), marker),
      };
    });
  }

  private _truncateMiddle(text: string, maxChars: number, marker: string): string {
    if (text.length <= maxChars) { return text; }
    const keep = Math.max(500, Math.floor((maxChars - marker.length) / 2));
    return `${text.slice(0, keep)}${marker}${text.slice(-keep)}`;
  }

  private async _alternateModels(excludedModels: string[], limit: number): Promise<string[]> {
    if (limit <= 0 || typeof this.ollama.listModels !== 'function') { return []; }
    try {
      const excluded = new Set(excludedModels.map(model => this._normalizeModelName(model)));
      const models = await this.ollama.listModels();
      return models
        .filter(model => !excluded.has(this._normalizeModelName(model)))
        .slice(0, limit);
    } catch (err) {
      logWarn(`Could not list alternate local models for self-healing: ${formatError(err)}`);
      return [];
    }
  }

  private _normalizeModelName(model: string): string {
    return model.endsWith(':latest') ? model.slice(0, -':latest'.length) : model;
  }

  private _delay(ms: number): Promise<void> {
    if (ms <= 0) { return Promise.resolve(); }
    const deadline = Date.now() + ms;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this._aborted) {
          reject(new UserAbortError());
          return;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          resolve();
          return;
        }
        setTimeout(tick, Math.min(250, remainingMs));
      };
      setTimeout(tick, Math.min(250, ms));
    });
  }

  private _newState(prompt: string): ProjectState {
    const now = new Date().toISOString();
    return {
      projectGoal: prompt,
      status: 'running',
      currentPhase: 'intake',
      confirmedByUser: false,
      createdAt: now,
      updatedAt: now,
      openQuestions: [],
      decisions: [],
      activeTasks: [],
      completedTasks: [],
      failedTasks: [],
      currentTaskId: null,
      fixRetryCount: 0,
    };
  }

  private _setPhase(state: ProjectState, phase: WorkflowPhase, message: string): void {
    state.currentPhase = phase;
    state.status = 'running';
    state.updatedAt = new Date().toISOString();
    this.workspace.writeProjectState(state);
    this._updateTimeline(phase, 'running');
    this._recordActivity({
      phase,
      agentRole: this._agentRoleForPhase(phase),
      title: this._phaseTitle(phase),
      detail: message,
      status: 'running',
    });
    this.callbacks.onStateUpdate?.(state);
    this._emit('phase', phase, message);
    logInfo(`Phase: ${phase} – ${message}`);
  }

  private _createQuestion(
    agentRole: AgentRole,
    phase: WorkflowPhase,
    question: string,
    context?: string
  ): UserQuestion {
    return {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      agentRole,
      phase,
      question,
      context,
    };
  }

  private _checkAborted(): void {
    if (this._aborted) { throw new UserAbortError(); }
  }

  private _phaseAlreadyDone(currentPhase: WorkflowPhase, checkPhase: WorkflowPhase, _done: WorkflowPhase[]): boolean {
    if (checkPhase === 'briefing' && !this.workspace.fileExists(this.workspace.projectBriefPath)) {
      return false;
    }
    if (checkPhase === 'toolchain_discovery' && !this.workspace.fileExists(this.workspace.toolchainReportPath)) {
      return false;
    }
    if (checkPhase === 'artifact_delivery' && !this.workspace.fileExists(this.workspace.deliveryManifestPath)) {
      return false;
    }

    const normalizedPhase: WorkflowPhase = currentPhase === 'reviewing' ? 'coding' : currentPhase;
    const order: WorkflowPhase[] = [
      'idle', 'intake', 'briefing', 'brainstorm', 'critique', 'second_brainstorm',
      'toolchain_discovery', 'architecture', 'task_planning', 'coding',
      'reviewing', 'dependency_install', 'testing', 'fixing', 'artifact_delivery',
      'final_integration', 'completed',
    ];
    const currentIdx = order.indexOf(normalizedPhase);
    const checkIdx  = order.indexOf(checkPhase);
    // Only skip if we're resuming past this phase
    if (currentPhase === 'waiting_for_user' || currentPhase === 'stopped') { return false; }
    return currentIdx > checkIdx;
  }

  private _loadTaskPlan(): TaskPlan | null {
    const raw = this.workspace.readFile(this.workspace.taskPlanPath);
    if (!raw) { return null; }
    try { return JSON.parse(raw) as TaskPlan; } catch { return null; }
  }

  private _loadTaskResults(): TaskResults | null {
    const raw = this.workspace.readFile(this.workspace.taskResultsPath);
    if (!raw) { return null; }
    try { return JSON.parse(raw) as TaskResults; } catch { return null; }
  }

  private _collectChangedFiles(): string[] {
    const results = this._loadTaskResults();
    if (!results) { return []; }
    const files = new Set<string>();
    Object.values(results.results).forEach(r => r.files.forEach(f => files.add(f.path)));
    return [...files];
  }

  private _wrapNote(title: string, content: string): string {
    return `# ${title}\n\n_Generated: ${new Date().toISOString()}_\n\n${content}\n`;
  }

  private _resumePhase(state: ProjectState): WorkflowPhase {
    if (state.currentPhase === 'reviewing') { return 'coding'; }
    if (state.currentPhase === 'fixing') {
      return state.currentTaskId ? 'coding' : 'testing';
    }
    return state.currentPhase;
  }

  private _validateTaskFileChanges(task: TaskItem, output: CodeWorkerOutput): string[] {
    if (task.allowedFiles.length === 0) { return []; }

    const errors: string[] = [];
    for (const change of output.files) {
      if (!this._matchesAllowedPath(change.path, task.allowedFiles)) {
        errors.push(`File "${change.path}" is outside the task allowedFiles list.`);
      }
    }
    return errors;
  }

  private _selfHealAllowedFiles(
    task: TaskItem,
    output: CodeWorkerOutput,
    role: 'codeWorker' | 'fixer'
  ): string[] {
    if (!this._selfHealingConfig().enabled || task.allowedFiles.length === 0) { return []; }

    const added: string[] = [];
    for (const change of output.files) {
      if (path.isAbsolute(change.path) || path.win32.isAbsolute(change.path)) {
        continue;
      }
      const normalized = this._normalizeRelativePath(change.path);
      if (
        this._matchesAllowedPath(normalized, task.allowedFiles) ||
        !this._isSelfHealSafeFileChange(task, normalized, change.action)
      ) {
        continue;
      }

      task.allowedFiles.push(normalized);
      added.push(normalized);
    }

    if (added.length > 0) {
      const detail = `Task ${task.id} expanded allowedFiles for ${role}: ${added.join(', ')}`;
      this._emit('log', `${detail}.`, 'warn');
      this.workspace.appendAssumption(
        role,
        `${detail}. Assumption: the task manager underspecified safe project-local output paths, so self-healing allowed these files instead of failing the task.`
      );
    }

    return added;
  }

  private _isSelfHealSafeFileChange(
    task: TaskItem,
    normalizedPath: string,
    action: 'create' | 'modify' | 'append' | 'delete'
  ): boolean {
    if (action === 'delete') { return false; }
    if (!this._isSafeWorkspaceRelativePath(normalizedPath)) { return false; }

    const ext = path.posix.extname(normalizedPath).toLowerCase();
    const safeExtensions = new Set([
      '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.swift', '.ts', '.tsx', '.txt',
      '.xib', '.storyboard', '.plist', '.xcconfig', '.yml', '.yaml',
    ]);
    if (ext && !safeExtensions.has(ext)) { return false; }

    if (action !== 'create' && !this.fileManager.fileExists(normalizedPath)) {
      return true;
    }

    if (this.fileManager.fileExists(normalizedPath)) {
      const existingAllowedDirectory = task.allowedFiles.some(allowed => {
        const normalizedAllowed = this._normalizeRelativePath(allowed);
        return normalizedAllowed.endsWith('/') && normalizedPath.startsWith(normalizedAllowed);
      });
      return existingAllowedDirectory || this._pathMatchesTaskIntent(task, normalizedPath);
    }

    return this._pathMatchesTaskIntent(task, normalizedPath) || this._sharesTopLevelWithAllowedFiles(task, normalizedPath);
  }

  private _isSafeWorkspaceRelativePath(normalizedPath: string): boolean {
    if (!normalizedPath || normalizedPath === '..' || normalizedPath.startsWith('../')) { return false; }
    if (path.isAbsolute(normalizedPath)) { return false; }
    const parts = normalizedPath.split('/').filter(Boolean);
    if (parts.length === 0) { return false; }
    if (parts.some(part => part === '..')) { return false; }

    const blockedTopLevel = new Set([
      '.agent-workspace', '.git', '.vscode', 'node_modules', 'out',
      this._artifactDir(),
    ]);
    if (blockedTopLevel.has(parts[0])) { return false; }
    if (parts.some(part => part === 'node_modules' || part === '.git')) { return false; }
    return true;
  }

  private _pathMatchesTaskIntent(task: TaskItem, normalizedPath: string): boolean {
    const haystack = `${task.title} ${task.description} ${task.acceptanceCriteria.join(' ')}`.toLowerCase();
    const pathWords = normalizedPath
      .replace(/\.[^.]+$/, '')
      .split(/[\/_.-]+/)
      .map(word => word.toLowerCase())
      .filter(word => word.length >= 3);

    return pathWords.some(word => haystack.includes(word));
  }

  private _sharesTopLevelWithAllowedFiles(task: TaskItem, normalizedPath: string): boolean {
    const topLevel = normalizedPath.split('/')[0];
    if (!topLevel) { return false; }
    return task.allowedFiles.some(allowed => this._normalizeRelativePath(allowed).split('/')[0] === topLevel);
  }

  private _matchesAllowedPath(candidatePath: string, allowedFiles: string[]): boolean {
    const candidate = this._normalizeRelativePath(candidatePath);
    if (!candidate || candidate === '..' || candidate.startsWith('../')) { return false; }

    return allowedFiles.some(allowed => {
      const normalizedAllowed = this._normalizeRelativePath(allowed);
      if (!normalizedAllowed || normalizedAllowed === '..' || normalizedAllowed.startsWith('../')) { return false; }
      if (candidate === normalizedAllowed) { return true; }

      const allowsDirectory = normalizedAllowed.endsWith('/') || path.posix.extname(normalizedAllowed) === '';
      const directoryAllowed = normalizedAllowed.endsWith('/') ? normalizedAllowed : `${normalizedAllowed}/`;
      return allowsDirectory && candidate.startsWith(directoryAllowed);
    });
  }

  private _normalizeRelativePath(filePath: string): string {
    return path.posix
      .normalize(filePath.replace(/\\/g, '/'))
      .replace(/^\/+/, '');
  }

  private _recordFailedTask(state: ProjectState, taskId: string): void {
    if (!state.failedTasks.includes(taskId)) {
      state.failedTasks.push(taskId);
    }
  }

  private _clearPendingApprovals(approved: boolean): void {
    for (const resolver of this._pendingPatchResolvers.values()) {
      resolver(approved);
    }
    for (const resolver of this._pendingCommandResolvers.values()) {
      resolver(approved);
    }
    this._pendingPatchResolvers.clear();
    this._pendingCommandResolvers.clear();
  }

  private _handleTopLevelError(err: unknown): void {
    if (err instanceof UserAbortError) {
      this._emit('log', 'Workflow stopped by user.', 'warn');
      this._updateTimeline('stopped', 'skipped');
      return;
    }
    const msg = formatError(err);
    logError(`Workflow failed: ${msg}`);
    this._emit('error', `Workflow failed: ${msg}`);
    const state = this.workspace.readProjectState();
    state.status = 'failed';
    state.currentPhase = 'failed';
    this.workspace.writeProjectState(state);
    this.callbacks.onStateUpdate?.(state);
    this._updateTimeline('failed', 'failed');
  }

  // ------------------------------------------------------------------
  // Timeline & event helpers
  // ------------------------------------------------------------------

  private _buildTimeline(): void {
    this._timeline = [
      { phase: 'briefing',           label: '1. Autonomous Brief',  agentRole: 'briefBuilder',       status: 'pending' },
      { phase: 'brainstorm',         label: '2. Brainstorm',        agentRole: 'brainstorm',         status: 'pending' },
      { phase: 'critique',           label: '3. Critique Debate',   agentRole: 'critic',             status: 'pending' },
      { phase: 'second_brainstorm',  label: '4. Product Debate',    agentRole: 'secondBrainstorm',   status: 'pending' },
      { phase: 'toolchain_discovery',label: '5. Toolchain',         status: 'pending' },
      { phase: 'architecture',       label: '6. Architecture',      agentRole: 'architect',          status: 'pending' },
      { phase: 'task_planning',      label: '7. Task Planning',     agentRole: 'taskManager',        status: 'pending' },
      { phase: 'coding',             label: '8. Coding',            agentRole: 'codeWorker',         status: 'pending' },
      { phase: 'dependency_install', label: '9. Dependencies',      status: 'pending' },
      { phase: 'testing',            label: '10. Testing',          agentRole: 'tester',             status: 'pending' },
      { phase: 'artifact_delivery',  label: '11. Artifacts',        status: 'pending' },
      { phase: 'final_integration',  label: '12. Final Report',     agentRole: 'finalIntegrator',    status: 'pending' },
    ];
  }

  private _updateTimeline(phase: WorkflowPhase, status: TimelineEntry['status']): void {
    const entry = this._timeline.find(e => e.phase === phase);
    if (entry) {
      entry.status = status;
      if (status === 'running') { entry.startedAt = new Date().toISOString(); }
      if (status === 'completed' || status === 'failed') { entry.completedAt = new Date().toISOString(); }
    }
    this._emitTimeline();
  }

  private _emitTimeline(): void {
    this.callbacks.onTimelineUpdate?.(this._timeline);
  }

  private _recordActivity(input: Omit<AgentActivity, 'id' | 'timestamp'>): void {
    const activity: AgentActivity = {
      id: `activity-${Date.now()}-${++this._activityCounter}`,
      timestamp: new Date().toISOString(),
      ...input,
    };
    this._activities = [activity, ...this._activities].slice(0, 100);
    this.callbacks.onActivityUpdate?.(this._activities);
  }

  private _agentRoleForPhase(phase: WorkflowPhase): AgentRole | undefined {
    const roles: Partial<Record<WorkflowPhase, AgentRole>> = {
      briefing: 'briefBuilder',
      brainstorm: 'brainstorm',
      critique: 'critic',
      second_brainstorm: 'secondBrainstorm',
      architecture: 'architect',
      task_planning: 'taskManager',
      coding: 'codeWorker',
      reviewing: 'reviewer',
      testing: 'tester',
      fixing: 'fixer',
      final_integration: 'finalIntegrator',
    };
    return roles[phase];
  }

  private _phaseTitle(phase: WorkflowPhase): string {
    const labels: Partial<Record<WorkflowPhase, string>> = {
      briefing: 'Autonomous brief',
      brainstorm: 'Brainstorm',
      critique: 'Critic debate',
      second_brainstorm: 'Product debate',
      toolchain_discovery: 'Toolchain discovery',
      architecture: 'Architecture',
      task_planning: 'Task planning',
      coding: 'Coding',
      dependency_install: 'Dependency install',
      reviewing: 'Review',
      testing: 'Verification',
      fixing: 'Fixing',
      artifact_delivery: 'Artifact delivery',
      final_integration: 'Final integration',
      waiting_for_user: 'Waiting for input',
      completed: 'Completed',
      failed: 'Failed',
      stopped: 'Stopped',
    };
    return labels[phase] ?? phase;
  }

  private _emit(type: 'phase' | 'log' | 'error' | 'info', a: string, b?: string): void {
    if (type === 'phase') {
      this.callbacks.onPhaseChange?.(a as WorkflowPhase, b ?? '');
    } else if (type === 'log') {
      this.callbacks.onLog?.(a, (b as 'info' | 'warn' | 'error') ?? 'info');
    } else if (type === 'error') {
      this.callbacks.onError?.(a);
    } else {
      this.callbacks.onLog?.(a, 'info');
    }
  }
}
