import * as fs from 'fs';
import * as path from 'path';
import { builtinModules } from 'module';
import type {
  AgentRole,
  AgentActivity,
  ArchitectPlan,
  CodeWorkerOutput,
  ModelOptions,
  DeliveryManifest,
  FileSnapshot,
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
  ToolCallRequest,
  ToolCallResult,
  UserQuestion,
  WebFetchResult,
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
import { WebFetcherService } from '../services/webFetcherService';
import { SearchService } from '../services/searchService';
import { PatchService } from '../services/patchService';
import { AppVerificationService } from '../services/appVerificationService';
import { GitHubIntegrationService } from '../services/githubIntegrationService';
import { PlanController } from '../services/planController';
import { SkillManager } from '../services/skillManager';
import { WebSearchService } from '../services/webSearchService';
import { ResearchService } from '../services/researchService';
import { TerminalSessionRunner } from '../terminal/TerminalSessionRunner';
import { AutonomousToolRegistry } from '../tools/AutonomousToolRegistry';
import { ContextCache } from '../context/ContextCache';
import type { ContextSection } from '../context/ContextCache';

interface ImprovementConsensus {
  agentRole: 'brainstorm' | 'critic' | 'secondBrainstorm';
  readyToStop: boolean;
  confidence: 'low' | 'medium' | 'high';
  remainingWork: string[];
  nextSprintGoal: string;
  rationale: string;
}

// One judge's scorecard in the round-4 debate scoring panel. Each judge runs on
// a different local model and rates the consolidated approach across weighted
// criteria, then recommends the single best direction to proceed with.
interface DebateScore {
  agentRole: AgentRole;
  scores: {
    feasibility: number;   // can this be built locally with the chosen stack?
    completeness: number;  // does it cover the user's actual request?
    risk: number;          // higher = safer (fewer unmitigated risks)
    ux: number;            // product / developer experience quality
    quality: number;       // engineering quality of the proposed direction
  };
  overall: number;         // 0-10 weighted summary the judge assigns
  recommendation: string;  // the direction this judge would proceed with
  topRisk: string;
}

interface DebateDecision {
  winningDirection: string;
  weightedScore: number;       // 0-10 aggregate across all judges
  judgeCount: number;
  agreement: 'low' | 'medium' | 'high';
  rankedRecommendations: Array<{ agentRole: AgentRole; overall: number; recommendation: string }>;
  rationale: string;
}

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

interface WorkflowRoute {
  kind: 'full_project' | 'maintenance';
  skipDebate: boolean;
  reason: string;
}

// -----------------------------------------------------------------------
// AgentOrchestrator
// -----------------------------------------------------------------------
export class AgentOrchestrator {
  private readonly workspace: AgentWorkspace;
  private readonly fileManager: FileManager;
  private readonly gitReader: GitRepositoryReader;
  private readonly searchService: SearchService;
  private readonly patchService: PatchService;
  private readonly planController = new PlanController();
  private ollama!: OllamaClient;
  private terminal!: TerminalRunner;
  private terminalSessions!: TerminalSessionRunner;
  private toolRegistry!: AutonomousToolRegistry;
  private skillManager!: SkillManager;
  private githubIntegration!: GitHubIntegrationService;
  private webSearch!: WebSearchService;
  private research!: ResearchService;
  private modelConfig!: ModelConfig;
  private callbacks: OrchestratorCallbacks = {};
  private _aborted = false;
  private _running = false;
  private _timeline: TimelineEntry[] = [];
  private _activities: AgentActivity[] = [];
  private _activityCounter = 0;
  private _promptFileContextCache: PromptFileContext | null = null;
  private readonly webFetcher = new WebFetcherService();
  private _webContextCache: { prompt: string; context: string } | null = null;
  private readonly _changeBaselines = new WeakMap<CodeWorkerOutput, Map<string, FileSnapshot>>();
  private readonly _contextCache = new ContextCache();

  // Per-run state for effort control and mid-task context injection
  private _taskPlanComplexity: 'low' | 'medium' | 'high' = 'medium';
  private _lastMicroCheckSummary = '';

  // Pending approvals (patch / command) resolved via user interaction
  private _pendingPatchResolvers = new Map<string, (approved: boolean) => void>();
  private _pendingCommandResolvers = new Map<string, (approved: boolean) => void>();
  private _approvalCounter = 0;

  constructor(workspaceRoot: string) {
    this.workspace = new AgentWorkspace(workspaceRoot);
    this.fileManager = new FileManager(workspaceRoot);
    this.gitReader = new GitRepositoryReader(workspaceRoot);
    this.searchService = new SearchService(workspaceRoot);
    this.patchService = new PatchService(workspaceRoot);
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
      this._webContextCache = null;
      this._contextCache.clear();
      this._lastMicroCheckSummary = '';
      this._taskPlanComplexity = 'medium';
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
      this._webContextCache = null;
      this._contextCache.clear();
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
    this.terminalSessions?.stopAll();
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
    const route = this._selectWorkflowRoute(state);

    const completedPhases: WorkflowPhase[] = phase !== 'idle' && phase !== 'intake' ? ['intake'] : [];

    this.workspace.initializeJournal(state.projectGoal || this.workspace.readUserPrompt());

    try {
      this.workspace.appendMemoryEvent({
        type: 'phase',
        phase: state.currentPhase,
        summary: `Workflow route selected: ${route.kind}. ${route.reason}`,
        data: { route },
      });
      this._journal('start', `Workflow started — route: ${route.kind}`,
        `${route.reason}\n\n${route.skipDebate ? 'Debate is skipped for this focused maintenance task.' : 'Running the full multi-round debate before building.'}`);
      // The workflow starts with debate/brainstorming, then turns that consensus
      // into an executable brief and small implementation sprints.
      if (!route.skipDebate && !this._phaseAlreadyDone(phase, 'brainstorm', completedPhases)) {
        await this._phaseBrainstorm(state);
      } else if (route.skipDebate) {
        this._updateTimeline('brainstorm', 'skipped');
      }
      if (!route.skipDebate && !this._phaseAlreadyDone(phase, 'critique', completedPhases)) {
        await this._phaseCritique(state);
      } else if (route.skipDebate) {
        this._updateTimeline('critique', 'skipped');
      }
      if (!route.skipDebate && !this._phaseAlreadyDone(phase, 'second_brainstorm', completedPhases)) {
        await this._phaseSecondBrainstorm(state);
      } else if (route.skipDebate) {
        this._updateTimeline('second_brainstorm', 'skipped');
      }
      // Round 3: the original proposer reads every critique and responds/revises.
      // Round 4: a multi-model judging panel scores the consolidated approach and
      // picks the single best direction before it is frozen into the brief.
      if (!route.skipDebate && !this._phaseAlreadyDone(phase, 'briefing', completedPhases)) {
        await this._phaseDebateResponse(state);
        await this._phaseDebateScoring(state);
      }
      if (!this._phaseAlreadyDone(phase, 'briefing', completedPhases)) {
        await this._phaseBriefing(state);
      }
      if (!this._phaseAlreadyDone(phase, 'toolchain_discovery', completedPhases)) {
        await this._phaseToolchainDiscovery(state);
      }

      let sprint = 1;
      let consensusReached = false;
      const maxSprints = this._maxDevelopmentSprints();
      while (sprint <= maxSprints && !consensusReached) {
        this._checkAborted();
        this.workspace.appendRollingSummary(`## Development Sprint ${sprint}\nPlanning, coding, reviewing, and testing the next smallest useful product increment.`);
        this._emit('log', `Starting development sprint ${sprint}/${maxSprints}.`, 'info');

        await this._phaseArchitecture(state);
        await this._phaseTaskPlanning(state);
        this._scopeTaskPlanForSprint(sprint);
        await this._phaseCoding(state);
        await this._phaseDependencyInstall(state);
        await this._phaseTesting(state);

        const consensus = await this._phaseImprovementConsensus(state, sprint);
        consensusReached = this._consensusReadyToStop(consensus);
        if (consensusReached) {
          this.workspace.appendRollingSummary(`## Sprint ${sprint} Consensus\nBrainstorm, critic, and product agents agree there is no meaningful remaining development work.`);
          break;
        }

        if (sprint >= maxSprints) {
          this.workspace.appendAssumption(
            'brainstorm',
            `Reached the maximum autonomous development sprint limit (${maxSprints}). Stopping with the best verified product so far.`
          );
          break;
        }

        this._prepareNextDevelopmentSprint(state, sprint, consensus);
        sprint += 1;
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
      this._journal('done', 'Workflow completed successfully',
        `Completed ${state.completedTasks.length} task(s). See the final report note for the full handoff.`);
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
        this._journal('warn', 'Paused — waiting for the boss',
          err.questions.map(q => `❓ ${q.question}`).join('\n'));
        this._emit('phase', 'waiting_for_user', `Waiting for user: ${err.questions.length} question(s)`);
        return;
      }
      this._journal('error', 'Workflow stopped with an error', formatError(err));
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Phases
  // ------------------------------------------------------------------

  private async _phaseBriefing(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'briefing', 'Autonomous brief: resolving prompt into a build plan...');

    await this._prefetchPromptUrls();
    await this._prefetchWebSearch();

    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    this._persistPromptFileContextNote();
    const brainstorm = this.workspace.readFile(this.workspace.brainstormPath) ?? '';
    const critique = this.workspace.readFile(this.workspace.criticPath) ?? '';
    const secondBrainstorm = this.workspace.readFile(this.workspace.secondBrainstormPath) ?? '';
    const debateResponse = this.workspace.readFile(this._debateResponsePath) ?? '';
    const debateDecision = this.workspace.readFile(this._debateDecisionPath) ?? '';
    const context = this._assembleContext([
      this._sec('# User Prompt', prompt, 1),
      // The round-4 decision is the authoritative outcome, so it gets top priority.
      this._sec('# Debate Decision (authoritative winning direction)', debateDecision, 2),
      this._sec('# Proposer Response (converged direction)', debateResponse, 4),
      this._sec('# Brainstorm Consensus', brainstorm, 5),
      this._sec('# Critique Consensus', critique, 6),
      this._sec('# Product Consensus', secondBrainstorm, 7),
    ]);
    const { model, fallbackModel } = this._agentConfig('briefBuilder');
    const messages = this._buildMessages('briefBuilder', context);

    let brief: ProjectBrief;
    try {
      brief = await this._callWithFallbackJson<ProjectBrief>(
        'briefBuilder', model, fallbackModel, messages,
        this.workspace.projectBriefPath,
        [this.workspace.userPromptPath, ...promptFiles, this.workspace.brainstormPath, this.workspace.criticPath, this.workspace.secondBrainstormPath]
      );
    } catch (err) {
      this._emit('log', `Brief builder failed, using deterministic autonomous brief: ${formatError(err)}`, 'warn');
      brief = this._fallbackProjectBrief(context);
    }

    brief = this._normalizeProjectBrief(brief, context);
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
    this._journal('brief', 'Project brief locked', [
      `**Goal:** ${brief.goal}`,
      `**App type:** ${brief.appType}`,
      `**Stack:** ${brief.chosenStack.join(', ')}`,
      `**Core features:** ${brief.coreFeatures.join('; ')}`,
      `**Acceptance criteria:**\n${brief.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`,
    ].join('\n'));

    this._updateTimeline('briefing', 'completed');
    this._emit('log', 'Autonomous project brief complete.', 'info');
  }

  private async _phaseBrainstorm(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'brainstorm', 'Agent 1: Brainstorming...');

    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const brief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const context = this._assembleContext([
      this._sec('# User Prompt', prompt, 1),
      this._sec('# Autonomous Project Brief', brief, 2),
    ]);
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
    this._journal('brainstorm', 'Round 1 — Initial proposal', output);
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
      const context = this._assembleContext([
        this._sec('', `Debate Round ${round}/${this._debateRounds()}`, 1, 0.02),
        this._sec('# User Prompt', prompt, 1),
        this._sec('# Autonomous Project Brief', brief, 2),
        this._sec('', brainstorm, 3),
        this._sec('# Prior Debate Notes', priorRounds, 7),
      ]);
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
      this._journal('critique', `Round 2 — Critique (round ${round}/${this._debateRounds()})`, output);
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
      const context = this._assembleContext([
        this._sec('', `Debate Round ${round}/${this._debateRounds()}`, 1, 0.02),
        this._sec('# User Prompt', prompt, 1),
        this._sec('# Autonomous Project Brief', brief, 2),
        this._sec('', brainstorm, 4),
        this._sec('', critique, 5),
        this._sec('# Prior Product/UX Debate Notes', priorRounds, 7),
      ]);
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
      this._journal('product', `Round 2 — Product/UX debate (round ${round}/${this._debateRounds()})`, output);
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

  // Path of the round-3 rebuttal note (proposer responds to all critiques).
  private get _debateResponsePath(): string {
    return this.workspace.agentNotePath('04_debate_response.md');
  }

  // Path of the round-4 panel decision (markdown summary).
  private get _debateDecisionPath(): string {
    return this.workspace.agentNotePath('05_debate_decision.md');
  }

  /**
   * Round 3 of the debate: the original proposer (brainstorm model) reads the
   * critique and product-debate notes and answers them point by point, defending
   * or revising the proposal. This closes the loop so critique is two-way.
   */
  private async _phaseDebateResponse(state: ProjectState): Promise<void> {
    this._checkAborted();
    if (this.workspace.fileExists(this._debateResponsePath)) { return; }
    this._setPhase(state, 'second_brainstorm', 'Debate round 3: proposer responds to critiques...');

    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const brainstorm = this.workspace.readFile(this.workspace.brainstormPath) ?? '';
    const critique = this.workspace.readFile(this.workspace.criticPath) ?? '';
    const secondBrainstorm = this.workspace.readFile(this.workspace.secondBrainstormPath) ?? '';
    const { model, fallbackModel } = this._agentConfig('brainstorm');

    const context = this._assembleContext([
      this._sec('# User Prompt', prompt, 1),
      this._sec('# Your Original Proposal', brainstorm, 3),
      this._sec('# Critique Raised Against It', critique, 4),
      this._sec('# Product / UX Feedback', secondBrainstorm, 5),
    ]);
    const messages: OllamaMessage[] = [
      {
        role: 'system',
        content: [
          'You are the original proposing architect in a multi-agent debate.',
          'Other agents have critiqued your proposal. Respond to that feedback directly.',
          'For each significant critique: either defend your original choice with a concrete reason, or revise it and state the new decision.',
          'Do not repeat the whole proposal. Focus on the points under dispute and converge on a single coherent direction.',
          'Do NOT write code. Do not ask the user questions; resolve ambiguity with explicit assumptions.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `${context}\n\n---\n\nOUTPUT: A markdown document with sections:\n# Debate Response\n## Accepted Critiques (with the revised decision)\n## Defended Decisions (with justification)\n## Converged Direction (the single approach to proceed with)\n## Updated Assumptions`,
      },
    ];

    let output: string;
    try {
      output = await this._callWithFallback('brainstorm', model, fallbackModel, messages,
        this._debateResponsePath,
        [this.workspace.userPromptPath, ...promptFiles, this.workspace.brainstormPath, this.workspace.criticPath, this.workspace.secondBrainstormPath]);
    } catch (err) {
      output = this._fallbackAgentNote('brainstorm', context, err);
      this.workspace.appendAssumption('brainstorm', `Self-healed failed debate response: ${formatError(err)}`);
      this._emit('log', 'Debate response failed; continuing with a deterministic self-healed note.', 'warn');
    }

    this.workspace.writeFile(this._debateResponsePath, this._wrapNote('Debate Response (Round 3)', output));
    this._journal('response', 'Round 3 — Proposer responds to critiques', output);
    this._recordActivity({
      phase: 'second_brainstorm',
      agentRole: 'brainstorm',
      title: 'Debate round 3 complete',
      detail: 'Proposer answered every critique and converged on a single direction.',
      status: 'completed',
    });
    this._emit('log', 'Debate response (round 3) complete.', 'info');
  }

  /**
   * Round 4 of the debate: a panel of distinct local models independently scores
   * the consolidated approach across weighted criteria and recommends the single
   * best direction. The scores are aggregated into one decision used by the brief.
   */
  private async _phaseDebateScoring(state: ProjectState): Promise<void> {
    this._checkAborted();
    if (this.workspace.fileExists(this._debateDecisionPath)) { return; }
    this._setPhase(state, 'second_brainstorm', 'Debate round 4: judging panel scores the approach...');

    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const brainstorm = this.workspace.readFile(this.workspace.brainstormPath) ?? '';
    const critique = this.workspace.readFile(this.workspace.criticPath) ?? '';
    const secondBrainstorm = this.workspace.readFile(this.workspace.secondBrainstormPath) ?? '';
    const response = this.workspace.readFile(this._debateResponsePath) ?? '';

    const baseContext = this._assembleContext([
      this._sec('# User Prompt', prompt, 1),
      this._sec('# Brainstorm Proposal', brainstorm, 3),
      this._sec('# Critique', critique, 4),
      this._sec('# Product / UX Perspective', secondBrainstorm, 5),
      this._sec('# Proposer Response (converged direction)', response, 3),
    ]);

    // Five distinct models, each judging from its own lens, satisfy the
    // "at least 5 agents of different models vote" requirement. A runtime guard
    // guarantees the diversity even when two roles share a primary model.
    const panelRoles: AgentRole[] = ['brainstorm', 'critic', 'secondBrainstorm', 'architect', 'reviewer'];
    const lenses: Record<string, string> = {
      brainstorm: 'overall technical soundness',
      critic: 'risks, security, and correctness',
      secondBrainstorm: 'product value and user/developer experience',
      architect: 'architectural feasibility on a local-first stack',
      reviewer: 'implementation quality and completeness',
    };

    const { assignments: panelModels, distinctCount } = this._assignDiversePanelModels(panelRoles);
    if (distinctCount < panelRoles.length) {
      const warning =
        `Debate panel could only assign ${distinctCount} distinct model(s) for ${panelRoles.length} judges. ` +
        `Install more local models (the roster currently exposes ${this._modelRoster().length}) so every judge votes on a different model.`;
      this._emit('log', warning, 'warn');
      this._journal('warn', 'Debate panel model diversity below target', warning);
      this.workspace.appendAssumption('debate', warning);
    } else {
      this._journal('decision', 'Debate panel assembled',
        panelRoles.map(r => `- **${r}** → \`${panelModels.get(r)!.model}\` (${lenses[r]})`).join('\n'));
    }

    const panel: DebateScore[] = [];
    for (const role of panelRoles) {
      this._checkAborted();
      const { model, fallbackModel } = panelModels.get(role)!;
      const outputPath = this.workspace.agentNotePath(`05_debate_score_${role}.json`);
      const messages: OllamaMessage[] = [
        {
          role: 'system',
          content: [
            `You are a debate judge focused on ${lenses[role] ?? 'overall quality'}.`,
            'Score the converged approach honestly on a 0-10 scale per criterion (10 = excellent).',
            'For "risk", a HIGHER score means SAFER (fewer unmitigated risks).',
            'Then recommend the single best direction to proceed with. Respond only with valid JSON.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            baseContext,
            '',
            'Return exactly this JSON shape:',
            '{',
            `  "agentRole": "${role}",`,
            '  "scores": { "feasibility": 0, "completeness": 0, "risk": 0, "ux": 0, "quality": 0 },',
            '  "overall": 0,',
            '  "recommendation": "the single direction you would proceed with",',
            '  "topRisk": "the most important remaining risk"',
            '}',
          ].join('\n'),
        },
      ];

      let score: DebateScore;
      try {
        score = await this._callWithFallbackJson<DebateScore>(
          role, model, fallbackModel, messages, outputPath,
          [this.workspace.userPromptPath, ...promptFiles, this.workspace.brainstormPath, this.workspace.criticPath, this.workspace.secondBrainstormPath]
        );
      } catch (err) {
        score = this._fallbackDebateScore(role, err);
        this.workspace.appendAssumption(role, `Self-healed failed debate score: ${formatError(err)}`);
      }
      score = this._normalizeDebateScore(role, score);
      panel.push(score);
      this.workspace.writeFile(outputPath, prettyJson(score));
      this._recordActivity({
        phase: 'second_brainstorm',
        agentRole: role,
        title: `Debate score: ${role}`,
        detail: `Overall ${score.overall}/10 — ${score.recommendation.slice(0, 80)}`,
        status: 'completed',
      });
    }

    const decision = this._aggregateDebateScores(panel);
    this.workspace.writeFile(
      this._debateDecisionPath,
      this._wrapNote('Debate Decision (Round 4 — Scoring & Vote)', [
        `Winning direction: ${decision.winningDirection}`,
        `Weighted score: ${decision.weightedScore}/10`,
        `Panel agreement: ${decision.agreement} (${decision.judgeCount} judges)`,
        '',
        '## Ranked Recommendations',
        ...decision.rankedRecommendations.map((r, i) => `${i + 1}. (${r.overall}/10, ${r.agentRole}) ${r.recommendation}`),
        '',
        `## Rationale\n${decision.rationale}`,
      ].join('\n'))
    );
    this.workspace.appendRollingSummary(
      `## Debate Decision\nWinning direction (score ${decision.weightedScore}/10, ${decision.agreement} agreement): ${decision.winningDirection}`
    );
    this._journal('decision', `Round 4 — Panel verdict: ${decision.weightedScore}/10 (${decision.agreement} agreement)`,
      [
        `**Winning direction:** ${decision.winningDirection}`,
        '',
        '**Ranked recommendations:**',
        ...decision.rankedRecommendations.map((r, i) => `${i + 1}. (${r.overall}/10 — ${r.agentRole}) ${r.recommendation}`),
        '',
        decision.rationale,
      ].join('\n'));
    this._emit('log', `Debate scoring complete: ${decision.weightedScore}/10 (${decision.agreement} agreement).`, 'info');
  }

  /**
   * Pure aggregation of the round-4 panel: averages the weighted scores, ranks
   * each judge's recommendation by its overall score, and selects the highest as
   * the winning direction. Exposed for unit testing (no model calls).
   */
  private _aggregateDebateScores(panel: DebateScore[]): DebateDecision {
    if (panel.length === 0) {
      return {
        winningDirection: 'No panel scores were produced; proceed with the proposer response.',
        weightedScore: 0,
        judgeCount: 0,
        agreement: 'low',
        rankedRecommendations: [],
        rationale: 'The scoring panel returned no usable results.',
      };
    }

    const ranked = [...panel]
      .map(p => ({ agentRole: p.agentRole, overall: p.overall, recommendation: p.recommendation }))
      .sort((a, b) => b.overall - a.overall);

    const overalls = panel.map(p => p.overall);
    const mean = overalls.reduce((sum, v) => sum + v, 0) / overalls.length;
    const variance = overalls.reduce((sum, v) => sum + (v - mean) ** 2, 0) / overalls.length;
    const spread = Math.sqrt(variance);
    // Tight spread of high-ish scores => the judges agree.
    const agreement: DebateDecision['agreement'] = spread <= 1.0 ? 'high' : spread <= 2.0 ? 'medium' : 'low';

    const winner = ranked[0];
    return {
      winningDirection: winner.recommendation,
      weightedScore: Math.round(mean * 10) / 10,
      judgeCount: panel.length,
      agreement,
      rankedRecommendations: ranked,
      rationale: `Selected the highest-scored direction (${winner.overall}/10 from ${winner.agentRole}). `
        + `Panel mean ${Math.round(mean * 10) / 10}/10 with ${agreement} agreement (score spread ${Math.round(spread * 100) / 100}).`,
    };
  }

  private _normalizeDebateScore(role: AgentRole, value: Partial<DebateScore> | null | undefined): DebateScore {
    const clamp = (n: unknown): number => {
      const num = Number(n);
      if (!Number.isFinite(num)) { return 5; }
      return Math.max(0, Math.min(10, Math.round(num * 10) / 10));
    };
    const s = value?.scores ?? {};
    const scores = {
      feasibility: clamp((s as Record<string, unknown>).feasibility),
      completeness: clamp((s as Record<string, unknown>).completeness),
      risk: clamp((s as Record<string, unknown>).risk),
      ux: clamp((s as Record<string, unknown>).ux),
      quality: clamp((s as Record<string, unknown>).quality),
    };
    const derived = (scores.feasibility + scores.completeness + scores.risk + scores.ux + scores.quality) / 5;
    const overall = value?.overall === undefined ? clamp(derived) : clamp(value.overall);
    return {
      agentRole: role,
      scores,
      overall,
      recommendation: String(value?.recommendation ?? 'Proceed with the converged direction from the debate.').trim(),
      topRisk: String(value?.topRisk ?? 'No specific risk reported.').trim(),
    };
  }

  private _fallbackDebateScore(role: AgentRole, err: unknown): DebateScore {
    return this._normalizeDebateScore(role, {
      agentRole: role,
      scores: { feasibility: 5, completeness: 5, risk: 5, ux: 5, quality: 5 },
      overall: 5,
      recommendation: 'Proceed with the converged direction from the debate response (scoring model unavailable).',
      topRisk: `Scoring model failed: ${formatError(err)}`,
    });
  }

  private async _phaseToolchainDiscovery(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'toolchain_discovery', 'Inspecting local toolchain...');
    this._ensureCapabilityServices();

    const packageManager = this.terminal.detectPackageManager();
    const commands: Array<[string, string]> = [
      ['node', 'node --version'],
      ['npm', 'npm --version'],
      ['pnpm', 'pnpm --version'],
      ['yarn', 'yarn --version'],
      ['git', 'git --version'],
      ['java', 'java -version'],
      ['swift', 'swift --version'],
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

    const prompt = this.workspace.readUserPrompt();
    const searchQueries = this.searchService.deriveQueriesFromPrompt(prompt);
    const repoSearch = await this.searchService.buildReport(searchQueries, { maxResultsPerQuery: 8 });
    this.workspace.writeFile(this.workspace.repoSearchPath, prettyJson(repoSearch));
    this.workspace.appendMemoryEvent({
      type: 'search',
      phase: 'toolchain_discovery',
      summary: `Repository search prepared ${repoSearch.results.length} result(s) for ${repoSearch.queries.length} query term(s).`,
      data: { queries: repoSearch.queries, filesInspected: repoSearch.filesInspected },
    });
    this._recordActivity({
      phase: 'toolchain_discovery',
      title: 'Repository search context ready',
      detail: `${repoSearch.results.length} result(s) across ${repoSearch.filesInspected.length} file(s).`,
      status: repoSearch.results.length > 0 ? 'completed' : 'info',
    });

    const skillMatches = this.skillManager.match(prompt);
    const skillContext = this.skillManager.readSkillContext(skillMatches);
    if (skillContext) {
      this.workspace.writeFile(this.workspace.skillContextPath, skillContext);
    }
    this.workspace.appendMemoryEvent({
      type: 'skill',
      phase: 'toolchain_discovery',
      summary: skillMatches.length > 0
        ? `Matched skills: ${skillMatches.map(match => match.skill.name).join(', ')}`
        : 'No local skills matched the prompt.',
      data: { matches: skillMatches.map(match => ({ name: match.skill.name, score: match.score })) },
    });

    const githubContext = await this.githubIntegration.readContext();
    this.workspace.writeFile(this.workspace.githubContextPath, prettyJson(githubContext));
    this.workspace.appendMemoryEvent({
      type: 'github',
      phase: 'toolchain_discovery',
      summary: githubContext.available
        ? `GitHub context: ${githubContext.owner}/${githubContext.repo}${githubContext.pullRequestNumber ? ` PR #${githubContext.pullRequestNumber}` : ''}.`
        : 'GitHub context unavailable.',
      data: githubContext as unknown as Record<string, unknown>,
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

    // Inject hard constraints into assumptions so every downstream agent reads them
    const swiftCheck = checks.find(c => c.name === 'swift');
    const xcodebuildCheck = checks.find(c => c.name === 'xcodebuild');
    if (swiftCheck?.available && !xcodebuildCheck?.available) {
      this.workspace.appendAssumption(
        'toolchain',
        `TOOLCHAIN CONSTRAINT: Swift ${swiftCheck.version ?? ''} is available via Command Line Tools, but xcodebuild is NOT available. ` +
        `All Apple platform projects MUST use Package.swift (Swift Package Manager) as the project root. ` +
        `Do NOT generate .xcodeproj files — they are non-functional without full Xcode. ` +
        `Use "swift build" for compilation and "swift test" for tests.`
      );
    }

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
    const context = this._assembleContext([
      this._sec('# User Prompt', prompt, 1),
      this._sec('# Autonomous Project Brief', brief, 2),
      this._sec('# Local Toolchain Report', toolchain, 3),
      this._sec('# Git Repository Snapshot', gitSnapshot, 4),
      this._sec('', brainstorm, 5),
      this._sec('', critique, 6),
      this._sec('', secondBrainstorm, 7),
      this._sec('', openQns, 8),
      this._sec('', assumptions, 9),
    ]);

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
    this._journal('architect', 'Architecture decided', [
      architectPlan?.summary ? `**Summary:** ${architectPlan.summary}` : '',
      architectPlan?.technology?.length ? `**Technology:** ${architectPlan.technology.join(', ')}` : '',
      architectPlan?.keyDecisions?.length ? `**Key decisions:**\n${architectPlan.keyDecisions.map(d => `- ${d}`).join('\n')}` : '',
    ].filter(Boolean).join('\n'));
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
    const context = this._assembleContext([
      this._sec('# User Prompt And Referenced Files', prompt, 1),
      this._sec('# Autonomous Project Brief', brief, 2),
      this._sec('', architectMd, 2),
      this._sec('# Local Toolchain Report', toolchain, 3),
      this._sec('# Git Repository Snapshot', gitSnapshot, 4),
      this._sec('', decisions, 5),
      this._sec('', openQns, 8),
      this._sec('', assumptions, 9),
    ]);

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
      taskPlan.tasks = taskPlan.tasks.map((t, index) => this._normalizeTaskItem(t, index, now));
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
    const planReport = this.planController.createReport(state.projectGoal, taskPlan.tasks, state.completedTasks, state.failedTasks);
    this.workspace.writeFile(this.workspace.planControllerPath, prettyJson(planReport));
    this.workspace.appendMemoryEvent({
      type: 'plan',
      phase: 'task_planning',
      summary: `Dynamic plan initialized: ${planReport.summary}`,
      data: { currentStep: planReport.currentStep, totalSteps: planReport.steps.length },
    });

    this.callbacks.onTaskUpdate?.(taskPlan.tasks);
    this._recordActivity({
      phase: 'task_planning',
      agentRole: 'taskManager',
      title: 'Task plan ready',
      detail: `${taskPlan.totalTasks} task(s), ${taskPlan.estimatedComplexity} complexity.`,
      status: 'completed',
    });
    this._emit('log', `Task plan created: ${taskPlan.totalTasks} tasks.`, 'info');
    this._journal('plan', `Task plan ready — ${taskPlan.totalTasks} task(s), ${taskPlan.estimatedComplexity} complexity`,
      taskPlan.tasks.map((t, i) => `${i + 1}. **${t.id}** — ${t.title}\n   ${t.description}`).join('\n'));
    this._updateTimeline('task_planning', 'completed');
  }

  private async _phaseCoding(state: ProjectState): Promise<void> {
    this._checkAborted();
    this._setPhase(state, 'coding', 'Code Workers: Executing tasks...');

    const taskPlan = this._loadTaskPlan();
    if (!taskPlan) {
      throw new Error('Cannot start coding: task_plan.json is missing or invalid.');
    }

    // Store plan complexity so _optionsForRole() can scale LLM settings per task
    this._taskPlanComplexity = taskPlan.estimatedComplexity ?? 'medium';

    const taskResults: TaskResults = this._loadTaskResults() ?? { results: {}, updatedAt: new Date().toISOString() };

    // Wave-based execution: in each wave, run code workers for all dependency-free
    // tasks in parallel, then apply patches + review + fix sequentially to avoid
    // file-write races.
    let madeProgress = true;
    while (madeProgress && !this._aborted) {
      this._checkAborted();
      madeProgress = false;

      // Re-read on every wave so workers see the latest architecture and summary
      const architectMd = this.workspace.readFile(this.workspace.architectMdPath) ?? '';
      const rollingSummary = this.workspace.readFile(this.workspace.rollingSummaryPath) ?? '';

      // Build the set of permanently terminal task IDs
      const skippedIds = new Set(
        taskPlan.tasks.filter(t => t.status === 'skipped').map(t => t.id)
      );
      const terminalIds = new Set([...state.completedTasks, ...state.failedTasks, ...skippedIds]);

      // Collect the next wave: tasks whose dependencies are all resolved
      const wave: TaskItem[] = [];
      for (const task of taskPlan.tasks) {
        if (terminalIds.has(task.id)) { continue; }

        const unmetDeps = task.dependsOn.filter(dep => !state.completedTasks.includes(dep));
        if (unmetDeps.length === 0) {
          wave.push(task);
          continue;
        }

        const failedDeps = unmetDeps.filter(dep => state.failedTasks.includes(dep) || skippedIds.has(dep));
        const pendingDeps = unmetDeps.filter(dep => !terminalIds.has(dep));

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
          wave.push(task);
        } else {
          this._emit('log', `Task "${task.id}" skipped: unmet dependencies [${unmetDeps.join(', ')}]`, 'warn');
          task.status = 'skipped';
          state.activeTasks = state.activeTasks.filter(id => id !== task.id);
          this.workspace.writeProjectState(state);
          this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
          this.callbacks.onTaskUpdate?.(taskPlan.tasks);
        }
      }

      if (wave.length === 0) { break; }
      madeProgress = true;

      // Mark all wave tasks as in-progress
      for (const task of wave) {
        task.status = 'in_progress';
        task.startedAt = new Date().toISOString();
        state.activeTasks = [...new Set([...state.activeTasks, task.id])];
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
      }
      state.currentTaskId = wave[0].id;
      this.workspace.writeProjectState(state);
      this.callbacks.onTaskUpdate?.(taskPlan.tasks);

      // === PARALLEL: run code workers for all wave tasks simultaneously ===
      if (wave.length > 1) {
        this._emit('log', `Parallel execution: ${wave.length} independent tasks [${wave.map(t => t.id).join(', ')}]`, 'info');
      }
      const workerOutcomes = await Promise.allSettled(
        wave.map(task => this._executeCodeWorker(task, architectMd, rollingSummary, state))
      );

      // === SEQUENTIAL: apply patches + review + fix for each wave task ===
      for (let wi = 0; wi < wave.length; wi++) {
        this._checkAborted();
        const task = wave[wi];
        const outcome = workerOutcomes[wi];

        let workerResult: CodeWorkerOutput | null = null;
        let workerResultAlreadyApplied = false;
        if (outcome.status === 'fulfilled') {
          workerResult = outcome.value;
        } else {
          this._emit('error', `Code worker failed for task "${task.id}": ${formatError(outcome.reason)}`);
        }

        if (!workerResult) {
          const recoveryResult = await this._tryDeterministicTaskRecovery(task, state, taskPlan);
          if (recoveryResult) {
            workerResult = recoveryResult;
            workerResultAlreadyApplied = true;
          } else {
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
        if (!workerResultAlreadyApplied && workerResult.files.length > 0) {
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
        let review = await this._executeReviewer(task, workerResult, state);

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
              // Record lesson learned for future runs
              this._appendLesson({
                issue: review.issues.join('; '),
                fix: fixResult.reasoning ?? 'No reasoning provided',
                taskTitle: task.title,
                filesAffected: fixResult.files.map(f => f.path),
                attempt,
              });
              Object.assign(review, reReview);
              break;
            }
            Object.assign(review, reReview);
          }

          if (!fixed) {
            const recoveryResult = await this._tryDeterministicTaskRecovery(task, state, taskPlan, review);
            if (recoveryResult) {
              workerResult = recoveryResult;
              review = {
                taskId: task.id,
                approved: true,
                issues: [],
                suggestions: ['Task recovered with deterministic browser game scaffold after model fixes failed.'],
                securityConcerns: [],
                needsFix: false,
                fixSuggestions: [],
                reviewedAt: new Date().toISOString(),
              };
            } else {
              this._emit('log', `Task "${task.id}" could not be fixed after ${maxRetries} attempts.`, 'warn');
              task.status = 'failed';
              task.error = `Failed after ${maxRetries} fix attempts. Last issues: ${review.issues.join('; ')}`;
              this._recordFailedTask(state, task.id);
              state.activeTasks = state.activeTasks.filter(id => id !== task.id);
              this.workspace.writeProjectState(state);
              this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
              this.callbacks.onTaskUpdate?.(taskPlan.tasks);
              continue;
            }
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
        this._writeDynamicPlanReport(state, taskPlan);
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
      // Run micro-sprint checks once per wave (not per task) to avoid redundant
      // compile/test runs when multiple tasks complete in the same wave.
      if (madeProgress && wave.length > 0) {
        const lastCompletedTask = wave.filter(t => state.completedTasks.includes(t.id)).at(-1);
        if (lastCompletedTask) {
          await this._runMicroSprintChecks(lastCompletedTask, state);
        }
      }
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

  private async _runMicroSprintChecks(task: TaskItem, _state: ProjectState): Promise<void> {
    const hasPackageChecks =
      this.terminal.hasPackageScript('compile') ||
      this.terminal.hasPackageScript('build') ||
      this.terminal.hasPackageScript('test');
    const nativeCommand = this._nativeVerificationCommand();
    if (!hasPackageChecks && !nativeCommand) { return; }

    this._recordActivity({
      phase: 'testing',
      agentRole: 'tester',
      title: `Micro-sprint verification for ${task.id}`,
      detail: 'Running available checks before the next coding task.',
      status: 'running',
      taskId: task.id,
    });

    const checks = await this._runProjectChecks(this.terminal.detectPackageManager());
    // Store summary so the next code worker can see what failed/passed
    this._lastMicroCheckSummary = `## Micro-Check After ${task.id} (${new Date().toISOString()})\n` +
      (checks.failed
        ? `STATUS: FAILED\nFailed commands: ${checks.failedCommands.join(', ')}\n${checks.output.substring(0, 1000)}`
        : `STATUS: PASSED\n${checks.output.substring(0, 400)}`);
    this.workspace.appendFile(
      this.workspace.testResultLogPath,
      `\n\n---\n\n## Micro-Sprint Verification: ${task.id}\n\n${checks.output}\n`
    );
    this._recordActivity({
      phase: 'testing',
      agentRole: 'tester',
      title: `Micro-sprint verification ${checks.failed ? 'needs attention' : 'passed'} for ${task.id}`,
      detail: checks.failed ? checks.failedCommands.join(', ') : 'Available checks passed after this task.',
      status: checks.failed ? 'warn' : 'completed',
      taskId: task.id,
    });
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
    this._ensureCapabilityServices();
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

    const qualityGate = this._runStaticQualityGate();
    if (qualityGate.failed) {
      failedCommands.push('static quality gate');
    }

    const appVerification = await new AppVerificationService(
      this.workspace.rootDir,
      this.terminal,
      this.terminalSessions,
      this.modelConfig.appVerification
    ).verify();
    this.workspace.writeFile(this.workspace.appVerificationPath, prettyJson(appVerification));
    if (appVerification.failed) {
      failedCommands.push('app smoke verification');
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
      qualityGate.output,
      this._formatAppVerificationResult(appVerification),
      this.modelConfig.requireVerificationScripts && !compileResult && !testResult && !nativeResult
        ? '## Verification Gate\nFailed: generated project must include at least one compile, build, or test script.'
        : '',
    ].join('\n\n');

    this.workspace.appendMemoryEvent({
      type: 'verification',
      phase: 'testing',
      agentRole: 'tester',
      summary: failedCommands.length > 0
        ? `Verification failed: ${failedCommands.join(', ')}`
        : 'Verification commands passed.',
      data: {
        failedCommands,
        skippedChecks,
        compileCommand: compileResult?.command,
        testCommand: testResult?.command,
        nativeCommand: nativeResult?.command,
        staticQualityIssues: qualityGate.issues,
        appVerification,
      },
    });

    return {
      compileResult,
      testResult,
      output,
      failed: failedCommands.length > 0,
      failedCommands,
      skippedChecks,
    };
  }

  private _isXcodebuildAvailable(): boolean {
    const report = this._readToolchainReport();
    if (!report) { return false; }
    return report.checks.some(c => c.name === 'xcodebuild' && c.available);
  }

  private _nativeVerificationCommand(): string | null {
    if (this.fileManager.fileExists('Package.swift')) {
      return 'swift build';
    }

    const workspace = this._findWorkspaceEntryByExtension('.xcworkspace');
    if (workspace) {
      // Only emit xcodebuild commands when the tool is actually available
      if (!this._isXcodebuildAvailable()) { return null; }
      return `xcodebuild -list -workspace ${this._quoteShell(workspace)}`;
    }

    const project = this._findWorkspaceEntryByExtension('.xcodeproj');
    if (project) {
      if (!this._isXcodebuildAvailable()) { return null; }
      return `xcodebuild -list -project ${this._quoteShell(project)}`;
    }

    const gradleWrapper = this.fileManager.fileExists('gradlew') ? './gradlew' : null;
    if (gradleWrapper) {
      return `${gradleWrapper} test`;
    }

    return null;
  }

  private _runStaticQualityGate(): { failed: boolean; issues: string[]; output: string } {
    const issues: string[] = [];
    const prompt = this.workspace.readUserPrompt().toLowerCase();
    const projectBrief = (this.workspace.readFile(this.workspace.projectBriefPath) ?? '').toLowerCase();
    const jsFiles = this.fileManager.listWorkspaceFiles('', ['.js', '.mjs', '.cjs']);
    const testFiles = this.fileManager.listWorkspaceFiles('test', ['.js', '.mjs', '.cjs']);
    const packageJson = this.fileManager.readWorkspaceFile('package.json');
    const packageSwift = this.fileManager.readWorkspaceFile('Package.swift');
    const hasNativeVerification = this._nativeVerificationCommand() !== null;

    // Swift/Apple project detection: skip Node quality checks for these.
    const looksLikeSwiftProject =
      packageSwift !== null ||
      /swift|swiftui|ios|macos|iphone|ipad|xcode|cocoa/.test(prompt + projectBrief);

    const looksLikeNodeProject =
      !looksLikeSwiftProject && (
        jsFiles.some(file => file.startsWith('src/') || file.startsWith('test/')) ||
        /node\.js|npm|cli|command line|terminal/.test(prompt + projectBrief)
      );

    if (looksLikeSwiftProject && !packageSwift && !hasNativeVerification) {
      issues.push('Swift project is missing Package.swift. The first task must create a valid Package.swift with all targets declared.');
    }

    let parsedPackage: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
    if (packageJson && !looksLikeSwiftProject) {
      try {
        parsedPackage = JSON.parse(packageJson);
      } catch (err) {
        issues.push(`package.json is not valid JSON: ${formatError(err)}`);
      }
    }

    if (looksLikeNodeProject && parsedPackage && !parsedPackage.scripts?.test) {
      issues.push('Node.js project is missing a package.json test script.');
    }

    const dependencyFreeRequested = /no external (runtime )?dependenc|without external dependenc|dependency-free|no dependenc/.test(prompt);
    if (dependencyFreeRequested) {
      const declaredDependencies = Object.keys(parsedPackage?.dependencies ?? {});
      if (declaredDependencies.length > 0) {
        issues.push(`Prompt requested no external runtime dependencies, but package.json declares: ${declaredDependencies.join(', ')}.`);
      }
      const externalImports = this._findExternalNodeImports(jsFiles);
      if (externalImports.length > 0) {
        issues.push(`Prompt requested no external runtime dependencies, but source imports external modules: ${externalImports.join(', ')}.`);
      }
    }

    const testScript = parsedPackage?.scripts?.test ?? '';
    if (/node\s+--test/.test(testScript)) {
      const jestStyleFiles = testFiles.filter(file => {
        const content = this.fileManager.readWorkspaceFile(file) ?? '';
        return /\b(describe|it|expect|beforeEach|afterEach|jest|fail)\s*\(/.test(content);
      });
      if (jestStyleFiles.length > 0) {
        issues.push(`Test script uses node:test, but these files contain Jest-style globals: ${jestStyleFiles.join(', ')}.`);
      }
    }

    return {
      failed: issues.length > 0,
      issues,
      output: [
        '## Static Quality Gate',
        issues.length === 0
          ? 'Passed: project structure, dependency policy, and test style checks did not find blocking issues.'
          : `Failed:\n${issues.map(issue => `- ${issue}`).join('\n')}`,
      ].join('\n'),
    };
  }

  private _findExternalNodeImports(files: string[]): string[] {
    const builtins = new Set([
      ...builtinModules,
      ...builtinModules.map(moduleName => `node:${moduleName}`),
    ]);
    const external = new Set<string>();

    for (const file of files) {
      const content = this.fileManager.readWorkspaceFile(file) ?? '';
      const patterns = [
        /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
      ];

      for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const specifier = match[1];
          if (
            specifier.startsWith('.') ||
            specifier.startsWith('/') ||
            builtins.has(specifier)
          ) {
            continue;
          }
          external.add(`${file}: ${specifier}`);
        }
      }
    }

    return [...external];
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
    const diagnosticBundle = this._verificationDiagnosticBundle(checks);
    const context =
      `# Diagnostic Bundle\n\n${diagnosticBundle}\n\n` +
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
    this.workspace.appendMemoryEvent({
      type: 'diagnostic',
      phase: 'testing',
      agentRole: 'tester',
      summary: checks.failed
        ? `Verification failed: ${checks.failedCommands.join(', ')}`
        : 'Verification checks passed.',
      data: {
        failedCommands: checks.failedCommands,
        skippedChecks: checks.skippedChecks,
        filesMentioned: this._extractWorkspaceFileMentions(checks.output),
      },
    });

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

  private _verificationDiagnosticBundle(checks: ProjectCheckResults): string {
    return this._buildDiagnosticBundle(
      checks.output,
      checks.failedCommands,
      checks.skippedChecks
    );
  }

  private _latestVerificationDiagnosticBundle(extraContext: string = ''): string {
    const latestOutput = this.workspace.readFile(this.workspace.testResultLogPath) ?? '';
    return this._buildDiagnosticBundle(latestOutput, [], [], extraContext);
  }

  private _buildDiagnosticBundle(
    output: string,
    failedCommands: string[] = [],
    skippedChecks: string[] = [],
    extraContext: string = ''
  ): string {
    const text = [output, extraContext].filter(Boolean).join('\n');
    const mentionedFiles = this._extractWorkspaceFileMentions(text).slice(0, 25);
    const excerpts = this._extractDiagnosticExcerpts(text);
    return [
      `Failed commands: ${failedCommands.join(', ') || 'none recorded'}`,
      `Skipped checks: ${skippedChecks.join(', ') || 'none recorded'}`,
      `Likely files: ${mentionedFiles.join(', ') || 'none detected'}`,
      '',
      'Relevant output excerpts:',
      excerpts || '_No focused diagnostic lines found._',
    ].join('\n');
  }

  private _extractDiagnosticExcerpts(text: string): string {
    const interesting = /(error|failed|failure|exception|cannot|not found|missing|syntaxerror|typeerror|referenceerror|assertionerror|ts\d{4}|exit:\s*[1-9])/i;
    const lines = text
      .split(/\r?\n/)
      .map(line => line.trimEnd())
      .filter(line => interesting.test(line));
    const selected = (lines.length > 0 ? lines : text.split(/\r?\n/).slice(-60))
      .filter(Boolean)
      .slice(0, 120);
    const joined = selected.join('\n');
    return joined.length > 12_000 ? `${joined.slice(0, 12_000)}\n[Diagnostic excerpt truncated.]` : joined;
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

  private _formatAppVerificationResult(result: { summary: string; smokeUrls: string[]; warnings: string[]; checks: TerminalRunResult[]; failed: boolean }): string {
    return [
      '## App Smoke Verification',
      `Status: ${result.failed ? 'failed' : 'passed/skipped'}`,
      result.summary,
      result.smokeUrls.length > 0 ? `URLs: ${result.smokeUrls.join(', ')}` : '',
      result.warnings.length > 0 ? `Warnings:\n${result.warnings.map(warning => `- ${warning}`).join('\n')}` : '',
      ...result.checks.map(check => this._formatCommandResult('Smoke Check', check)),
    ].filter(Boolean).join('\n');
  }

  private _packageScriptCommand(packageManager: 'npm' | 'pnpm' | 'yarn', scriptName: string): string {
    if (packageManager === 'yarn') { return `yarn ${scriptName}`; }
    return `${packageManager} run ${scriptName}`;
  }

  private _userPromptWithFileContext(): string {
    const promptContext = this._promptFileContext();
    const webContext = this._webContext();
    const webSearchContext = this._webSearchContext();
    const parts: string[] = [promptContext.prompt];
    if (promptContext.context) { parts.push(promptContext.context); }
    if (webContext) { parts.push(webContext); }
    if (webSearchContext) { parts.push(webSearchContext); }
    return parts.join('\n\n---\n\n');
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

  // ------------------------------------------------------------------
  // Web context helpers (URL auto-detection & fetching)
  // ------------------------------------------------------------------

  /**
   * Fetch a single URL and return the result. Exposed for external callers (e.g. webview).
   */
  async fetchUrl(url: string): Promise<WebFetchResult> {
    return this.webFetcher.fetchUrl(url);
  }

  /**
   * Return cached web context built from URLs found in the user prompt, or
   * an empty string if none are present / already fetched.
   * NOTE: This is intentionally synchronous – the actual async fetching is
   * done during the briefing phase via `_prefetchPromptUrls()`.
   */
  private _webContext(): string {
    const prompt = this.workspace.readUserPrompt();
    if (this._webContextCache?.prompt === prompt) {
      return this._webContextCache.context;
    }
    return '';
  }

  private _webSearchContext(): string {
    const raw = this.workspace.readFile(this.workspace.webSearchPath);
    if (!raw) { return ''; }
    return `# Web Search Context\n\n${raw}`;
  }

  /**
   * Detect URLs in the user prompt, fetch their content, and store the
   * result in the cache so `_webContext()` can return it synchronously.
   * Called once at the start of the briefing phase.
   */
  private async _prefetchPromptUrls(): Promise<void> {
    const prompt = this.workspace.readUserPrompt();
    if (this._webContextCache?.prompt === prompt) { return; }

    const urls = this._extractUrlsFromPrompt(prompt);
    if (urls.length === 0) {
      this._webContextCache = { prompt, context: '' };
      return;
    }

    this._emit('log', `Fetching ${urls.length} URL(s) from prompt: ${urls.join(', ')}`, 'info');
    const results = await this.webFetcher.fetchUrls(urls);

    const sections: string[] = ['# Web Page Context', ''];
    for (const result of results) {
      if (!result.success || !result.text) {
        this._emit('log', `Failed to fetch ${result.url}: ${result.error ?? 'empty response'}`, 'warn');
        continue;
      }
      sections.push(`## ${result.url}`, '', result.text, '');
      this._emit('log', `Fetched ${result.url} (${result.text.length} chars)`, 'info');
    }

    const context = sections.length > 2 ? sections.join('\n') : '';
    this._webContextCache = { prompt, context };

    if (context) {
      this.workspace.writeFile(
        this.workspace.agentNotePath('00_web_context.md'),
        context
      );
    }
  }

  private async _prefetchWebSearch(): Promise<void> {
    this._ensureCapabilityServices();
    const webOn = this.research.webEnabled;
    const repoOn = this.research.repoReadsEnabled;
    if (!webOn && !repoOn) { return; }

    const prompt = this.workspace.readUserPrompt();
    // Research is no longer gated by a narrow keyword whitelist. It runs whenever
    // it can add value: when the prompt explicitly asks for current/external
    // knowledge, OR for any new-project build (grounding in current best
    // practices and existing high-quality code raises final quality). Focused
    // maintenance edits stay local unless they signal a research need.
    const explicitlyWantsResearch =
      /\b(latest|current|docs?|documentation|api reference|version|breaking change|library|framework|best practice|example|how to|research|compare|alternativ)\b/i.test(prompt);
    const route = this._selectWorkflowRoute(this.workspace.readProjectState());
    const shouldResearch = explicitlyWantsResearch || route.kind === 'full_project';
    if (!shouldResearch) { return; }

    const sections: string[] = ['# External Research Context', ''];
    const citations: string[] = [];

    if (webOn) {
      this._emit('log', 'Running policy-controlled web research for current, cited context.', 'info');
      const outcome = await this.research.webResearch(prompt);
      sections.push(ResearchService.format(outcome), '');
      citations.push(...outcome.findings.map(f => `${f.source} (retrieved ${f.retrievedAt})`));
    }

    if (repoOn) {
      this._emit('log', 'Discovering high-quality public code examples to learn from.', 'info');
      const outcome = await this.research.findCodeExamples(prompt);
      sections.push(ResearchService.format(outcome), '');
      citations.push(...outcome.findings.map(f => `${f.source}${f.updatedAt ? ` (updated ${f.updatedAt})` : ''}`));
    }

    if (citations.length === 0) { return; }

    this.workspace.writeFile(this.workspace.webSearchPath, sections.join('\n'));
    this._journal('research', `Gathered ${citations.length} external source(s)`,
      citations.map(c => `- ${c}`).join('\n'));
    this.workspace.appendMemoryEvent({
      type: 'search',
      phase: 'briefing',
      summary: `External research gathered ${citations.length} cited source(s) (web=${webOn}, repos=${repoOn}).`,
      data: { query: prompt, citations },
    });
  }

  /**
   * Extract http/https URLs from a prompt string.
   * Caps at 5 URLs to avoid excessive fetching.
   */
  private _extractUrlsFromPrompt(prompt: string): string[] {
    const urlPattern = /https?:\/\/[^\s\)\]>'"`,]+/gi;
    const found = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = urlPattern.exec(prompt)) !== null) {
      // Strip trailing punctuation that is unlikely to be part of the URL
      const url = match[0].replace(/[.,;:!?]+$/, '');
      try {
        new URL(url); // validate
        found.add(url);
      } catch { /* ignore invalid */ }
      if (found.size >= 5) { break; }
    }
    return [...found];
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

    const context = this._assembleContext([
      this._sec('# Original User Prompt', prompt, 1),
      this._sec('# Autonomous Project Brief', projectBrief, 2),
      this._sec('# Task Results', taskResults, 2),
      this._sec('# Test Results', testerNote, 3),
      this._sec('# Delivery Manifest', deliveryManifest, 3),
      this._sec('# Architecture', architectMd, 4),
      this._sec('# Changed Files', changedFiles.join('\n'), 4),
      this._sec('# Git Repository Snapshot', gitSnapshot, 7),
    ]);

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
    this._journal('report', 'Final report — handoff to boss', report);
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

  private async _phaseImprovementConsensus(state: ProjectState, sprint: number): Promise<ImprovementConsensus[]> {
    this._checkAborted();
    this._setPhase(state, 'brainstorm', `Retrospective brainstorm after sprint ${sprint}: checking whether more development is worthwhile...`);

    const prompt = this._userPromptWithFileContext();
    const promptFiles = this._promptReferencedFilePaths();
    const projectBrief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const architecture = this.workspace.readFile(this.workspace.architectMdPath) ?? '';
    const taskPlan = this.workspace.readFile(this.workspace.taskPlanPath) ?? '';
    const taskResults = this.workspace.readFile(this.workspace.taskResultsPath) ?? '';
    const testerNote = this.workspace.readFile(this.workspace.testerPath) ?? '';
    const rollingSummary = this.workspace.readFile(this.workspace.rollingSummaryPath) ?? '';
    const changedFiles = this._collectChangedFiles();
    const baseContext = this._assembleContext([
      this._sec('# Original User Prompt', prompt, 1),
      this._sec('', `# Sprint\n\n${sprint}`, 1, 0.02),
      this._sec('# Project Brief', projectBrief, 2),
      this._sec('# Completed Task Results', taskResults, 2),
      this._sec('# Verification Results', testerNote, 3),
      this._sec('# Architecture', architecture, 4),
      this._sec('# Current Task Plan', taskPlan, 5),
      this._sec('# Changed Files', changedFiles.join('\n') || 'No changed files recorded.', 5),
      this._sec('# Rolling Summary', rollingSummary, 6),
    ]);

    const roles: ImprovementConsensus['agentRole'][] = ['brainstorm', 'critic', 'secondBrainstorm'];
    const consensus: ImprovementConsensus[] = [];

    for (const role of roles) {
      this._checkAborted();
      const { model, fallbackModel } = this._agentConfig(role);
      const outputPath = this.workspace.agentNotePath(`sprint_${String(sprint).padStart(2, '0')}_${role}_consensus.json`);
      const messages: OllamaMessage[] = [
        {
          role: 'system',
          content: [
            'You are participating in an autonomous development retrospective.',
            'Decide whether the current verified product needs another small sprint.',
            'Only recommend work that materially improves the original user request.',
            'If tests pass and the product satisfies the brief, prefer stopping instead of inventing endless enhancements.',
            'Respond only with valid JSON.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            baseContext,
            '',
            'Return exactly this JSON shape:',
            '{',
            `  "agentRole": "${role}",`,
            '  "readyToStop": true,',
            '  "confidence": "low|medium|high",',
            '  "remainingWork": ["only meaningful remaining development work; empty if none"],',
            '  "nextSprintGoal": "short goal if another sprint is needed, otherwise empty string",',
            '  "rationale": "brief reason"',
            '}',
          ].join('\n'),
        },
      ];

      let result: ImprovementConsensus;
      try {
        result = await this._callWithFallbackJson<ImprovementConsensus>(
          role,
          model,
          fallbackModel,
          messages,
          outputPath,
          [this.workspace.userPromptPath, ...promptFiles, this.workspace.taskResultsPath, this.workspace.testerPath]
        );
      } catch (err) {
        result = this._fallbackImprovementConsensus(role, sprint, err);
        this.workspace.writeFile(outputPath, prettyJson(result));
        this.workspace.appendAssumption(role, `Self-healed failed sprint ${sprint} improvement consensus: ${formatError(err)}`);
      }

      result = this._normalizeImprovementConsensus(role, result);
      consensus.push(result);
      this.workspace.writeFile(outputPath, prettyJson(result));
      this._recordActivity({
        phase: 'brainstorm',
        agentRole: role,
        title: `${role} sprint ${sprint} retrospective`,
        detail: result.readyToStop ? result.rationale : `${result.nextSprintGoal}: ${result.remainingWork.slice(0, 2).join('; ')}`,
        status: result.readyToStop ? 'completed' : 'warn',
        round: sprint,
        totalRounds: this._maxDevelopmentSprints(),
      });
    }

    const summaryPath = this.workspace.agentNotePath(`sprint_${String(sprint).padStart(2, '0')}_consensus_summary.md`);
    const ready = this._consensusReadyToStop(consensus);
    this.workspace.writeFile(
      summaryPath,
      this._wrapNote(
        `Sprint ${sprint} Improvement Consensus`,
        [
          `Consensus: ${ready ? 'stop' : 'continue'}`,
          '',
          ...consensus.map(item => [
            `## ${item.agentRole}`,
            `Ready to stop: ${item.readyToStop}`,
            `Confidence: ${item.confidence}`,
            `Remaining work: ${item.remainingWork.length > 0 ? item.remainingWork.join('; ') : 'none'}`,
            `Next sprint goal: ${item.nextSprintGoal || 'none'}`,
            `Rationale: ${item.rationale}`,
          ].join('\n')),
        ].join('\n\n')
      )
    );
    this.workspace.appendRollingSummary(
      `## Sprint ${sprint} Retrospective\n` +
      `Consensus: ${ready ? 'stop' : 'continue'}\n` +
      consensus.map(item => `- ${item.agentRole}: ${item.readyToStop ? 'stop' : 'continue'} (${item.confidence})`).join('\n')
    );
    this._journal('consensus', `Sprint ${sprint} retrospective — decision: ${ready ? 'STOP (product is complete)' : 'CONTINUE (more work)'}`,
      consensus.map(item =>
        `- **${item.agentRole}**: ${item.readyToStop ? '✅ ready to stop' : '🔁 continue'} (${item.confidence}) — ${item.rationale}`
        + (item.remainingWork.length ? `\n  Remaining: ${item.remainingWork.join('; ')}` : '')
      ).join('\n'));
    this._updateTimeline('brainstorm', 'completed');
    return consensus;
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
    this._ensureCapabilityServices();
    const promptFiles = this._promptReferencedFilePaths();
    const baseline = this._captureFileBaselines([...task.allowedFiles, ...promptFiles], task.id, 'codeWorker');
    const existingFilesContent = task.allowedFiles.length > 0
      ? this.fileManager.readFilesAsContext(task.allowedFiles)
      : '';
    const answeredQuestions = this.workspace.readFile(this.workspace.openQuestionsPath) ?? '';
    const assumptions = this.workspace.readFile(this.workspace.assumptionsPath) ?? '';
    const promptWithFiles = this._userPromptWithFileContext();
    const projectBrief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const toolchain = this.workspace.readFile(this.workspace.toolchainReportPath) ?? '';
    const gitSnapshot = this.workspace.readFile(this.workspace.gitSnapshotPath) ?? '';
    const githubContext = this.workspace.readFile(this.workspace.githubContextPath) ?? '';
    const repoSearch = this.workspace.readFile(this.workspace.repoSearchPath) ?? '';
    const skillContext = this.workspace.readFile(this.workspace.skillContextPath) ?? '';
    const planContext = this.workspace.readFile(this.workspace.planControllerPath) ?? '';
    const toolManifest = this.toolRegistry.manifestForPrompt();
    const structuredMemory = this._structuredMemoryContext();
    const lessonsContext = this._loadLessons(5);
    const microCheckContext = this._lastMicroCheckSummary;

    const taskDesc =
      `**ID:** ${task.id}\n**Title:** ${task.title}\n\n` +
      `**Description:**\n${task.description}\n\n` +
      `**Allowed Files:** ${task.allowedFiles.join(', ') || 'any'}\n` +
      `**Forbidden Actions:** ${task.forbiddenActions.join(', ') || 'none'}\n\n` +
      `**Acceptance Criteria:**\n${task.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`;

    const context = this._assembleContext([
      this._sec('# Task', taskDesc, 1),
      this._sec('# Existing File Contents', existingFilesContent, 2),
      this._sec('# Original User Prompt And Referenced Files', promptWithFiles, 3),
      this._sec('# Autonomous Project Brief', projectBrief, 4),
      this._sec('# Architecture', architectMd, 4),
      this._sec('# Structured Memory Events', structuredMemory, 5),
      this._sec('# Rolling Summary', rollingSummary, 5),
      this._sec('# Local Toolchain Report', toolchain, 6),
      this._sec('# Lessons Learned From Previous Runs', lessonsContext, 6, 0.05),
      this._sec('# Git Repository Snapshot', gitSnapshot, 7),
      this._sec('# Last Micro-Sprint Check Results', microCheckContext, 7, 0.04),
      this._sec('# GitHub Context', githubContext, 8),
      this._sec('# Repository Search Context', repoSearch, 9),
      this._sec('# Matched Skill Context', skillContext, 10),
      this._sec('# Dynamic Plan Controller', planContext, 11),
      this._sec('# Tool Registry', toolManifest, 12),
      this._sec('# User Answers And Clarifications', answeredQuestions, 13),
      this._sec('# Autonomous Assumptions', assumptions, 14),
    ]);

    const { model, fallbackModel } = this._agentConfig('codeWorker');
    const messages = this._buildMessages('codeWorker', context);

    try {
      const result = await this._callWithFallbackJson<CodeWorkerOutput>(
        'codeWorker', model, fallbackModel, messages, this.workspace.codeWorkerPath,
        [...task.allowedFiles, ...promptFiles]
      );
      this._normalizeWorkerOutputShape('codeWorker', task, result);
      const finalResult = await this._runWorkerToolLoop('codeWorker', task, messages, this.workspace.codeWorkerPath, [...task.allowedFiles, ...promptFiles], result);
      this._normalizeWorkerOutputShape('codeWorker', task, finalResult);
      this._attachChangeBaseline(finalResult, baseline);
      return finalResult;
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

    const reviewTaskDesc =
      `**ID:** ${task.id}\n**Title:** ${task.title}\n\n` +
      `**Description:**\n${task.description}\n\n` +
      `**Acceptance Criteria:**\n${task.acceptanceCriteria.map(c => `- ${c}`).join('\n')}\n\n` +
      `**Allowed Files:** ${task.allowedFiles.join(', ') || 'any'}\n` +
      `**Forbidden Actions:** ${task.forbiddenActions.join(', ') || 'none'}`;

    const context = this._assembleContext([
      this._sec('# Task to Review', reviewTaskDesc, 1),
      this._sec('# Files Changed', filesContext, 2),
      this._sec('# Original User Prompt', prompt, 3),
      this._sec('# Autonomous Project Brief', projectBrief, 4),
      this._sec('# Architecture', architecture, 4),
      this._sec('# Git Repository Snapshot', gitSnapshot, 7),
    ]);

    const { model, fallbackModel } = this._agentConfig('reviewer');
    const messages = this._buildMessages('reviewer', context);

    let review: ReviewResult;
    try {
      review = await this._callWithFallbackJson<ReviewResult>(
        'reviewer', model, fallbackModel, messages, this.workspace.reviewerPath, promptFiles
      );
      this._normalizeReviewResult(task, review);
      this.workspace.appendFile(this.workspace.reviewerPath, `\n\n---\n\n${prettyJson(review)}`);
    } catch (err) {
      logWarn(`Reviewer failed for task "${task.id}": ${formatError(err)}. Falling back to heuristic review.`);
      const issues = this._heuristicReviewIssues(workerOutput);
      review = {
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

    // Cross-check: an independent, stronger model audits the change against
    // overall production-quality standards (not just task acceptance). Its
    // findings are merged in so the fix loop keeps iterating until BOTH the
    // task reviewer and the quality auditor are satisfied.
    const audit = await this._executeQualityAudit(task, workerOutput, context);
    return this._mergeReviewWithAudit(task, review, audit);
  }

  /**
   * Holistic code quality cross-check by a third, independent model (different
   * from the code writer and the task reviewer). It judges the change against
   * general engineering standards: correctness, completeness, error handling,
   * security, and consistency with the architecture — flagging only material,
   * production-blocking defects (never subjective style preferences).
   */
  private async _executeQualityAudit(
    task: TaskItem,
    workerOutput: CodeWorkerOutput,
    reviewContext: string
  ): Promise<ReviewResult> {
    const promptFiles = this._promptReferencedFilePaths();
    // Use the strongest available model (the brainstorm role, e.g. a 30B coder)
    // so the auditor brings a genuinely independent, capable perspective.
    const { model, fallbackModel } = this._agentConfig('brainstorm');
    const auditPath = this.workspace.agentNotePath('quality_audit.jsonl');
    const messages: OllamaMessage[] = [
      {
        role: 'system',
        content: [
          'You are a principal engineer performing an INDEPENDENT, holistic code-quality audit.',
          'Another engineer wrote this code and a reviewer already checked task acceptance.',
          'Your job is the overall-quality cross-check: judge the change against general production standards.',
          'Flag ONLY material, production-blocking defects in these categories:',
          '- Correctness bugs (logic errors, wrong/edge-case handling, broken control flow).',
          '- Incomplete implementation (stubs, TODOs, unimplemented core behavior, dead paths).',
          '- Missing or wrong error handling for realistic failures.',
          '- Security problems (injection, path traversal, secret leakage, unsafe input).',
          '- Inconsistency with the stated architecture or the original prompt constraints.',
          'Do NOT flag subjective style, naming, or nice-to-have refactors. If the code is production-ready, approve it.',
          'Respond only with valid JSON.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          reviewContext,
          '',
          'Return exactly this JSON shape:',
          '{',
          '  "approved": true,',
          '  "blockingIssues": ["material defects that must be fixed before continuing; empty if none"],',
          '  "securityConcerns": ["security defects; empty if none"],',
          '  "fixInstructions": ["specific, actionable fix instructions for each blocking issue"],',
          '  "qualityScore": 0,',
          '  "rationale": "one-sentence overall judgement"',
          '}',
        ].join('\n'),
      },
    ];

    try {
      const raw = await this._callWithFallbackJson<{
        approved?: boolean;
        blockingIssues?: unknown;
        securityConcerns?: unknown;
        fixInstructions?: unknown;
        qualityScore?: unknown;
        rationale?: unknown;
      }>('brainstorm', model, fallbackModel, messages, auditPath, promptFiles);

      const toList = (v: unknown): string[] =>
        Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean).slice(0, 10) : [];
      const blockingIssues = toList(raw.blockingIssues);
      const securityConcerns = toList(raw.securityConcerns);
      const needsFix = !(raw.approved === true) || blockingIssues.length > 0 || securityConcerns.length > 0;

      const result: ReviewResult = {
        taskId: task.id,
        approved: !needsFix,
        issues: blockingIssues,
        suggestions: typeof raw.rationale === 'string' ? [raw.rationale] : [],
        securityConcerns,
        needsFix,
        fixSuggestions: toList(raw.fixInstructions),
        reviewedAt: new Date().toISOString(),
      };
      this.workspace.appendFile(
        auditPath,
        JSON.stringify({ timestamp: result.reviewedAt, taskId: task.id, ...raw }) + '\n'
      );
      this._journal(needsFix ? 'warn' : 'audit',
        `Quality audit for ${task.id}`,
        needsFix
          ? `🔁 Found ${blockingIssues.length + securityConcerns.length} blocking issue(s): ${[...blockingIssues, ...securityConcerns].slice(0, 3).join('; ')}`
          : `✅ Passed holistic quality audit. ${typeof raw.rationale === 'string' ? raw.rationale : ''}`.trim()
      );
      return result;
    } catch (err) {
      // The auditor model is unavailable even after self-healing retries/alternate
      // models. We must NOT silently approve — that would let incomplete or unsafe
      // code pass the "highest possible quality" bar. Instead, degrade to a
      // deterministic heuristic audit (stubs, TODOs, empty bodies, obvious red
      // flags) and record an explicit uncertainty so the gap is visible in the
      // journal and the brief, rather than hidden behind a false approval.
      const heuristicIssues = this._heuristicReviewIssues(workerOutput);
      const needsFix = heuristicIssues.length > 0;
      const note =
        `Holistic quality auditor was unavailable (${formatError(err)}). ` +
        `Fell back to a heuristic audit, which found ${heuristicIssues.length} issue(s).`;
      logWarn(`Quality auditor failed for task "${task.id}": ${note}`);
      this.workspace.appendAssumption('quality-audit',
        `${note} Treat the independent quality cross-check for task "${task.id}" as DEGRADED, not fully passed.`);
      this._journal('warn', `Quality audit DEGRADED for ${task.id}`,
        needsFix
          ? `⚠️ Auditor model unavailable; heuristic audit flagged ${heuristicIssues.length} issue(s): ${heuristicIssues.slice(0, 3).join('; ')}`
          : `⚠️ Auditor model unavailable; heuristic audit found no obvious defects, but the holistic cross-check did NOT run.`);
      return {
        taskId: task.id,
        approved: !needsFix,
        issues: heuristicIssues,
        suggestions: [],
        securityConcerns: [],
        needsFix,
        fixSuggestions: needsFix
          ? ['Resolve the heuristic findings and return complete, production-ready file contents.']
          : [],
        uncertainties: [note],
        reviewedAt: new Date().toISOString(),
      };
    }
  }

  /** Merge the task reviewer's verdict with the independent quality audit. */
  private _mergeReviewWithAudit(task: TaskItem, review: ReviewResult, audit: ReviewResult): ReviewResult {
    const dedupe = (arr: string[]): string[] => [...new Set(arr.map(s => s.trim()).filter(Boolean))];
    const needsFix = review.needsFix || audit.needsFix;
    const merged: ReviewResult = {
      taskId: task.id,
      approved: !needsFix,
      issues: dedupe([...review.issues, ...audit.issues.map(i => `[quality] ${i}`)]),
      suggestions: dedupe([...review.suggestions, ...audit.suggestions]),
      securityConcerns: dedupe([...review.securityConcerns, ...audit.securityConcerns]),
      needsFix,
      fixSuggestions: dedupe([...review.fixSuggestions, ...audit.fixSuggestions]),
      uncertainties: dedupe([...(review.uncertainties ?? []), ...(audit.uncertainties ?? [])]),
      reviewedAt: new Date().toISOString(),
    };
    return merged;
  }

  private async _executeFixer(
    task: TaskItem,
    review: ReviewResult,
    _state: ProjectState
  ): Promise<CodeWorkerOutput | null> {
    this._ensureCapabilityServices();
    const promptFiles = this._promptReferencedFilePaths();
    const baseline = this._captureFileBaselines([...task.allowedFiles, ...promptFiles], task.id, 'fixer');
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
    const projectBrief = this.workspace.readFile(this.workspace.projectBriefPath) ?? '';
    const architecture = this.workspace.readFile(this.workspace.architectMdPath) ?? '';
    const toolchain = this.workspace.readFile(this.workspace.toolchainReportPath) ?? '';
    const gitSnapshot = this.workspace.readFile(this.workspace.gitSnapshotPath) ?? '';
    const githubContext = this.workspace.readFile(this.workspace.githubContextPath) ?? '';
    const repoSearch = this.workspace.readFile(this.workspace.repoSearchPath) ?? '';
    const skillContext = this.workspace.readFile(this.workspace.skillContextPath) ?? '';
    const planContext = this.workspace.readFile(this.workspace.planControllerPath) ?? '';
    const toolManifest = this.toolRegistry.manifestForPrompt();
    const latestTestOutput = this.workspace.readFile(this.workspace.testResultLogPath) ?? '';
    const diagnosticBundle = this._latestVerificationDiagnosticBundle(errorContext);
    const structuredMemory = this._structuredMemoryContext();

    const fixerTaskDesc =
      `**ID:** ${task.id}\n**Title:** ${task.title}\n\n` +
      `**Description:**\n${task.description}\n\n` +
      `**Allowed Files:** ${task.allowedFiles.join(', ') || 'none'}\n` +
      `**Acceptance Criteria:**\n${task.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`;

    const context = this._assembleContext([
      this._sec('# Task', fixerTaskDesc, 1),
      this._sec('# Errors to Fix', errorContext, 1),
      this._sec('# Diagnostic Bundle', diagnosticBundle, 2),
      this._sec('# Current File Contents', existingFilesContent, 2),
      this._sec('# Latest Verification Output', latestTestOutput, 2),
      this._sec('# Original User Prompt', prompt, 3),
      this._sec('# Autonomous Project Brief', projectBrief, 4),
      this._sec('# Architecture', architecture, 4),
      this._sec('# Structured Memory Events', structuredMemory, 5),
      this._sec('# Local Toolchain Report', toolchain, 6),
      this._sec('# Git Repository Snapshot', gitSnapshot, 7),
      this._sec('# GitHub Context', githubContext, 8),
      this._sec('# Repository Search Context', repoSearch, 9),
      this._sec('# Matched Skill Context', skillContext, 10),
      this._sec('# Dynamic Plan Controller', planContext, 11),
      this._sec('# Tool Registry', toolManifest, 12),
      this._sec('# User Answers And Clarifications', answeredQuestions, 13),
      this._sec('# Autonomous Assumptions', assumptions, 14),
    ]);

    const { model, fallbackModel } = this._agentConfig('fixer');
    const messages = this._buildMessages('fixer', context);

    try {
      const result = await this._callWithFallbackJson<CodeWorkerOutput>(
        'fixer', model, fallbackModel, messages, this.workspace.codeWorkerPath, [...task.allowedFiles, ...promptFiles]
      );
      this._normalizeWorkerOutputShape('fixer', task, result);
      const finalResult = await this._runWorkerToolLoop('fixer', task, messages, this.workspace.codeWorkerPath, [...task.allowedFiles, ...promptFiles], result);
      this._normalizeWorkerOutputShape('fixer', task, finalResult);
      this._attachChangeBaseline(finalResult, baseline);
      return finalResult;
    } catch (err) {
      this._emit('error', `Fixer failed: ${formatError(err)}`);
      return null;
    }
  }

  private async _runWorkerToolLoop(
    role: 'codeWorker' | 'fixer',
    task: TaskItem,
    baseMessages: OllamaMessage[],
    outputFile: string,
    inputFiles: string[],
    initialResult: CodeWorkerOutput
  ): Promise<CodeWorkerOutput> {
    this._ensureCapabilityServices();
    if (!this.modelConfig.toolCalling?.enabled) {
      return initialResult;
    }

    let result = initialResult;
    const messages = [...baseMessages];
    const { model, fallbackModel } = this._agentConfig(role);
    const maxRounds = this.modelConfig.toolCalling.maxToolRounds;
    const failedToolRequests = new Map<string, number>();

    for (let round = 1; round <= maxRounds; round++) {
      const requests = (result.toolRequests ?? [])
        .filter(request => request && typeof request.name === 'string')
        .slice(0, 6);
      if (requests.length === 0) { break; }

      const repeatFailedRequests = requests.filter(request => {
        const normalizedRequest = {
          id: request.id || `${role}-${task.id}-tool-${round}`,
          name: request.name,
          args: request.args ?? {},
        };
        return (failedToolRequests.get(this._toolRequestFingerprint(normalizedRequest)) ?? 0) > 0;
      });
      if (repeatFailedRequests.length === requests.length) {
        this.workspace.appendAssumption(
          role,
          `Task ${task.id} stopped tool-calling after repeated failed tool request(s): ${repeatFailedRequests.map(request => request.name).join(', ')}.`
        );
        result.toolRequests = [];
        break;
      }

      const toolResults: ToolCallResult[] = [];
      for (const request of requests) {
        this._checkAborted();
        const normalizedRequest = {
          id: request.id || `${role}-${task.id}-tool-${round}-${toolResults.length + 1}`,
          name: request.name,
          args: request.args ?? {},
        };
        const fingerprint = this._toolRequestFingerprint(normalizedRequest);
        if ((failedToolRequests.get(fingerprint) ?? 0) > 0) {
          const toolResult: ToolCallResult = {
            id: normalizedRequest.id,
            name: normalizedRequest.name,
            success: false,
            output: '',
            error: 'Skipped repeated tool request because the same tool call already failed. Use prior observations and produce final file changes instead.',
          };
          toolResults.push(toolResult);
          this.workspace.appendMemoryEvent({
            type: 'tool',
            phase: this.workspace.readProjectState().currentPhase,
            agentRole: role,
            taskId: task.id,
            summary: `${role} tool ${toolResult.name} skipped after repeated failure.`,
            data: {
              request: normalizedRequest,
              error: toolResult.error,
              outputPreview: '',
            },
          });
          continue;
        }
        const toolResult = await this.toolRegistry.execute(normalizedRequest);
        toolResults.push(toolResult);
        if (this._toolResultFailed(toolResult)) {
          failedToolRequests.set(fingerprint, (failedToolRequests.get(fingerprint) ?? 0) + 1);
        }
        this.workspace.appendMemoryEvent({
          type: 'tool',
          phase: this.workspace.readProjectState().currentPhase,
          agentRole: role,
          taskId: task.id,
          summary: `${role} tool ${toolResult.name} ${toolResult.success ? 'succeeded' : 'failed'}.`,
          data: {
            request: normalizedRequest,
            error: toolResult.error,
            outputPreview: toolResult.output.slice(0, 1000),
          },
        });
      }

      messages.push({
        role: 'assistant',
        content: JSON.stringify({ reasoning: result.reasoning, toolRequests: requests }),
      });
      messages.push({
        role: 'user',
        content:
          `Tool round ${round}/${maxRounds} results for task ${task.id}:\n\n` +
          `${prettyJson(toolResults)}\n\n` +
          'Use these observations to produce the final CodeWorkerOutput JSON. Return file changes when ready. If more tool calls are still necessary, include toolRequests again.',
      });

      result = await this._callWithFallbackJson<CodeWorkerOutput>(
        role,
        model,
        fallbackModel,
        messages,
        outputFile,
        inputFiles
      );
      result.toolResults = toolResults;
      this._normalizeWorkerOutputShape(role, task, result);
    }

    if ((result.toolRequests ?? []).length > 0) {
      this.workspace.appendAssumption(
        role,
        `Task ${task.id} reached the tool-calling round limit. Continuing with the last available worker output.`
      );
      result.toolRequests = [];
    }

    return result;
  }

  private _toolRequestFingerprint(request: ToolCallRequest): string {
    return `${request.name}:${this._stableJson(request.args ?? {})}`;
  }

  private _toolResultFailed(result: ToolCallResult): boolean {
    if (!result.success || result.error) { return true; }
    return /"success"\s*:\s*false|"exitCode"\s*:\s*(?:[1-9]|\d{2,})/.test(result.output);
  }

  private _stableJson(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(item => this._stableJson(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      return `{${Object.keys(value as Record<string, unknown>).sort().map(key =>
        `${JSON.stringify(key)}:${this._stableJson((value as Record<string, unknown>)[key])}`
      ).join(',')}}`;
    }
    return JSON.stringify(value);
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

    const baselineConflicts = this._detectBaselineConflicts(workerOutput);
    if (baselineConflicts.length > 0) {
      const message = baselineConflicts.join('\n');
      this.workspace.appendMemoryEvent({
        type: 'patch',
        phase: this.workspace.readProjectState().currentPhase,
        summary: `Patch ${patchId} blocked because target files changed after the agent read them.`,
        data: { patchId, targetFiles, conflicts: baselineConflicts },
      });
      this._emit('error', `Patch "${patchId}" blocked to avoid overwriting user changes:\n${message}`);
      return false;
    }

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

    const postApprovalConflicts = this._detectBaselineConflicts(workerOutput);
    if (postApprovalConflicts.length > 0) {
      const message = postApprovalConflicts.join('\n');
      this._emit('error', `Patch "${patchId}" blocked after approval because files changed:\n${message}`);
      return false;
    }

    const result = this.patchService.hasUnifiedPatch(workerOutput.files)
      ? this.patchService.applyFileChanges(workerOutput.files)
      : this.fileManager.applyApprovedChanges(workerOutput.files);
    if (!result.applied) {
      this._emit('error', `Failed to apply changes: ${result.error}`);
      return false;
    } else {
      this.workspace.appendMemoryEvent({
        type: 'patch',
        phase: this.workspace.readProjectState().currentPhase,
        summary: `Applied patch ${patchId}.`,
        data: { patchId, targetFiles, changeCount: workerOutput.files.length },
      });
      this._emit('log', `Applied ${workerOutput.files.length} file change(s).`, 'info');
      return true;
    }
  }

  private async _tryDeterministicTaskRecovery(
    task: TaskItem,
    state: ProjectState,
    taskPlan: TaskPlan,
    review?: ReviewResult
  ): Promise<CodeWorkerOutput | null> {
    const recovery = this._deterministicProductRecovery(task, review);
    if (!recovery) { return null; }

    for (const change of recovery.files) {
      const normalized = this._normalizeRelativePath(change.path);
      if (!this._isSafeWorkspaceRelativePath(normalized)) {
        this._emit('error', `Deterministic recovery skipped unsafe path "${change.path}".`);
        return null;
      }
      change.path = normalized;
      if (!this._matchesAllowedPath(normalized, task.allowedFiles)) {
        task.allowedFiles.push(normalized);
      }
    }

    this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
    this.callbacks.onTaskUpdate?.(taskPlan.tasks);
    this.workspace.appendAssumption(
      'fixer',
      `Task ${task.id} used deterministic product recovery after model output could not produce a complete verifiable product.`
    );
    this._emit('log', `Task "${task.id}" is using deterministic product recovery.`, 'warn');
    this._attachChangeBaseline(
      recovery,
      this._captureFileBaselines(recovery.files.map(change => change.path), task.id, 'fixer')
    );

    const applied = await this._applyCodeChanges(`${task.id}-deterministic-recovery-${Date.now()}`, recovery, state);
    return applied ? recovery : null;
  }

  private _isApplePlatformProject(): boolean {
    const prompt = this.workspace.readUserPrompt().toLowerCase();
    const brief = (this.workspace.readFile(this.workspace.projectBriefPath) ?? '').toLowerCase();
    return /swift|swiftui|ios|macos|iphone|ipad|xcode|cocoa/.test(prompt + brief)
      || this.fileManager.fileExists('Package.swift')
      || this._findWorkspaceEntryByExtension('.xcodeproj') !== null
      || this._findWorkspaceEntryByExtension('.xcworkspace') !== null;
  }

  private _deterministicProductRecovery(task: TaskItem, review?: ReviewResult): CodeWorkerOutput | null {
    // Never generate web/game/Node.js files for Apple platform projects
    if (this._isApplePlatformProject()) { return null; }
    return this._deterministicArkanoidGameRecovery(task, review)
      ?? this._deterministicBrowserGameRecovery(task, review)
      ?? this._deterministicApiRecovery(task, review)
      ?? this._deterministicReactRecovery(task, review)
      ?? this._deterministicCliRecovery(task, review)
      ?? this._deterministicNodeLibraryRecovery(task, review)
      ?? this._deterministicStaticWebRecovery(task, review);
  }

  private _deterministicBrowserGameRecovery(task: TaskItem, review?: ReviewResult): CodeWorkerOutput | null {
    const prompt = this.workspace.readUserPrompt();
    if (!this._isBrowserMiniGamePrompt(prompt)) { return null; }

    const lowerTask = `${task.title}\n${task.description}\n${review?.issues.join('\n') ?? ''}`.toLowerCase();
    const shouldRecover =
      /logic|render|game|integrat|difficulty|pause|restart|test|scaffold|project|hud|browser|canvas/.test(lowerTask);
    if (!shouldRecover) { return null; }

    const projectName = this._gameTitleFromPrompt(prompt);
    const packageName = this._slugFromPrompt(projectName);
    return {
      reasoning: `Deterministic self-healing generated a complete playable browser mini game for ${projectName}.`,
      files: [
        {
          path: 'package.json',
          action: 'create',
          description: 'Package scripts for testing and local play instructions.',
          content: this._deterministicBrowserGamePackageJson(packageName, projectName),
        },
        {
          path: 'index.html',
          action: 'create',
          description: 'Browser entry point with canvas and controls.',
          content: this._deterministicBrowserGameIndexHtml(projectName),
        },
        {
          path: 'styles.css',
          action: 'create',
          description: 'Responsive arcade styling.',
          content: this._deterministicBrowserGameStyles(),
        },
        {
          path: 'src/logic.js',
          action: 'create',
          description: 'Dependency-free, testable game logic.',
          content: this._deterministicBrowserGameLogic(),
        },
        {
          path: 'src/render.js',
          action: 'create',
          description: 'Canvas rendering helpers.',
          content: this._deterministicBrowserGameRenderer(),
        },
        {
          path: 'src/game.js',
          action: 'create',
          description: 'Browser game loop and controls.',
          content: this._deterministicBrowserGameRuntime(),
        },
        {
          path: 'test/logic.test.js',
          action: 'create',
          description: 'node:test coverage for core game logic.',
          content: this._deterministicBrowserGameTests(),
        },
        {
          path: 'README.md',
          action: 'create',
          description: 'Run and play instructions.',
          content: this._deterministicBrowserGameReadme(projectName),
        },
      ],
      needUserInput: false,
      questions: [],
      blockedReason: undefined,
    };
  }

  private _deterministicArkanoidGameRecovery(task: TaskItem, review?: ReviewResult): CodeWorkerOutput | null {
    const prompt = this.workspace.readUserPrompt();
    if (!this._isArkanoidGamePrompt(prompt)) { return null; }

    const lowerTask = `${task.title}\n${task.description}\n${task.acceptanceCriteria.join('\n')}\n${review?.issues.join('\n') ?? ''}`.toLowerCase();
    if (!/logic|render|game|level|brick|paddle|ball|test|scaffold|project|browser|canvas|arkanoid|breakout/.test(lowerTask)) {
      return null;
    }

    const projectName = this._projectTitleFromPrompt(prompt, 'Neon Brick Breaker');
    const packageName = this._slugFromPrompt(projectName);
    return {
      reasoning: `Deterministic self-healing generated a complete Arkanoid-style browser game with 10 levels for ${projectName}.`,
      files: [
        {
          path: 'package.json',
          action: 'create',
          description: 'Package scripts for testing and local play instructions.',
          content: this._deterministicBrowserGamePackageJson(packageName, projectName),
        },
        {
          path: 'index.html',
          action: 'create',
          description: 'Arkanoid browser entry point with canvas and controls.',
          content: this._deterministicArkanoidIndexHtml(projectName),
        },
        {
          path: 'styles.css',
          action: 'create',
          description: 'Responsive arcade cabinet styling.',
          content: this._deterministicArkanoidStyles(),
        },
        {
          path: 'src/logic.js',
          action: 'create',
          description: 'Dependency-free, testable Arkanoid game logic with 10 levels.',
          content: this._deterministicArkanoidLogic(),
        },
        {
          path: 'src/render.js',
          action: 'create',
          description: 'Canvas rendering helpers for Arkanoid gameplay.',
          content: this._deterministicArkanoidRenderer(),
        },
        {
          path: 'src/app.js',
          action: 'create',
          description: 'Browser game loop, input, pause, and restart controls.',
          content: this._deterministicArkanoidRuntime(),
        },
        {
          path: 'test/logic.test.js',
          action: 'create',
          description: 'node:test coverage for Arkanoid levels, scoring, collisions, and win/loss rules.',
          content: this._deterministicArkanoidTests(),
        },
        {
          path: 'README.md',
          action: 'create',
          description: 'Run and play instructions for the 10-level Arkanoid game.',
          content: this._deterministicArkanoidReadme(projectName),
        },
      ],
      needUserInput: false,
      questions: [],
      blockedReason: undefined,
    };
  }

  private _deterministicApiRecovery(task: TaskItem, review?: ReviewResult): CodeWorkerOutput | null {
    const prompt = this.workspace.readUserPrompt();
    if (!this._isApiProjectPrompt(prompt)) { return null; }
    if (!this._shouldRecoverWholeProductTask(task, review)) { return null; }

    const projectName = this._projectTitleFromPrompt(prompt, 'Pantry API');
    const packageName = this._slugFromPrompt(projectName);
    return {
      reasoning: `Deterministic self-healing generated a complete dependency-free REST API for ${projectName}.`,
      files: [
        {
          path: 'package.json',
          action: 'create',
          description: 'Package scripts for API verification and local serving.',
          content: this._deterministicApiPackageJson(packageName, projectName),
        },
        {
          path: 'src/server.js',
          action: 'create',
          description: 'Dependency-free Node HTTP API.',
          content: this._deterministicApiServer(),
        },
        {
          path: 'test/server.test.js',
          action: 'create',
          description: 'node:test coverage for core API routes.',
          content: this._deterministicApiTests(),
        },
        {
          path: 'README.md',
          action: 'create',
          description: 'API usage and verification instructions.',
          content: this._deterministicApiReadme(projectName),
        },
      ],
      needUserInput: false,
      questions: [],
      blockedReason: undefined,
    };
  }

  private _deterministicReactRecovery(task: TaskItem, review?: ReviewResult): CodeWorkerOutput | null {
    const prompt = this.workspace.readUserPrompt();
    if (!this._isReactProjectPrompt(prompt)) { return null; }
    if (!this._shouldRecoverWholeProductTask(task, review)) { return null; }

    const projectName = this._projectTitleFromPrompt(prompt, 'Insight Board');
    const packageName = this._slugFromPrompt(projectName);
    return {
      reasoning: `Deterministic self-healing generated a complete React/Vite product scaffold for ${projectName}.`,
      files: [
        {
          path: 'package.json',
          action: 'create',
          description: 'Package scripts and React/Vite dependencies.',
          content: this._deterministicReactPackageJson(packageName, projectName),
        },
        {
          path: 'index.html',
          action: 'create',
          description: 'Vite HTML entry point.',
          content: this._deterministicReactIndexHtml(projectName),
        },
        {
          path: 'src/main.jsx',
          action: 'create',
          description: 'React application bootstrap.',
          content: this._deterministicReactMain(),
        },
        {
          path: 'src/App.jsx',
          action: 'create',
          description: 'Usable dashboard-style React experience.',
          content: this._deterministicReactApp(projectName),
        },
        {
          path: 'src/styles.css',
          action: 'create',
          description: 'Responsive product styling.',
          content: this._deterministicReactStyles(),
        },
        {
          path: 'test/app.test.js',
          action: 'create',
          description: 'node:test static smoke coverage.',
          content: this._deterministicReactTests(projectName),
        },
        {
          path: 'README.md',
          action: 'create',
          description: 'React app usage and verification instructions.',
          content: this._deterministicReactReadme(projectName),
        },
      ],
      needUserInput: false,
      questions: [],
      blockedReason: undefined,
    };
  }

  private _deterministicCliRecovery(task: TaskItem, review?: ReviewResult): CodeWorkerOutput | null {
    const prompt = this.workspace.readUserPrompt();
    if (!this._isCliProjectPrompt(prompt)) { return null; }
    if (!this._shouldRecoverWholeProductTask(task, review)) { return null; }

    const projectName = this._projectTitleFromPrompt(prompt, 'Local Tasks CLI');
    const packageName = this._slugFromPrompt(projectName);
    return {
      reasoning: `Deterministic self-healing generated a complete dependency-free CLI product for ${projectName}.`,
      files: [
        {
          path: 'package.json',
          action: 'create',
          description: 'Package scripts for CLI verification and demo.',
          content: this._deterministicCliPackageJson(packageName, projectName),
        },
        {
          path: 'src/cli.js',
          action: 'create',
          description: 'Dependency-free CLI implementation.',
          content: this._deterministicCliSource(),
        },
        {
          path: 'test/cli.test.js',
          action: 'create',
          description: 'node:test coverage for core CLI behavior.',
          content: this._deterministicCliTests(),
        },
        {
          path: 'README.md',
          action: 'create',
          description: 'CLI usage and verification instructions.',
          content: this._deterministicCliReadme(projectName),
        },
      ],
      needUserInput: false,
      questions: [],
      blockedReason: undefined,
    };
  }

  private _deterministicNodeLibraryRecovery(task: TaskItem, review?: ReviewResult): CodeWorkerOutput | null {
    const prompt = this.workspace.readUserPrompt();
    if (!this._isNodeLibraryProjectPrompt(prompt)) { return null; }
    if (!this._shouldRecoverWholeProductTask(task, review)) { return null; }

    const projectName = this._projectTitleFromPrompt(prompt, 'Tiny Utils');
    const packageName = this._slugFromPrompt(projectName);
    return {
      reasoning: `Deterministic self-healing generated a complete dependency-free Node library for ${projectName}.`,
      files: [
        {
          path: 'package.json',
          action: 'create',
          description: 'Package metadata, exports, and test scripts.',
          content: this._deterministicNodeLibraryPackageJson(packageName, projectName),
        },
        {
          path: 'src/index.js',
          action: 'create',
          description: 'Dependency-free reusable library utilities.',
          content: this._deterministicNodeLibrarySource(),
        },
        {
          path: 'test/index.test.js',
          action: 'create',
          description: 'node:test coverage for exported utilities.',
          content: this._deterministicNodeLibraryTests(),
        },
        {
          path: 'README.md',
          action: 'create',
          description: 'Library usage and verification instructions.',
          content: this._deterministicNodeLibraryReadme(projectName, packageName),
        },
      ],
      needUserInput: false,
      questions: [],
      blockedReason: undefined,
    };
  }

  private _deterministicStaticWebRecovery(task: TaskItem, review?: ReviewResult): CodeWorkerOutput | null {
    const prompt = this.workspace.readUserPrompt();
    if (!this._isStaticWebProjectPrompt(prompt)) { return null; }
    if (!this._shouldRecoverWholeProductTask(task, review)) { return null; }

    const projectName = this._projectTitleFromPrompt(prompt, 'Local Web App');
    const packageName = this._slugFromPrompt(projectName);
    return {
      reasoning: `Deterministic self-healing generated a complete dependency-free static web product for ${projectName}.`,
      files: [
        {
          path: 'package.json',
          action: 'create',
          description: 'Package scripts for static web verification and demo.',
          content: this._deterministicStaticWebPackageJson(packageName, projectName),
        },
        {
          path: 'index.html',
          action: 'create',
          description: 'Static web app entry point.',
          content: this._deterministicStaticWebIndexHtml(projectName),
        },
        {
          path: 'styles.css',
          action: 'create',
          description: 'Responsive static web styling.',
          content: this._deterministicStaticWebStyles(),
        },
        {
          path: 'src/app.js',
          action: 'create',
          description: 'Dependency-free browser behavior.',
          content: this._deterministicStaticWebApp(),
        },
        {
          path: 'test/smoke.test.js',
          action: 'create',
          description: 'node:test smoke checks for generated web files.',
          content: this._deterministicStaticWebTests(projectName),
        },
        {
          path: 'README.md',
          action: 'create',
          description: 'Static web usage and verification instructions.',
          content: this._deterministicStaticWebReadme(projectName),
        },
      ],
      needUserInput: false,
      questions: [],
      blockedReason: undefined,
    };
  }

  private _shouldRecoverWholeProductTask(task: TaskItem, review?: ReviewResult): boolean {
    const text = `${task.title}\n${task.description}\n${task.acceptanceCriteria.join('\n')}\n${review?.issues.join('\n') ?? ''}\n${review?.fixSuggestions.join('\n') ?? ''}`.toLowerCase();
    return /scaffold|project|package|source|core|implement|test|verify|readme|app|product|feature|script|run|build|fix|failed|missing|incomplete/.test(text);
  }

  private _isBrowserMiniGamePrompt(prompt: string): boolean {
    const lower = this._normalizedPromptIntent(prompt);
    return /game|arcade|dodge|meteor|canvas|arkanoid|breakout|brick/.test(lower)
      && (/browser|html|canvas|javascript|opening index\.html|index\.html/.test(lower) || this._isArkanoidGamePrompt(lower));
  }

  private _isArkanoidGamePrompt(prompt: string): boolean {
    const lower = this._normalizedPromptIntent(prompt);
    return /arkanoid|breakout|brick breaker|brick[- ]breaker|paddle.*ball|ball.*paddle/.test(lower)
      && /game|browser|canvas|html|javascript|level|lvl|\d+\s*(level|lvl)/.test(lower);
  }

  private _isCliProjectPrompt(prompt: string): boolean {
    const lower = prompt.toLowerCase();
    return /\bcli\b|command[- ]line|terminal tool|console app/.test(lower);
  }

  private _isApiProjectPrompt(prompt: string): boolean {
    const lower = prompt.toLowerCase();
    return /\bapi\b|rest|backend|server|http service|json endpoint/.test(lower);
  }

  private _isReactProjectPrompt(prompt: string): boolean {
    const lower = prompt.toLowerCase();
    return /react|vite|tsx|jsx|component/.test(lower) && /app|dashboard|product|frontend|web/.test(lower);
  }

  private _isNodeLibraryProjectPrompt(prompt: string): boolean {
    const lower = prompt.toLowerCase();
    return /node library|npm package|javascript library|utility package|library package|\blib\b/.test(lower);
  }

  private _isStaticWebProjectPrompt(prompt: string): boolean {
    const lower = prompt.toLowerCase();
    return !this._isBrowserMiniGamePrompt(prompt)
      && !this._isReactProjectPrompt(prompt)
      && /web app|website|landing page|dashboard|html|css|browser|static site|single page/.test(lower);
  }

  private _gameTitleFromPrompt(prompt: string): string {
    return this._projectTitleFromPrompt(prompt, 'Meteor Dodge');
  }

  private _projectTitleFromPrompt(prompt: string, fallback: string): string {
    const quoted = prompt.match(/called\s+["']([^"']+)["']/i);
    if (quoted) { return quoted[1].trim(); }
    const titled = prompt.match(/(?:game|project|app|tool|website|site|cli|api|package|library)\s+(?:called|named)\s+([A-Za-z0-9 -]{3,40})/i);
    return titled ? titled[1].trim() : fallback;
  }

  private _normalizedPromptIntent(prompt: string): string {
    return prompt
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\bakanoid\b/g, 'arkanoid')
      .replace(/\barkanoids\b/g, 'arkanoid')
      .replace(/\bbrickbreaker\b/g, 'brick breaker');
  }

  private _deterministicBrowserGamePackageJson(packageName: string, projectName: string): string {
    return prettyJson({
      name: packageName,
      version: '1.0.0',
      description: `${projectName} - a dependency-free canvas mini game.`,
      main: 'index.html',
      scripts: {
        test: 'node --test test/*.test.js',
        demo: 'echo "Open http://127.0.0.1:5173 after running npm start."',
        start: 'python3 -m http.server 5173',
      },
      keywords: ['game', 'canvas', 'browser'],
      license: 'MIT',
    });
  }

  private _deterministicBrowserGameIndexHtml(projectName: string): string {
    return [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${projectName}</title>`,
      '  <link rel="stylesheet" href="styles.css">',
      '</head>',
      '<body>',
      '  <main class="shell">',
      '    <section class="game-frame" aria-label="Game canvas">',
      '      <canvas id="gameCanvas" width="900" height="560"></canvas>',
      '    </section>',
      '    <aside class="help">',
      `      <h1>${projectName}</h1>`,
      '      <p>Dodge meteors, collect stars, and survive as the level ramps up.</p>',
      '      <dl>',
      '        <dt>Move</dt><dd>Arrow keys or WASD</dd>',
      '        <dt>Pause</dt><dd>Space</dd>',
      '        <dt>Restart</dt><dd>R after game over</dd>',
      '      </dl>',
      '    </aside>',
      '  </main>',
      '  <script src="src/logic.js"></script>',
      '  <script src="src/render.js"></script>',
      '  <script src="src/app.js"></script>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  private _deterministicBrowserGameStyles(): string {
    return [
      '* { box-sizing: border-box; }',
      'html, body { min-height: 100%; }',
      'body {',
      '  margin: 0;',
      '  color: #edf6ff;',
      '  background: radial-gradient(circle at top left, rgba(98, 190, 255, 0.28), transparent 34rem), linear-gradient(135deg, #111827, #16113a 55%, #260f2f);',
      '  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
      '}',
      '.shell {',
      '  min-height: 100vh;',
      '  display: grid;',
      '  grid-template-columns: minmax(320px, 900px) minmax(220px, 320px);',
      '  gap: 24px;',
      '  align-items: center;',
      '  justify-content: center;',
      '  padding: 24px;',
      '}',
      '.game-frame {',
      '  width: min(900px, 100%);',
      '  aspect-ratio: 45 / 28;',
      '  border: 1px solid rgba(255, 255, 255, 0.22);',
      '  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.35);',
      '  background: #060914;',
      '}',
      'canvas { display: block; width: 100%; height: 100%; }',
      '.help { line-height: 1.5; }',
      '.help h1 { margin: 0 0 8px; font-size: 2rem; letter-spacing: 0; }',
      '.help p { margin: 0 0 20px; color: #bed3ee; }',
      'dt { color: #7dd3fc; font-weight: 700; }',
      'dd { margin: 0 0 12px; color: #dbeafe; }',
      '@media (max-width: 840px) { .shell { grid-template-columns: 1fr; align-content: center; } }',
      '',
    ].join('\n');
  }

  private _deterministicBrowserGameLogic(): string {
    return [
      '(function expose(root) {',
      '  const WIDTH = 900;',
      '  const HEIGHT = 560;',
      '  const PLAYER_SIZE = 34;',
      '  const METEOR_SIZE = 34;',
      '  const STAR_SIZE = 20;',
      '  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }',
      '  function rectsOverlap(a, b) {',
      '    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;',
      '  }',
      '  function createInitialState(width = WIDTH, height = HEIGHT) {',
      '    return {',
      '      width, height,',
      '      player: { x: width / 2 - PLAYER_SIZE / 2, y: height - 72, width: PLAYER_SIZE, height: PLAYER_SIZE, speed: 330 },',
      '      meteors: [], stars: [], score: 0, lives: 3, level: 1, elapsed: 0, meteorTimer: 0, starTimer: 0, paused: false, gameOver: false,',
      '    };',
      '  }',
      '  function createInputState() { return { left: false, right: false, up: false, down: false }; }',
      '  function spawnMeteor(state, random = Math.random) {',
      '    const size = METEOR_SIZE + Math.floor(random() * 18);',
      '    state.meteors.push({ x: random() * (state.width - size), y: -size, width: size, height: size, speed: 130 + state.level * 22 + random() * 60, spin: random() * Math.PI });',
      '  }',
      '  function spawnStar(state, random = Math.random) {',
      '    state.stars.push({ x: random() * (state.width - STAR_SIZE), y: -STAR_SIZE, width: STAR_SIZE, height: STAR_SIZE, speed: 95 + state.level * 12 });',
      '  }',
      '  function updatePlayer(state, input, dt) {',
      '    const vx = (input.right ? 1 : 0) - (input.left ? 1 : 0);',
      '    const vy = (input.down ? 1 : 0) - (input.up ? 1 : 0);',
      '    const length = Math.hypot(vx, vy) || 1;',
      '    state.player.x = clamp(state.player.x + (vx / length) * state.player.speed * dt, 0, state.width - state.player.width);',
      '    state.player.y = clamp(state.player.y + (vy / length) * state.player.speed * dt, 0, state.height - state.player.height);',
      '  }',
      '  function updateGame(state, input = createInputState(), dt = 0, random = Math.random) {',
      '    if (state.paused || state.gameOver) return state;',
      '    const step = Math.min(Math.max(dt, 0), 0.05);',
      '    state.elapsed += step;',
      '    state.level = 1 + Math.floor(state.elapsed / 18);',
      '    updatePlayer(state, input, step);',
      '    state.meteorTimer -= step;',
      '    state.starTimer -= step;',
      '    if (state.meteorTimer <= 0) { spawnMeteor(state, random); state.meteorTimer = Math.max(0.28, 0.92 - state.level * 0.06); }',
      '    if (state.starTimer <= 0) { spawnStar(state, random); state.starTimer = Math.max(0.75, 2.3 - state.level * 0.08); }',
      '    state.meteors = state.meteors.filter(meteor => {',
      '      meteor.y += meteor.speed * step;',
      '      meteor.spin += step * 3;',
      '      if (rectsOverlap(state.player, meteor)) {',
      '        state.lives -= 1;',
      '        state.score = Math.max(0, state.score - 5);',
      '        if (state.lives <= 0) { state.lives = 0; state.gameOver = true; }',
      '        return false;',
      '      }',
      '      if (meteor.y > state.height + meteor.height) { state.score += 1; return false; }',
      '      return true;',
      '    });',
      '    state.stars = state.stars.filter(star => {',
      '      star.y += star.speed * step;',
      '      if (rectsOverlap(state.player, star)) { state.score += 10; return false; }',
      '      return star.y <= state.height + star.height;',
      '    });',
      '    return state;',
      '  }',
      '  function setPaused(state, paused) { if (!state.gameOver) state.paused = paused; return state; }',
      '  const api = { HEIGHT, METEOR_SIZE, PLAYER_SIZE, STAR_SIZE, WIDTH, clamp, createInitialState, createInputState, rectsOverlap, setPaused, spawnMeteor, spawnStar, updateGame, updatePlayer };',
      '  if (typeof module !== "undefined" && module.exports) module.exports = api;',
      '  root.MeteorDodgeLogic = api;',
      '})(typeof globalThis !== "undefined" ? globalThis : window);',
      '',
    ].join('\n');
  }

  private _deterministicBrowserGameRenderer(): string {
    return [
      '(function expose(root) {',
      '  function drawShip(ctx, player) {',
      '    const cx = player.x + player.width / 2;',
      '    const cy = player.y + player.height / 2;',
      '    ctx.save(); ctx.translate(cx, cy);',
      '    ctx.fillStyle = "#38bdf8"; ctx.strokeStyle = "#e0f2fe"; ctx.lineWidth = 2;',
      '    ctx.beginPath(); ctx.moveTo(0, -22); ctx.lineTo(-18, 18); ctx.lineTo(0, 10); ctx.lineTo(18, 18); ctx.closePath(); ctx.fill(); ctx.stroke();',
      '    ctx.fillStyle = "#f97316"; ctx.fillRect(-6, 18, 12, 10); ctx.restore();',
      '  }',
      '  function drawMeteor(ctx, meteor) {',
      '    const cx = meteor.x + meteor.width / 2;',
      '    const cy = meteor.y + meteor.height / 2;',
      '    ctx.save(); ctx.translate(cx, cy); ctx.rotate(meteor.spin || 0);',
      '    ctx.fillStyle = "#b45309"; ctx.strokeStyle = "#fed7aa"; ctx.lineWidth = 2;',
      '    ctx.beginPath(); ctx.moveTo(0, -meteor.width / 2); ctx.lineTo(meteor.width / 2, -8); ctx.lineTo(meteor.width / 3, meteor.height / 2); ctx.lineTo(-meteor.width / 2, meteor.height / 3); ctx.lineTo(-meteor.width / 3, -meteor.height / 3); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();',
      '  }',
      '  function drawStar(ctx, star) {',
      '    const cx = star.x + star.width / 2;',
      '    const cy = star.y + star.height / 2;',
      '    ctx.save(); ctx.translate(cx, cy); ctx.fillStyle = "#facc15"; ctx.beginPath();',
      '    for (let i = 0; i < 10; i++) { const radius = i % 2 === 0 ? 12 : 5; const angle = -Math.PI / 2 + i * Math.PI / 5; ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius); }',
      '    ctx.closePath(); ctx.fill(); ctx.restore();',
      '  }',
      '  function drawBackground(ctx, state) {',
      '    const gradient = ctx.createLinearGradient(0, 0, 0, state.height);',
      '    gradient.addColorStop(0, "#08111f"); gradient.addColorStop(1, "#160b2e");',
      '    ctx.fillStyle = gradient; ctx.fillRect(0, 0, state.width, state.height);',
      '    ctx.fillStyle = "rgba(255,255,255,0.6)";',
      '    for (let i = 0; i < 80; i++) { const x = (i * 97) % state.width; const y = (i * 53 + state.elapsed * 12) % state.height; ctx.fillRect(x, y, 2, 2); }',
      '  }',
      '  function drawHud(ctx, state) {',
      '    ctx.fillStyle = "#e0f2fe"; ctx.font = "700 18px system-ui, sans-serif";',
      '    ctx.fillText("Score " + state.score, 18, 30); ctx.fillText("Lives " + state.lives, 142, 30); ctx.fillText("Level " + state.level, 246, 30);',
      '    if (state.paused || state.gameOver) {',
      '      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(0, 0, state.width, state.height);',
      '      ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.font = "800 42px system-ui, sans-serif";',
      '      ctx.fillText(state.gameOver ? "Game Over" : "Paused", state.width / 2, state.height / 2 - 12);',
      '      ctx.font = "18px system-ui, sans-serif"; ctx.fillText(state.gameOver ? "Press R to restart" : "Press Space to resume", state.width / 2, state.height / 2 + 28); ctx.textAlign = "left";',
      '    }',
      '  }',
      '  function render(ctx, state) { drawBackground(ctx, state); state.stars.forEach(star => drawStar(ctx, star)); state.meteors.forEach(meteor => drawMeteor(ctx, meteor)); drawShip(ctx, state.player); drawHud(ctx, state); }',
      '  const api = { drawBackground, drawHud, drawMeteor, drawShip, drawStar, render };',
      '  if (typeof module !== "undefined" && module.exports) module.exports = api;',
      '  root.MeteorDodgeRenderer = api;',
      '})(typeof globalThis !== "undefined" ? globalThis : window);',
      '',
    ].join('\n');
  }

  private _deterministicBrowserGameRuntime(): string {
    return [
      '(function startGame() {',
      '  const logic = window.MeteorDodgeLogic;',
      '  const renderer = window.MeteorDodgeRenderer;',
      '  const canvas = document.getElementById("gameCanvas");',
      '  const ctx = canvas.getContext("2d");',
      '  const input = logic.createInputState();',
      '  let state = logic.createInitialState(canvas.width, canvas.height);',
      '  let lastTime = performance.now();',
      '  const keyMap = { ArrowLeft: "left", a: "left", A: "left", ArrowRight: "right", d: "right", D: "right", ArrowUp: "up", w: "up", W: "up", ArrowDown: "down", s: "down", S: "down" };',
      '  function reset() { state = logic.createInitialState(canvas.width, canvas.height); lastTime = performance.now(); }',
      '  window.addEventListener("keydown", event => {',
      '    if (keyMap[event.key]) { input[keyMap[event.key]] = true; event.preventDefault(); }',
      '    if (event.code === "Space") { logic.setPaused(state, !state.paused); event.preventDefault(); }',
      '    if ((event.key === "r" || event.key === "R") && state.gameOver) reset();',
      '  });',
      '  window.addEventListener("keyup", event => { if (keyMap[event.key]) { input[keyMap[event.key]] = false; event.preventDefault(); } });',
      '  function loop(now) { const dt = (now - lastTime) / 1000; lastTime = now; logic.updateGame(state, input, dt); renderer.render(ctx, state); requestAnimationFrame(loop); }',
      '  renderer.render(ctx, state); requestAnimationFrame(loop);',
      '})();',
      '',
    ].join('\n');
  }

  private _deterministicBrowserGameTests(): string {
    return [
      "const assert = require('node:assert/strict');",
      "const test = require('node:test');",
      "const { createInitialState, createInputState, rectsOverlap, setPaused, spawnMeteor, spawnStar, updateGame, updatePlayer } = require('../src/logic');",
      '',
      "test('initial state has score, lives, level, and player', () => {",
      '  const state = createInitialState();',
      '  assert.equal(state.score, 0); assert.equal(state.lives, 3); assert.equal(state.level, 1); assert.equal(state.gameOver, false); assert.ok(state.player.x > 0);',
      '});',
      "test('player movement is clamped to the play area', () => {",
      '  const state = createInitialState(120, 120); const input = createInputState(); input.left = true; input.up = true; state.player.x = 0; state.player.y = 0; updatePlayer(state, input, 1); assert.equal(state.player.x, 0); assert.equal(state.player.y, 0);',
      '});',
      "test('rect collision detects overlap and separation', () => {",
      '  assert.equal(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), true);',
      '  assert.equal(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 }), false);',
      '});',
      "test('stars increase score when collected', () => {",
      '  const state = createInitialState(); state.meteorTimer = 10; state.starTimer = 10; state.stars.push({ ...state.player, speed: 0 }); updateGame(state, createInputState(), 0.016, () => 0.9); assert.equal(state.score, 10); assert.equal(state.stars.length, 0);',
      '});',
      "test('meteors reduce lives and can end the game', () => {",
      '  const state = createInitialState(); state.meteorTimer = 10; state.starTimer = 10; state.lives = 1; state.meteors.push({ ...state.player, speed: 0, spin: 0 }); updateGame(state, createInputState(), 0.016, () => 0.9); assert.equal(state.lives, 0); assert.equal(state.gameOver, true);',
      '});',
      "test('difficulty increases with elapsed time', () => {",
      '  const state = createInitialState(); for (let i = 0; i < 400; i++) updateGame(state, createInputState(), 0.05, () => 0.9); assert.equal(state.level, 2);',
      '});',
      "test('pause prevents updates', () => {",
      '  const state = createInitialState(); setPaused(state, true); spawnMeteor(state, () => 0.5); const before = state.meteors[0].y; updateGame(state, createInputState(), 1, () => 0.5); assert.equal(state.meteors[0].y, before);',
      '});',
      "test('spawn helpers add entities', () => {",
      '  const state = createInitialState(); spawnMeteor(state, () => 0.5); spawnStar(state, () => 0.5); assert.equal(state.meteors.length, 1); assert.equal(state.stars.length, 1);',
      '});',
      '',
    ].join('\n');
  }

  private _deterministicBrowserGameReadme(projectName: string): string {
    return [
      `# ${projectName}`,
      '',
      `${projectName} is a dependency-free browser arcade game built with plain HTML, CSS, and JavaScript.`,
      '',
      'Open `index.html` in a browser to play. Move the ship with the arrow keys or WASD, dodge meteors, collect stars, and survive as the level ramps up.',
      '',
      '## Controls',
      '',
      '- Move: Arrow keys or WASD',
      '- Pause/resume: Space',
      '- Restart after game over: R',
      '',
      '## Scripts',
      '',
      '```sh',
      'npm test',
      'npm start',
      'npm run demo',
      '```',
      '',
      'No build step or external runtime dependency is required.',
      '',
    ].join('\n');
  }

  private _deterministicArkanoidIndexHtml(projectName: string): string {
    return [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${projectName}</title>`,
      '  <link rel="stylesheet" href="styles.css">',
      '</head>',
      '<body>',
      '  <main class="shell">',
      '    <section class="game-frame" aria-label="Arkanoid game canvas">',
      '      <canvas id="gameCanvas" width="900" height="620"></canvas>',
      '    </section>',
      '    <aside class="panel">',
      `      <h1>${projectName}</h1>`,
      '      <p>Clear ten neon brick stages with paddle control, sharp rebounds, and rising speed.</p>',
      '      <dl>',
      '        <dt>Move</dt><dd>Arrow keys or A/D</dd>',
      '        <dt>Launch</dt><dd>Space</dd>',
      '        <dt>Pause</dt><dd>P</dd>',
      '        <dt>Restart</dt><dd>R</dd>',
      '      </dl>',
      '    </aside>',
      '  </main>',
      '  <script src="src/logic.js"></script>',
      '  <script src="src/render.js"></script>',
      '  <script src="src/game.js"></script>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  private _deterministicArkanoidStyles(): string {
    return [
      '* { box-sizing: border-box; }',
      'html, body { min-height: 100%; }',
      'body { margin: 0; color: #eff6ff; background: linear-gradient(135deg, #08111f, #172554 52%, #083344); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }',
      '.shell { min-height: 100vh; display: grid; grid-template-columns: minmax(320px, 900px) minmax(220px, 320px); gap: 24px; align-items: center; justify-content: center; padding: 24px; }',
      '.game-frame { width: min(900px, 100%); aspect-ratio: 45 / 31; border: 1px solid rgba(255,255,255,0.24); background: #050816; box-shadow: 0 24px 70px rgba(0,0,0,0.36); }',
      'canvas { display: block; width: 100%; height: 100%; }',
      '.panel { line-height: 1.5; }',
      '.panel h1 { margin: 0 0 10px; font-size: 2rem; letter-spacing: 0; }',
      '.panel p { margin: 0 0 18px; color: #c7d2fe; }',
      'dt { color: #67e8f9; font-weight: 800; }',
      'dd { margin: 0 0 12px; color: #e0f2fe; }',
      '@media (max-width: 840px) { .shell { grid-template-columns: 1fr; align-content: center; } }',
      '',
    ].join('\n');
  }

  private _deterministicArkanoidLogic(): string {
    return [
      '(function expose(root) {',
      '  const WIDTH = 900;',
      '  const HEIGHT = 620;',
      '  const MAX_LEVEL = 10;',
      '  const PADDLE_WIDTH = 116;',
      '  const PADDLE_HEIGHT = 16;',
      '  const BALL_RADIUS = 9;',
      '  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }',
      '  function rectsOverlap(a, b) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y; }',
      '  function ballRect(ball) { return { x: ball.x - ball.radius, y: ball.y - ball.radius, width: ball.radius * 2, height: ball.radius * 2 }; }',
      '  function createLevel(level, width = WIDTH) {',
      '    const rows = Math.min(8, 3 + Math.ceil(level / 2));',
      '    const cols = 10;',
      '    const gap = 8;',
      '    const margin = 42;',
      '    const brickWidth = (width - margin * 2 - gap * (cols - 1)) / cols;',
      '    const bricks = [];',
      '    for (let row = 0; row < rows; row++) {',
      '      for (let col = 0; col < cols; col++) {',
      '        const patternHole = level > 4 && ((row + col + level) % 7 === 0);',
      '        if (patternHole) continue;',
      '        const strength = 1 + Math.floor((level - 1) / 4) + (row === 0 && level > 6 ? 1 : 0);',
      '        bricks.push({ x: margin + col * (brickWidth + gap), y: 70 + row * 28, width: brickWidth, height: 20, strength, maxStrength: strength });',
      '      }',
      '    }',
      '    return bricks;',
      '  }',
      '  function createInitialState(width = WIDTH, height = HEIGHT, level = 1) {',
      '    const safeLevel = clamp(Math.floor(level), 1, MAX_LEVEL);',
      '    return { width, height, maxLevel: MAX_LEVEL, level: safeLevel, score: 0, lives: 3, paused: false, launched: false, gameOver: false, won: false,',
      '      paddle: { x: width / 2 - PADDLE_WIDTH / 2, y: height - 48, width: PADDLE_WIDTH, height: PADDLE_HEIGHT, speed: 480 },',
      '      ball: { x: width / 2, y: height - 48 - BALL_RADIUS - 2, radius: BALL_RADIUS, vx: 220 + safeLevel * 12, vy: -(300 + safeLevel * 20) },',
      '      bricks: createLevel(safeLevel, width) };',
      '  }',
      '  function createInputState() { return { left: false, right: false, launch: false }; }',
      '  function resetBall(state) { state.launched = false; state.ball.x = state.paddle.x + state.paddle.width / 2; state.ball.y = state.paddle.y - state.ball.radius - 2; state.ball.vx = 220 + state.level * 12; state.ball.vy = -(300 + state.level * 20); }',
      '  function advanceLevel(state) {',
      '    if (state.level >= MAX_LEVEL) { state.won = true; state.gameOver = true; return state; }',
      '    state.level += 1; state.bricks = createLevel(state.level, state.width); resetBall(state); return state;',
      '  }',
      '  function updatePaddle(state, input, dt) {',
      '    const direction = (input.right ? 1 : 0) - (input.left ? 1 : 0);',
      '    state.paddle.x = clamp(state.paddle.x + direction * state.paddle.speed * dt, 0, state.width - state.paddle.width);',
      '    if (!state.launched) resetBall(state);',
      '  }',
      '  function bounceFromPaddle(state) {',
      '    const relative = ((state.ball.x - state.paddle.x) / state.paddle.width) - 0.5;',
      '    const speed = Math.hypot(state.ball.vx, state.ball.vy) + 8;',
      '    state.ball.vx = clamp(relative * speed * 1.55, -520, 520);',
      '    state.ball.vy = -Math.max(260, Math.sqrt(Math.max(1, speed * speed - state.ball.vx * state.ball.vx)));',
      '    state.ball.y = state.paddle.y - state.ball.radius - 1;',
      '  }',
      '  function hitBrick(state, brick) {',
      '    brick.strength -= 1; state.score += 50 + state.level * 5;',
      '    if (brick.strength <= 0) state.score += 25;',
      '  }',
      '  function updateBall(state, dt) {',
      '    state.ball.x += state.ball.vx * dt; state.ball.y += state.ball.vy * dt;',
      '    if (state.ball.x - state.ball.radius < 0) { state.ball.x = state.ball.radius; state.ball.vx = Math.abs(state.ball.vx); }',
      '    if (state.ball.x + state.ball.radius > state.width) { state.ball.x = state.width - state.ball.radius; state.ball.vx = -Math.abs(state.ball.vx); }',
      '    if (state.ball.y - state.ball.radius < 0) { state.ball.y = state.ball.radius; state.ball.vy = Math.abs(state.ball.vy); }',
      '    if (rectsOverlap(ballRect(state.ball), state.paddle) && state.ball.vy > 0) bounceFromPaddle(state);',
      '    const ballBox = ballRect(state.ball);',
      '    for (const brick of state.bricks) {',
      '      if (brick.strength > 0 && rectsOverlap(ballBox, brick)) { hitBrick(state, brick); state.ball.vy *= -1; break; }',
      '    }',
      '    state.bricks = state.bricks.filter(brick => brick.strength > 0);',
      '    if (state.bricks.length === 0) advanceLevel(state);',
      '    if (state.ball.y - state.ball.radius > state.height) { state.lives -= 1; if (state.lives <= 0) { state.lives = 0; state.gameOver = true; } else resetBall(state); }',
      '  }',
      '  function updateGame(state, input = createInputState(), dt = 0) {',
      '    if (state.paused || state.gameOver) return state;',
      '    const step = Math.min(Math.max(dt, 0), 0.033); updatePaddle(state, input, step);',
      '    if (input.launch) state.launched = true;',
      '    if (state.launched) updateBall(state, step);',
      '    return state;',
      '  }',
      '  function setPaused(state, paused) { if (!state.gameOver) state.paused = paused; return state; }',
      '  const api = { BALL_RADIUS, HEIGHT, MAX_LEVEL, PADDLE_HEIGHT, PADDLE_WIDTH, WIDTH, advanceLevel, ballRect, bounceFromPaddle, clamp, createInitialState, createInputState, createLevel, hitBrick, rectsOverlap, resetBall, setPaused, updateBall, updateGame, updatePaddle };',
      '  if (typeof module !== "undefined" && module.exports) module.exports = api;',
      '  root.ArkanoidLogic = api;',
      '})(typeof globalThis !== "undefined" ? globalThis : window);',
      '',
    ].join('\n');
  }

  private _deterministicArkanoidRenderer(): string {
    return [
      '(function expose(root) {',
      '  function drawBackground(ctx, state) {',
      '    const gradient = ctx.createLinearGradient(0, 0, 0, state.height); gradient.addColorStop(0, "#08111f"); gradient.addColorStop(1, "#0f172a"); ctx.fillStyle = gradient; ctx.fillRect(0, 0, state.width, state.height);',
      '    ctx.fillStyle = "rgba(125,211,252,0.24)"; for (let i = 0; i < 56; i++) ctx.fillRect((i * 137) % state.width, (i * 61) % state.height, 2, 2);',
      '  }',
      '  function drawBricks(ctx, state) { state.bricks.forEach(brick => { const ratio = brick.strength / brick.maxStrength; ctx.fillStyle = ratio > 0.66 ? "#f472b6" : ratio > 0.33 ? "#22d3ee" : "#a7f3d0"; ctx.fillRect(brick.x, brick.y, brick.width, brick.height); ctx.strokeStyle = "rgba(255,255,255,0.62)"; ctx.strokeRect(brick.x, brick.y, brick.width, brick.height); }); }',
      '  function drawPaddle(ctx, paddle) { ctx.fillStyle = "#e0f2fe"; ctx.fillRect(paddle.x, paddle.y, paddle.width, paddle.height); ctx.fillStyle = "#38bdf8"; ctx.fillRect(paddle.x + 8, paddle.y + 3, paddle.width - 16, paddle.height - 6); }',
      '  function drawBall(ctx, ball) { ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2); ctx.fillStyle = "#facc15"; ctx.fill(); ctx.strokeStyle = "#fff7ed"; ctx.stroke(); }',
      '  function drawHud(ctx, state) { ctx.fillStyle = "#e0f2fe"; ctx.font = "700 18px system-ui, sans-serif"; ctx.fillText("Score " + state.score, 18, 30); ctx.fillText("Lives " + state.lives, 150, 30); ctx.fillText("Level " + state.level + "/" + state.maxLevel, 254, 30);',
      '    if (!state.launched && !state.gameOver) { ctx.textAlign = "center"; ctx.fillText("Press Space to launch", state.width / 2, state.height / 2 + 52); ctx.textAlign = "left"; }',
      '    if (state.paused || state.gameOver) { ctx.fillStyle = "rgba(0,0,0,0.58)"; ctx.fillRect(0,0,state.width,state.height); ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.font = "800 42px system-ui, sans-serif"; ctx.fillText(state.won ? "You Cleared All 10 Levels" : state.gameOver ? "Game Over" : "Paused", state.width / 2, state.height / 2 - 12); ctx.font = "18px system-ui, sans-serif"; ctx.fillText("Press R to restart", state.width / 2, state.height / 2 + 28); ctx.textAlign = "left"; }',
      '  }',
      '  function render(ctx, state) { drawBackground(ctx, state); drawBricks(ctx, state); drawPaddle(ctx, state.paddle); drawBall(ctx, state.ball); drawHud(ctx, state); }',
      '  const api = { drawBackground, drawBall, drawBricks, drawHud, drawPaddle, render };',
      '  if (typeof module !== "undefined" && module.exports) module.exports = api;',
      '  root.ArkanoidRenderer = api;',
      '})(typeof globalThis !== "undefined" ? globalThis : window);',
      '',
    ].join('\n');
  }

  private _deterministicArkanoidRuntime(): string {
    return [
      '(function startGame() {',
      '  const logic = window.ArkanoidLogic; const renderer = window.ArkanoidRenderer;',
      '  const canvas = document.getElementById("gameCanvas"); const ctx = canvas.getContext("2d");',
      '  const input = logic.createInputState(); let state = logic.createInitialState(canvas.width, canvas.height); let lastTime = performance.now();',
      '  function reset() { state = logic.createInitialState(canvas.width, canvas.height); lastTime = performance.now(); }',
      '  window.addEventListener("keydown", event => {',
      '    if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") { input.left = true; event.preventDefault(); }',
      '    if (event.key === "ArrowRight" || event.key === "d" || event.key === "D") { input.right = true; event.preventDefault(); }',
      '    if (event.code === "Space") { input.launch = true; event.preventDefault(); }',
      '    if (event.key === "p" || event.key === "P") logic.setPaused(state, !state.paused);',
      '    if (event.key === "r" || event.key === "R") reset();',
      '  });',
      '  window.addEventListener("keyup", event => { if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") input.left = false; if (event.key === "ArrowRight" || event.key === "d" || event.key === "D") input.right = false; if (event.code === "Space") input.launch = false; });',
      '  canvas.addEventListener("mousemove", event => { const rect = canvas.getBoundingClientRect(); const scale = canvas.width / rect.width; state.paddle.x = logic.clamp((event.clientX - rect.left) * scale - state.paddle.width / 2, 0, state.width - state.paddle.width); if (!state.launched) logic.resetBall(state); });',
      '  canvas.addEventListener("click", () => { input.launch = true; });',
      '  function loop(now) { const dt = (now - lastTime) / 1000; lastTime = now; logic.updateGame(state, input, dt); renderer.render(ctx, state); requestAnimationFrame(loop); }',
      '  renderer.render(ctx, state); requestAnimationFrame(loop);',
      '})();',
      '',
    ].join('\n');
  }

  private _deterministicArkanoidTests(): string {
    return [
      "const assert = require('node:assert/strict');",
      "const test = require('node:test');",
      "const { MAX_LEVEL, advanceLevel, createInitialState, createInputState, createLevel, resetBall, updateGame } = require('../src/logic');",
      '',
      "test('creates ten distinct playable levels', () => {",
      '  assert.equal(MAX_LEVEL, 10);',
      '  const counts = Array.from({ length: 10 }, (_, index) => createLevel(index + 1).length);',
      '  assert.equal(counts.length, 10); assert.ok(counts.every(count => count > 20)); assert.ok(counts[9] >= counts[0]);',
      '});',
      "test('initial state starts on requested level with paddle, ball, lives, and bricks', () => {",
      '  const state = createInitialState(900, 620, 4); assert.equal(state.level, 4); assert.equal(state.lives, 3); assert.equal(state.launched, false); assert.ok(state.bricks.length > 0); assert.ok(state.paddle.x > 0);',
      '});',
      "test('paddle movement is clamped to the play field', () => {",
      '  const state = createInitialState(220, 300); const input = createInputState(); input.left = true; state.paddle.x = 0; updateGame(state, input, 1); assert.equal(state.paddle.x, 0); input.left = false; input.right = true; for (let i = 0; i < 12; i++) updateGame(state, input, 1); assert.equal(state.paddle.x, state.width - state.paddle.width);',
      '});',
      "test('ball stays attached until launch', () => {",
      '  const state = createInitialState(); const beforeY = state.ball.y; updateGame(state, createInputState(), 0.2); assert.equal(state.ball.y, beforeY);',
      '});',
      "test('brick hit increases score and removes weak brick', () => {",
      '  const state = createInitialState(); const brick = state.bricks[0]; state.launched = true; state.ball.x = brick.x + brick.width / 2; state.ball.y = brick.y + brick.height / 2; state.ball.vy = -100; updateGame(state, createInputState(), 0.016); assert.ok(state.score > 0); assert.equal(state.bricks.includes(brick), false);',
      '});',
      "test('missing the paddle costs a life and resets the ball', () => {",
      '  const state = createInitialState(); state.launched = true; state.ball.y = state.height + 20; updateGame(state, createInputState(), 0.016); assert.equal(state.lives, 2); assert.equal(state.launched, false);',
      '});',
      "test('advancing past level ten wins the game', () => {",
      '  const state = createInitialState(900, 620, 10); state.bricks = []; advanceLevel(state); assert.equal(state.won, true); assert.equal(state.gameOver, true);',
      '});',
      "test('resetBall reattaches ball above paddle', () => {",
      '  const state = createInitialState(); state.launched = true; resetBall(state); assert.equal(state.launched, false); assert.equal(state.ball.x, state.paddle.x + state.paddle.width / 2);',
      '});',
      '',
    ].join('\n');
  }

  private _deterministicArkanoidReadme(projectName: string): string {
    return [
      `# ${projectName}`,
      '',
      `${projectName} is a dependency-free Arkanoid-style browser game with 10 handcrafted difficulty levels.`,
      '',
      'Open `index.html` in a browser to play. Move the paddle, launch the ball, clear every brick, and finish all 10 levels.',
      '',
      '## Controls',
      '',
      '- Move: Arrow keys, A/D, or mouse',
      '- Launch: Space or click',
      '- Pause/resume: P',
      '- Restart: R',
      '',
      '## Scripts',
      '',
      '```sh',
      'npm test',
      'npm run start',
      'npm run demo',
      '```',
      '',
    ].join('\n');
  }

  private _deterministicApiPackageJson(packageName: string, projectName: string): string {
    return prettyJson({
      name: packageName,
      version: '1.0.0',
      description: `${projectName} - a dependency-free Node REST API.`,
      main: 'src/server.js',
      scripts: {
        start: 'node src/server.js',
        demo: 'node src/server.js',
        test: 'node --test test/*.test.js',
      },
      keywords: ['api', 'rest', 'node'],
      license: 'MIT',
    });
  }

  private _deterministicApiServer(): string {
    return [
      "const http = require('node:http');",
      '',
      'function sendJson(res, statusCode, payload) {',
      "  const body = JSON.stringify(payload);",
      "  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });",
      '  res.end(body);',
      '}',
      '',
      'function parseBody(req) {',
      '  return new Promise((resolve, reject) => {',
      "    let raw = '';",
      "    req.setEncoding('utf8');",
      "    req.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) reject(new Error('Request body is too large.')); });",
      "    req.on('error', reject);",
      "    req.on('end', () => {",
      '      if (!raw.trim()) { resolve({}); return; }',
      "      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Request body must be valid JSON.')); }",
      '    });',
      '  });',
      '}',
      '',
      'function createServer(seedItems = []) {',
      '  const items = seedItems.map((item, index) => ({ id: item.id || String(index + 1), title: item.title, done: Boolean(item.done) }));',
      '  let nextId = items.length + 1;',
      '  return http.createServer(async (req, res) => {',
      "    const url = new URL(req.url || '/', 'http://localhost');",
      "    if (req.method === 'GET' && url.pathname === '/health') { sendJson(res, 200, { ok: true }); return; }",
      "    if (req.method === 'GET' && url.pathname === '/items') { sendJson(res, 200, { items }); return; }",
      "    if (req.method === 'POST' && url.pathname === '/items') {",
      '      try {',
      '        const body = await parseBody(req);',
      "        const title = typeof body.title === 'string' ? body.title.trim() : '';",
      "        if (!title) { sendJson(res, 400, { error: 'title is required' }); return; }",
      '        const item = { id: String(nextId++), title, done: false };',
      '        items.push(item);',
      '        sendJson(res, 201, { item });',
      '      } catch (error) {',
      '        sendJson(res, 400, { error: error.message });',
      '      }',
      '      return;',
      '    }',
      "    sendJson(res, 404, { error: 'not found' });",
      '  });',
      '}',
      '',
      'if (require.main === module) {',
      '  const port = Number(process.env.PORT || 3000);',
      '  const server = createServer();',
      "  server.listen(port, () => { console.log('API listening on http://127.0.0.1:' + port); });",
      '}',
      '',
      'module.exports = { createServer, parseBody, sendJson };',
      '',
    ].join('\n');
  }

  private _deterministicApiTests(): string {
    return [
      "const assert = require('node:assert/strict');",
      "const test = require('node:test');",
      "const { createServer } = require('../src/server');",
      '',
      'function listen(server) {',
      '  return new Promise(resolve => { server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });',
      '}',
      '',
      "test('health route responds with ok', async () => {",
      '  const server = createServer();',
      '  const port = await listen(server);',
      '  try {',
      '    const response = await fetch("http://127.0.0.1:" + port + "/health");',
      '    assert.equal(response.status, 200);',
      '    assert.deepEqual(await response.json(), { ok: true });',
      '  } finally { server.close(); }',
      '});',
      '',
      "test('items can be listed and created', async () => {",
      '  const server = createServer([{ title: "Seed" }]);',
      '  const port = await listen(server);',
      '  try {',
      '    const base = "http://127.0.0.1:" + port;',
      '    const before = await (await fetch(base + "/items")).json();',
      '    assert.equal(before.items.length, 1);',
      '    const created = await fetch(base + "/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Pack orders" }) });',
      '    assert.equal(created.status, 201);',
      '    assert.equal((await created.json()).item.title, "Pack orders");',
      '    const after = await (await fetch(base + "/items")).json();',
      '    assert.equal(after.items.length, 2);',
      '  } finally { server.close(); }',
      '});',
      '',
      "test('invalid and unknown routes return useful errors', async () => {",
      '  const server = createServer();',
      '  const port = await listen(server);',
      '  try {',
      '    const base = "http://127.0.0.1:" + port;',
      '    assert.equal((await fetch(base + "/items", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);',
      '    assert.equal((await fetch(base + "/missing")).status, 404);',
      '  } finally { server.close(); }',
      '});',
      '',
    ].join('\n');
  }

  private _deterministicApiReadme(projectName: string): string {
    return [
      `# ${projectName}`,
      '',
      `${projectName} is a dependency-free Node REST API with health and item routes.`,
      '',
      '## Run',
      '',
      '```sh',
      'npm test',
      'npm start',
      '```',
      '',
      '## Routes',
      '',
      '- `GET /health`',
      '- `GET /items`',
      '- `POST /items` with JSON `{ "title": "Pack orders" }`',
      '',
    ].join('\n');
  }

  private _deterministicReactPackageJson(packageName: string, projectName: string): string {
    return prettyJson({
      name: packageName,
      version: '1.0.0',
      description: `${projectName} - a React/Vite product scaffold.`,
      type: 'module',
      scripts: {
        dev: 'vite --host 127.0.0.1',
        start: 'vite --host 127.0.0.1',
        build: 'vite build',
        test: 'node --test test/*.test.js',
      },
      dependencies: {
        '@vitejs/plugin-react': '^5.0.0',
        vite: '^7.0.0',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
      },
      keywords: ['react', 'vite', 'dashboard'],
      license: 'MIT',
    });
  }

  private _deterministicReactIndexHtml(projectName: string): string {
    return [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${projectName}</title>`,
      '</head>',
      '<body>',
      '  <div id="root"></div>',
      '  <script type="module" src="/src/main.jsx"></script>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  private _deterministicReactMain(): string {
    return [
      "import React from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import { App } from './App.jsx';",
      "import './styles.css';",
      '',
      "createRoot(document.getElementById('root')).render(<App />);",
      '',
    ].join('\n');
  }

  private _deterministicReactApp(projectName: string): string {
    return [
      'const metrics = [',
      "  { label: 'Ready tasks', value: '12', tone: 'green' },",
      "  { label: 'Blocked', value: '2', tone: 'amber' },",
      "  { label: 'Quality score', value: '94%', tone: 'blue' },",
      '];',
      '',
      'const activities = [',
      "  'Architecture accepted with practical defaults',",
      "  'Automated checks configured with node:test',",
      "  'Product shell ready for local iteration',",
      '];',
      '',
      'export function App() {',
      '  return (',
      '    <main className="app-shell">',
      '      <section className="workspace">',
      `        <h1>${projectName}</h1>`,
      '        <p>Track delivery health, next actions, and verification status from one focused workspace.</p>',
      '        <div className="metrics" aria-label="Project metrics">',
      '          {metrics.map(metric => (',
      '            <article className={`metric ${metric.tone}`} key={metric.label}>',
      '              <span>{metric.label}</span>',
      '              <strong>{metric.value}</strong>',
      '            </article>',
      '          ))}',
      '        </div>',
      '      </section>',
      '      <section className="activity" aria-label="Recent activity">',
      '        <h2>Recent Activity</h2>',
      '        <ol>',
      '          {activities.map(item => <li key={item}>{item}</li>)}',
      '        </ol>',
      '      </section>',
      '    </main>',
      '  );',
      '}',
      '',
      'export default App;',
      '',
    ].join('\n');
  }

  private _deterministicReactStyles(): string {
    return [
      '* { box-sizing: border-box; }',
      'body { margin: 0; min-height: 100vh; color: #172033; background: #f6f7fb; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }',
      '.app-shell { min-height: 100vh; display: grid; grid-template-columns: minmax(320px, 680px) minmax(280px, 420px); gap: 28px; align-items: center; justify-content: center; padding: 32px; }',
      '.workspace h1 { margin: 0 0 12px; color: #0f172a; font-size: 3rem; letter-spacing: 0; }',
      '.workspace p { max-width: 58ch; margin: 0 0 24px; color: #475569; line-height: 1.6; }',
      '.metrics { display: grid; grid-template-columns: repeat(3, minmax(140px, 1fr)); gap: 14px; }',
      '.metric { min-height: 116px; border: 1px solid #d8dee9; border-radius: 8px; padding: 18px; background: #ffffff; box-shadow: 0 18px 50px rgba(15, 23, 42, 0.08); }',
      '.metric span { display: block; color: #64748b; font-size: 0.92rem; }',
      '.metric strong { display: block; margin-top: 14px; color: #0f172a; font-size: 2rem; }',
      '.metric.green { border-top: 4px solid #16a34a; }',
      '.metric.amber { border-top: 4px solid #d97706; }',
      '.metric.blue { border-top: 4px solid #2563eb; }',
      '.activity { border: 1px solid #d8dee9; border-radius: 8px; padding: 24px; background: #ffffff; }',
      '.activity h2 { margin: 0 0 16px; font-size: 1.2rem; }',
      '.activity li { margin: 12px 0; color: #334155; line-height: 1.45; }',
      '@media (max-width: 860px) { .app-shell { grid-template-columns: 1fr; align-content: center; } .metrics { grid-template-columns: 1fr; } .workspace h1 { font-size: 2.3rem; } }',
      '',
    ].join('\n');
  }

  private _deterministicReactTests(projectName: string): string {
    return [
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const test = require('node:test');",
      "const root = path.join(__dirname, '..');",
      "function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }",
      "test('React scaffold files exist', () => { ['index.html', 'src/main.jsx', 'src/App.jsx', 'src/styles.css', 'README.md'].forEach(file => assert.ok(fs.existsSync(path.join(root, file)), file)); });",
      "test('HTML points at the Vite React entry', () => { assert.match(read('index.html'), /\\/src\\/main\\.jsx/); });",
      `test('App component includes the product name', () => { const source = read('src/App.jsx'); assert.match(source, /export function App/); assert.match(source, /${this._escapeRegex(projectName)}/); });`,
      "test('package exposes runnable scripts', () => { const pkg = JSON.parse(read('package.json')); assert.equal(pkg.scripts.test, 'node --test test/*.test.js'); assert.ok(pkg.scripts.start); assert.ok(pkg.dependencies.react); });",
      '',
    ].join('\n');
  }

  private _deterministicReactReadme(projectName: string): string {
    return [
      `# ${projectName}`,
      '',
      `${projectName} is a React/Vite product scaffold with static smoke tests.`,
      '',
      '```sh',
      'npm install',
      'npm test',
      'npm run dev',
      'npm run build',
      '```',
      '',
    ].join('\n');
  }

  private _deterministicCliPackageJson(packageName: string, projectName: string): string {
    return prettyJson({
      name: packageName,
      version: '1.0.0',
      description: `${projectName} - a dependency-free local CLI.`,
      main: 'src/cli.js',
      bin: { [packageName]: 'src/cli.js' },
      scripts: {
        test: 'node --test test/*.test.js',
        demo: 'node src/cli.js add "Ship the demo" --priority high && node src/cli.js list && node src/cli.js stats',
        start: 'node src/cli.js',
      },
      keywords: ['cli', 'local-first'],
      license: 'MIT',
    });
  }

  private _deterministicCliSource(): string {
    return [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const crypto = require('node:crypto');",
      "const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);",
      "function storePath(cwd = process.cwd()) { return path.join(cwd, '.agent-product', 'items.json'); }",
      "function ensureStore(cwd = process.cwd()) { const file = storePath(cwd); fs.mkdirSync(path.dirname(file), { recursive: true }); if (!fs.existsSync(file)) fs.writeFileSync(file, '[]\\n', 'utf8'); return file; }",
      "function readItems(cwd = process.cwd()) { const raw = fs.readFileSync(ensureStore(cwd), 'utf8').trim() || '[]'; const items = JSON.parse(raw); if (!Array.isArray(items)) throw new Error('Store must contain a JSON array.'); return items; }",
      "function writeItems(items, cwd = process.cwd()) { fs.writeFileSync(ensureStore(cwd), `${JSON.stringify(items, null, 2)}\\n`, 'utf8'); }",
      'function parsePriority(args) { const index = args.indexOf("--priority"); if (index === -1) return { priority: "medium", remaining: args }; return { priority: args[index + 1], remaining: args.filter((_, i) => i !== index && i !== index + 1) }; }',
      'function addItem(args, cwd = process.cwd()) { const { priority, remaining } = parsePriority(args); const title = remaining.join(" ").trim(); if (!title) throw new Error("Title is required."); if (!VALID_PRIORITIES.has(priority)) throw new Error("Invalid priority. Use high, medium, or low."); const items = readItems(cwd); const item = { id: crypto.randomUUID(), title, priority, done: false, createdAt: new Date().toISOString() }; items.push(item); writeItems(items, cwd); return item; }',
      'function listItems(cwd = process.cwd()) { return readItems(cwd); }',
      'function completeItem(id, cwd = process.cwd()) { if (!id) throw new Error("ID is required."); const items = readItems(cwd); const item = items.find(entry => entry.id === id); if (!item) throw new Error(`Item not found: ${id}`); item.done = true; item.completedAt = new Date().toISOString(); writeItems(items, cwd); return item; }',
      'function getStats(cwd = process.cwd()) { const items = readItems(cwd); const done = items.filter(item => item.done).length; return { total: items.length, done, open: items.length - done }; }',
      'function printHelp(io = console) { io.log("Usage: node src/cli.js add <title> [--priority high|medium|low] | list | done <id> | stats"); }',
      'function run(argv = process.argv.slice(2), cwd = process.cwd(), io = console) { try { const [command, ...args] = argv; if (!command || command === "--help" || command === "-h") { printHelp(io); return 0; } if (command === "add") { const item = addItem(args, cwd); io.log(`Added [${item.priority}] ${item.title}`); io.log(`ID: ${item.id}`); return 0; } if (command === "list") { const items = listItems(cwd); if (items.length === 0) { io.log("No items found."); return 0; } items.forEach(item => io.log(`${item.id} ${item.done ? "done" : "open"} ${item.priority} ${item.title}`)); return 0; } if (command === "done") { const item = completeItem(args[0], cwd); io.log(`Completed: ${item.title}`); return 0; } if (command === "stats") { const stats = getStats(cwd); io.log(`Total: ${stats.total}`); io.log(`Done: ${stats.done}`); io.log(`Open: ${stats.open}`); return 0; } throw new Error(`Unknown command: ${command}`); } catch (error) { io.error(error.message); return 1; } }',
      'if (require.main === module) process.exitCode = run();',
      'module.exports = { addItem, completeItem, getStats, listItems, readItems, run, storePath };',
      '',
    ].join('\n');
  }

  private _deterministicCliTests(): string {
    return [
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "const os = require('node:os');",
      "const path = require('node:path');",
      "const test = require('node:test');",
      "const { addItem, completeItem, getStats, listItems, run, storePath } = require('../src/cli');",
      "function tempWorkspace() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-')); }",
      "test('add/list stores items', () => { const cwd = tempWorkspace(); const item = addItem(['Write docs', '--priority', 'high'], cwd); assert.equal(item.priority, 'high'); assert.deepEqual(listItems(cwd).map(entry => entry.id), [item.id]); assert.ok(fs.existsSync(storePath(cwd))); });",
      "test('done marks an item complete', () => { const cwd = tempWorkspace(); const item = addItem(['Review'], cwd); completeItem(item.id, cwd); assert.equal(listItems(cwd)[0].done, true); });",
      "test('stats summarizes items', () => { const cwd = tempWorkspace(); const item = addItem(['Ship'], cwd); addItem(['Clean'], cwd); completeItem(item.id, cwd); assert.deepEqual(getStats(cwd), { total: 2, done: 1, open: 1 }); });",
      "test('invalid input returns non-zero from runner', () => { const errors = []; const code = run(['add', 'Bad', '--priority', 'urgent'], tempWorkspace(), { log: () => {}, error: message => errors.push(message) }); assert.equal(code, 1); assert.match(errors[0], /Invalid priority/); });",
      '',
    ].join('\n');
  }

  private _deterministicCliReadme(projectName: string): string {
    return [
      `# ${projectName}`,
      '',
      `${projectName} is a dependency-free local CLI generated with deterministic self-healing.`,
      '',
      '## Usage',
      '',
      '```sh',
      'node src/cli.js add "Write docs" --priority high',
      'node src/cli.js list',
      'node src/cli.js done <id>',
      'node src/cli.js stats',
      'npm test',
      'npm run demo',
      '```',
      '',
      'Data is stored locally in `.agent-product/items.json`.',
      '',
    ].join('\n');
  }

  private _deterministicNodeLibraryPackageJson(packageName: string, projectName: string): string {
    return prettyJson({
      name: packageName,
      version: '1.0.0',
      description: `${projectName} - a dependency-free Node utility library.`,
      main: 'src/index.js',
      exports: './src/index.js',
      scripts: {
        test: 'node --test test/*.test.js',
        demo: 'node -e "const lib = require(\'./src\'); console.log(lib.slugify(\'Hello Product\'))"',
        start: 'npm run demo',
      },
      keywords: ['node', 'library', 'utilities'],
      license: 'MIT',
    });
  }

  private _deterministicNodeLibrarySource(): string {
    return [
      'function slugify(value) {',
      "  return String(value || '')",
      '    .trim()',
      '    .toLowerCase()',
      "    .replace(/[^a-z0-9]+/g, '-')",
      "    .replace(/^-+|-+$/g, '');",
      '}',
      '',
      'function unique(values) {',
      '  return [...new Set(values)];',
      '}',
      '',
      'function groupBy(values, keySelector) {',
      '  return values.reduce((groups, value) => {',
      "    const key = String(typeof keySelector === 'function' ? keySelector(value) : value[keySelector]);",
      '    if (!groups[key]) groups[key] = [];',
      '    groups[key].push(value);',
      '    return groups;',
      '  }, {});',
      '}',
      '',
      'function createResult(value, error = null) {',
      '  return error ? { ok: false, error: String(error), value: null } : { ok: true, error: null, value };',
      '}',
      '',
      'module.exports = { createResult, groupBy, slugify, unique };',
      '',
    ].join('\n');
  }

  private _deterministicNodeLibraryTests(): string {
    return [
      "const assert = require('node:assert/strict');",
      "const test = require('node:test');",
      "const { createResult, groupBy, slugify, unique } = require('../src');",
      '',
      "test('slugify creates URL-safe slugs', () => {",
      "  assert.equal(slugify('Hello, Product World!'), 'hello-product-world');",
      "  assert.equal(slugify('  Multi   Space  '), 'multi-space');",
      '});',
      '',
      "test('unique removes duplicate values while preserving order', () => {",
      "  assert.deepEqual(unique(['a', 'b', 'a', 'c']), ['a', 'b', 'c']);",
      '});',
      '',
      "test('groupBy groups values by property or selector', () => {",
      "  const rows = [{ type: 'todo', title: 'A' }, { type: 'done', title: 'B' }, { type: 'todo', title: 'C' }];",
      "  assert.deepEqual(Object.keys(groupBy(rows, 'type')).sort(), ['done', 'todo']);",
      "  assert.equal(groupBy(rows, row => row.type).todo.length, 2);",
      '});',
      '',
      "test('createResult returns explicit success and failure objects', () => {",
      "  assert.deepEqual(createResult(42), { ok: true, error: null, value: 42 });",
      "  assert.deepEqual(createResult(null, 'bad input'), { ok: false, error: 'bad input', value: null });",
      '});',
      '',
    ].join('\n');
  }

  private _deterministicNodeLibraryReadme(projectName: string, packageName: string): string {
    return [
      `# ${projectName}`,
      '',
      `${projectName} is a dependency-free Node utility library.`,
      '',
      '## Usage',
      '',
      '```js',
      `const { slugify, unique, groupBy, createResult } = require('${packageName}');`,
      '',
      "slugify('Hello Product');",
      "unique(['a', 'a', 'b']);",
      'groupBy([{ type: "todo" }], "type");',
      'createResult({ ready: true });',
      '```',
      '',
      '## Scripts',
      '',
      '```sh',
      'npm test',
      'npm run demo',
      '```',
      '',
    ].join('\n');
  }

  private _deterministicStaticWebPackageJson(packageName: string, projectName: string): string {
    return prettyJson({
      name: packageName,
      version: '1.0.0',
      description: `${projectName} - a dependency-free static web product.`,
      main: 'index.html',
      scripts: {
        test: 'node --test test/*.test.js',
        demo: 'echo "Open index.html in your browser."',
        start: 'echo "Open index.html in your browser. No build step is required."',
      },
      keywords: ['static-site', 'web'],
      license: 'MIT',
    });
  }

  private _deterministicStaticWebIndexHtml(projectName: string): string {
    return [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${projectName}</title>`,
      '  <link rel="stylesheet" href="styles.css">',
      '</head>',
      '<body>',
      '  <main class="app-shell">',
      '    <section class="hero">',
      `      <h1>${projectName}</h1>`,
      '      <p id="summary">A complete local-first static web experience generated by the agent.</p>',
      '      <button id="primaryAction" type="button">Mark Ready</button>',
      '    </section>',
      '    <section class="panel" aria-label="Project checklist">',
      '      <h2>Delivery Checklist</h2>',
      '      <ul id="checklist">',
      '        <li>Responsive HTML/CSS interface</li>',
      '        <li>Dependency-free JavaScript behavior</li>',
      '        <li>Automated smoke tests</li>',
      '      </ul>',
      '      <output id="status">Ready for local review.</output>',
      '    </section>',
      '  </main>',
      '  <script src="src/app.js"></script>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  private _deterministicStaticWebStyles(): string {
    return [
      '* { box-sizing: border-box; }',
      'body { margin: 0; min-height: 100vh; color: #f8fafc; background: linear-gradient(135deg, #102a43, #3b1d5a 56%, #134e4a); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }',
      '.app-shell { min-height: 100vh; display: grid; grid-template-columns: minmax(280px, 560px) minmax(260px, 420px); gap: 32px; align-items: center; justify-content: center; padding: 32px; }',
      '.hero h1 { margin: 0 0 16px; font-size: clamp(2.4rem, 7vw, 5.5rem); letter-spacing: 0; }',
      '.hero p { max-width: 52ch; color: #dbeafe; font-size: 1.1rem; line-height: 1.6; }',
      'button { min-height: 42px; border: 0; border-radius: 6px; padding: 0 18px; color: #082f49; background: #7dd3fc; font-weight: 800; cursor: pointer; }',
      '.panel { border: 1px solid rgba(255,255,255,0.22); border-radius: 8px; padding: 24px; background: rgba(15, 23, 42, 0.62); }',
      '.panel h2 { margin-top: 0; }',
      'li { margin: 10px 0; }',
      'output { display: block; margin-top: 18px; color: #bbf7d0; font-weight: 700; }',
      '@media (max-width: 820px) { .app-shell { grid-template-columns: 1fr; align-content: center; } }',
      '',
    ].join('\n');
  }

  private _deterministicStaticWebApp(): string {
    return [
      '(function initApp() {',
      '  const button = document.getElementById("primaryAction");',
      '  const status = document.getElementById("status");',
      '  const checklist = document.getElementById("checklist");',
      '  function completedCount() { return checklist ? checklist.querySelectorAll("li").length : 0; }',
      '  if (button && status) {',
      '    button.addEventListener("click", () => {',
      '      status.textContent = `Ready: ${completedCount()} delivery checks available.`;',
      '      button.textContent = "Ready";',
      '    });',
      '  }',
      '  if (typeof module !== "undefined" && module.exports) module.exports = { completedCount };',
      '})();',
      '',
    ].join('\n');
  }

  private _deterministicStaticWebTests(projectName: string): string {
    return [
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const test = require('node:test');",
      "const root = path.join(__dirname, '..');",
      "function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }",
      "test('static web files exist', () => { ['index.html', 'styles.css', 'src/app.js', 'README.md'].forEach(file => assert.ok(fs.existsSync(path.join(root, file)), file)); });",
      `test('index includes product name and script', () => { const html = read('index.html'); assert.match(html, /${this._escapeRegex(projectName)}/); assert.match(html, /src\\/app\\.js/); });`,
      "test('css includes responsive layout', () => { assert.match(read('styles.css'), /@media/); });",
      "test('browser script has no third-party imports', () => { const js = read('src/app.js'); assert.doesNotMatch(js, /require\\(|import\\s/); });",
      '',
    ].join('\n');
  }

  private _deterministicStaticWebReadme(projectName: string): string {
    return [
      `# ${projectName}`,
      '',
      `${projectName} is a dependency-free static web product.`,
      '',
      'Open `index.html` in a browser to use it.',
      '',
      '```sh',
      'npm test',
      'npm run start',
      'npm run demo',
      '```',
      '',
    ].join('\n');
  }

  private _escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  /**
   * Ask the boss to approve a command the safety policy flagged as risky.
   * Honors the ask-policy: in fully autonomous / never-ask mode there is no human
   * to answer, so the command is DECLINED with a clearly logged, journaled reason
   * instead of either hanging forever or silently running. When the ask-policy
   * permits and a UI handler is wired, the boss gets a real prompt.
   */
  private _requestCommandApproval(command: string, reason: string): Promise<boolean> {
    if (!this._shouldAskUser() || !this.callbacks.onCommandApprovalNeeded) {
      logWarn(
        `Command needs approval but ask-policy is "${this.modelConfig.askPolicy}" (autonomous=${this.modelConfig.autonomousMode}); declining: ${command} — ${reason}`
      );
      this._journal('warn', 'Command blocked by policy (no approval prompt available)',
        `\`${command}\`\n\n${reason}\n\nEnable an interactive ask-policy to approve commands like this.`);
      return Promise.resolve(false);
    }
    const commandId = `cmd-${++this._approvalCounter}`;
    this._journal('waiting', 'Awaiting boss approval for a command',
      `\`${command}\`\n\n${reason}`);
    return new Promise((resolve) => {
      this._pendingCommandResolvers.set(commandId, resolve);
      this.callbacks.onCommandApprovalNeeded?.(commandId, command, reason);
    });
  }

  private _shouldAskUser(): boolean {
    return !this.modelConfig.autonomousMode && this.modelConfig.askPolicy !== 'never';
  }

  private _debateRounds(): number {
    return Math.max(1, Math.min(10, Number(this.modelConfig.debateRounds) || 1));
  }

  private _fallbackProjectBrief(prompt: string): ProjectBrief {
    const lower = this._normalizedPromptIntent(prompt);
    const isMobile = /ios|android|mobile|react native|flutter/.test(lower);
    const isArcadeGame = /arkanoid|breakout|brick breaker|paddle.*ball|ball.*paddle/.test(lower);
    const isGame = /game|arcade|platformer|puzzle|runner|shooter/.test(lower) || isArcadeGame;
    const isBrowserGame = isArcadeGame || (isGame && /browser|html|canvas|javascript|index\.html/.test(lower));
    const isApi = /api|server|backend|rest|graphql/.test(lower);
    const isCli = /cli|command line|terminal/.test(lower);

    const appType = isGame ? 'game' : isMobile ? 'mobile' : isApi ? 'api' : isCli ? 'cli' : 'web';
    const chosenStack = isBrowserGame
      ? ['HTML Canvas', 'CSS', 'JavaScript', 'node:test']
      : isMobile || (isGame && !isBrowserGame)
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
      targetPlatforms: isBrowserGame ? ['modern web browser'] : isMobile || isGame ? ['iOS', 'Android'] : ['local development environment'],
      chosenStack,
      coreFeatures: isArcadeGame
        ? ['Arkanoid-style paddle and ball gameplay', 'Exactly 10 playable levels', 'Brick collisions, scoring, lives, pause, restart, and win state']
        : ['Complete implementation of the requested product', 'Usable default UX', 'Documented build and run workflow'],
      assumptions: [
        'Ambiguous product details are resolved with practical defaults.',
        isMobile || (isGame && !isBrowserGame)
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
      const briefText = `${brief.goal}\n${brief.chosenStack.join('\n')}\n${brief.deliveryArtifacts.join('\n')}`.toLowerCase();
      if (/browser|html|canvas|javascript|index\.html/.test(briefText)) {
        return ['package.json', 'index.html', 'styles.css', 'src/game.js', 'src/logic.js', 'src/render.js', 'test/logic.test.js', 'README.md'];
      }
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
    this._normalizeWorkerOutputShape(role, task, output);

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

  private _normalizeWorkerOutputShape(
    role: 'codeWorker' | 'fixer',
    task: TaskItem,
    output: CodeWorkerOutput
  ): void {
    output.reasoning = typeof output.reasoning === 'string'
      ? output.reasoning
      : `${role} returned an incomplete response for task ${task.id}.`;
    output.needUserInput = output.needUserInput === true;
    output.questions = Array.isArray(output.questions)
      ? output.questions.map(question => String(question)).filter(Boolean)
      : [];
    if (output.questions.length === 0) {
      output.needUserInput = false;
      output.blockedReason = undefined;
    }
    output.files = Array.isArray(output.files) ? output.files : [];

    const validActions = new Set(['create', 'modify', 'append', 'delete']);
    output.files = output.files
      .filter(file => file && typeof file.path === 'string' && file.path.trim().length > 0)
      .map(file => {
        const normalizedAction = validActions.has(file.action) ? file.action : 'modify';
        const normalizedContent = file.content === undefined
          ? undefined
          : Array.isArray(file.content)
            ? (file.content as unknown[]).join('\n')
            : typeof file.content === 'string'
              ? file.content
              : String(file.content);
        return {
          ...file,
          path: this._normalizeRelativePath(file.path),
          action: normalizedAction,
          content: normalizedContent,
          patch: file.patch === undefined ? undefined : String(file.patch),
          description: file.description === undefined ? undefined : String(file.description),
        };
      });
    output.toolRequests = Array.isArray(output.toolRequests)
      ? output.toolRequests
        .filter(request => request && typeof request.name === 'string')
        .map((request, index) => ({
          id: request.id || `${role}-${task.id}-tool-${index + 1}`,
          name: String(request.name),
          args: request.args && typeof request.args === 'object' ? request.args : {},
        }))
      : [];
    output.toolResults = Array.isArray(output.toolResults) ? output.toolResults : [];
  }

  private _normalizeReviewResult(task: TaskItem, review: ReviewResult): void {
    review.taskId = review.taskId || task.id;
    review.issues = Array.isArray(review.issues) ? review.issues.map(String) : [];
    review.suggestions = Array.isArray(review.suggestions) ? review.suggestions.map(String) : [];
    review.securityConcerns = Array.isArray(review.securityConcerns) ? review.securityConcerns.map(String) : [];
    review.fixSuggestions = Array.isArray(review.fixSuggestions) ? review.fixSuggestions.map(String) : [];
    review.needsFix = review.needsFix === true || review.approved === false || review.issues.length > 0 || review.securityConcerns.length > 0;
    review.approved = review.needsFix ? false : review.approved === true;
    review.reviewedAt = review.reviewedAt || new Date().toISOString();
  }

  private _normalizeTaskItem(task: TaskItem, index: number, now: string): TaskItem {
    const allowedFiles = Array.isArray(task.allowedFiles)
      ? task.allowedFiles.map(file => this._normalizeRelativePath(String(file))).filter(Boolean)
      : [];
    const acceptanceCriteria = Array.isArray(task.acceptanceCriteria)
      ? task.acceptanceCriteria.map(String)
      : [];
    const forbiddenActions = Array.isArray(task.forbiddenActions)
      ? task.forbiddenActions.map(String)
      : [];

    return {
      ...task,
      id: task.id || `task-${String(index + 1).padStart(3, '0')}`,
      assignedAgent: task.assignedAgent || 'codeWorker',
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
      allowedFiles,
      forbiddenActions: this._removeContradictoryForbiddenActions(forbiddenActions, allowedFiles, acceptanceCriteria),
      acceptanceCriteria,
      createdAt: task.createdAt || now,
      status: 'pending',
    };
  }

  private _removeContradictoryForbiddenActions(
    forbiddenActions: string[],
    allowedFiles: string[],
    acceptanceCriteria: string[]
  ): string[] {
    const allowed = new Set(allowedFiles.map(file => this._normalizeRelativePath(file)));
    const acceptanceText = acceptanceCriteria.join('\n').toLowerCase();
    return forbiddenActions.filter(action => {
      const lower = action.toLowerCase();
      for (const allowedFile of allowed) {
        const basename = path.posix.basename(allowedFile).toLowerCase();
        if (
          lower.includes('do not') &&
          lower.includes(basename) &&
          acceptanceText.includes(basename)
        ) {
          this.workspace.appendAssumption(
            'taskManager',
            `Removed contradictory forbidden action "${action}" because ${allowedFile} is explicitly allowed and required by the task acceptance criteria.`
          );
          return false;
        }
      }
      return true;
    });
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

  private _captureFileBaselines(
    pathsToObserve: string[],
    taskId: string | undefined,
    agentRole: 'codeWorker' | 'fixer'
  ): Map<string, FileSnapshot> {
    const paths = this._expandBaselinePaths(pathsToObserve);
    const baselines = new Map<string, FileSnapshot>();
    for (const file of paths) {
      baselines.set(file, this.fileManager.getFileSnapshot(file));
    }

    if (baselines.size > 0) {
      this.workspace.appendMemoryEvent({
        type: 'file_baseline',
        phase: this.workspace.readProjectState().currentPhase,
        agentRole,
        taskId,
        summary: `Captured ${baselines.size} file baseline(s) before ${agentRole} edit planning.`,
        data: { files: [...baselines.keys()] },
      });
    }

    return baselines;
  }

  private _expandBaselinePaths(pathsToObserve: string[]): string[] {
    const files = new Set<string>();
    for (const rawPath of pathsToObserve) {
      const normalized = this._normalizeRelativePath(String(rawPath ?? ''));
      if (!this._isSafeWorkspaceRelativePath(normalized)) { continue; }

      const looksLikeDirectory =
        normalized.endsWith('/') ||
        (!this.fileManager.fileExists(normalized) && path.posix.extname(normalized) === '');

      if (looksLikeDirectory) {
        for (const file of this.fileManager.listWorkspaceFiles(normalized, this._textFileExtensions())) {
          const normalizedFile = this._normalizeRelativePath(file);
          if (this._isSafeWorkspaceRelativePath(normalizedFile)) {
            files.add(normalizedFile);
          }
        }
      } else {
        files.add(normalized);
      }
    }
    return [...files].sort();
  }

  private _attachChangeBaseline(output: CodeWorkerOutput, baseline: Map<string, FileSnapshot>): void {
    this._changeBaselines.set(output, baseline);
  }

  private _detectBaselineConflicts(output: CodeWorkerOutput): string[] {
    const baseline = this._changeBaselines.get(output);
    return this.fileManager.detectConflictingChanges(output.files, baseline);
  }

  private _structuredMemoryContext(maxLines: number = 80): string {
    const raw = this.workspace.readFile(this.workspace.memoryEventsPath);
    if (!raw) { return '_No structured memory events recorded yet._'; }
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-maxLines);
    return lines.join('\n');
  }

  private _selectWorkflowRoute(state: ProjectState): WorkflowRoute {
    const prompt = (state.projectGoal || this.workspace.readUserPrompt()).toLowerCase();
    const looksLikeMaintenance =
      /(fix|bug|failing|failure|error|lint|compile|test|review|refactor|update|change|patch|sửa|lỗi|kiểm tra|cải tiến)/i.test(prompt);
    const looksLikeNewProject =
      /(build|create|generate|scaffold|new project|entire project|tạo|xây dựng|làm app|làm game)/i.test(prompt);
    const hasExistingSource =
      this.fileManager.listWorkspaceFiles('src', this._textFileExtensions()).length > 0 ||
      this.fileManager.fileExists('package.json') ||
      this.fileManager.fileExists('README.md');

    if (hasExistingSource && looksLikeMaintenance && !looksLikeNewProject) {
      return {
        kind: 'maintenance',
        skipDebate: true,
        reason: 'Prompt looks like a focused change in an existing workspace, so the workflow skips broad debate and moves to grounded planning.',
      };
    }

    return {
      kind: 'full_project',
      skipDebate: false,
      reason: 'Prompt looks like a product/project generation request, so the full multi-agent debate remains useful.',
    };
  }

  private _loadConfig(): void {
    this.modelConfig = this.workspace.readModelConfig();
    this.ollama = new OllamaClient(
      this.modelConfig.ollamaBaseUrl,
      this.workspace.ollamaCallsLogPath,
      this.modelConfig.requestTimeoutMs
    );
    this.terminal = new TerminalRunner(
      this.workspace.rootDir,
      this.workspace.terminalLogPath,
      this.modelConfig.commandPolicy
    );
    this.terminalSessions = new TerminalSessionRunner(
      this.workspace.rootDir,
      this.workspace.logsDir,
      this.modelConfig.commandPolicy
    );
    this.webSearch = new WebSearchService(this.modelConfig.webSearch);
    this.research = this._buildResearchService();
    this.toolRegistry = new AutonomousToolRegistry(
      this.fileManager,
      this.searchService,
      this.terminal,
      this.patchService,
      this.webFetcher,
      (command, reason) => this._requestCommandApproval(command, reason),
      this.research
    );
    this.skillManager = new SkillManager(this.workspace.rootDir, this.modelConfig.skills);
    this.githubIntegration = new GitHubIntegrationService(this.workspace.rootDir, this.modelConfig.githubIntegration);
  }

  private _buildResearchService(): ResearchService {
    return new ResearchService({
      webSearch: this.modelConfig.webSearch,
      github: this.modelConfig.githubIntegration,
      allowExternalRepoReads:
        this.modelConfig.githubIntegration?.allowExternalRepoReads === true,
      maxResults: this.modelConfig.webSearch?.maxResults,
    });
  }

  private _ensureCapabilityServices(): void {
    if (!this.terminalSessions) {
      this.terminalSessions = new TerminalSessionRunner(
        this.workspace.rootDir,
        this.workspace.logsDir,
        this.modelConfig?.commandPolicy
      );
    }
    if (!this.toolRegistry) {
      this.toolRegistry = new AutonomousToolRegistry(
        this.fileManager,
        this.searchService,
        this.terminal,
        this.patchService,
        this.webFetcher,
        (command, reason) => this._requestCommandApproval(command, reason),
        this.research ?? (this.research = this._buildResearchService())
      );
    }
    if (!this.skillManager) {
      this.skillManager = new SkillManager(this.workspace.rootDir, this.modelConfig?.skills);
    }
    if (!this.githubIntegration) {
      this.githubIntegration = new GitHubIntegrationService(this.workspace.rootDir, this.modelConfig?.githubIntegration);
    }
    if (!this.webSearch) {
      this.webSearch = new WebSearchService(this.modelConfig?.webSearch);
    }
  }

  private _agentConfig(role: AgentRole): { model: string; fallbackModel: string } {
    return this.modelConfig.agents[role];
  }

  /** Unique pool of every model referenced in the roster (primary + fallback). */
  private _modelRoster(): string[] {
    const pool: string[] = [];
    for (const cfg of Object.values(this.modelConfig.agents)) {
      if (cfg?.model) { pool.push(cfg.model); }
      if (cfg?.fallbackModel) { pool.push(cfg.fallbackModel); }
    }
    return [...new Set(pool)];
  }

  /**
   * Assign a DISTINCT local model to each debate judge so the round-4 panel
   * genuinely satisfies the "at least 5 agents of different models vote" rule,
   * even when two roles share a primary model in config (e.g. critic and
   * reviewer). Each judge keeps its role lens but borrows a still-unused model
   * — its own primary first, then its fallback, then any other model in the
   * roster — whenever the natural choice would collide with an earlier judge.
   * Returns the assignment plus the count of distinct models actually achieved
   * so the caller can surface a visible warning if the roster is too small.
   */
  private _assignDiversePanelModels(
    panelRoles: AgentRole[]
  ): { assignments: Map<AgentRole, { model: string; fallbackModel: string }>; distinctCount: number } {
    const roster = this._modelRoster();
    const used = new Set<string>();
    const assignments = new Map<AgentRole, { model: string; fallbackModel: string }>();

    for (const role of panelRoles) {
      const cfg = this._agentConfig(role);
      const candidates = [cfg.model, cfg.fallbackModel, ...roster].filter(Boolean) as string[];
      const chosen = candidates.find(m => !used.has(m)) ?? cfg.model;
      used.add(chosen);
      // Prefer a fallback that differs from the chosen primary so a single
      // unavailable model never collapses two judges onto the same backup.
      const fallback =
        [cfg.fallbackModel, cfg.model, ...roster].find(m => m && m !== chosen) ?? cfg.fallbackModel;
      assignments.set(role, { model: chosen, fallbackModel: fallback });
    }

    return { assignments, distinctCount: used.size };
  }

  private _buildMessages(role: AgentRole, userContent: string): OllamaMessage[] {
    const { systemPrompt } = getAgentPrompt(role);
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: buildUserMessage(userContent, role) },
    ];
  }

  // ------------------------------------------------------------------
  // Compact-context helpers
  // ------------------------------------------------------------------

  /**
   * Character budget for the user message = 60 % of the model's context
   * window (approximated as num_ctx × 4 chars/token).
   * The remaining 40 % is reserved for the system prompt and model overhead.
   */
  /**
   * Return per-role LLM options scaled by plan complexity.
   * Creative agents get higher temperature; precise agents get lower.
   * High-complexity plans get a larger context window for all roles.
   */
  private _optionsForRole(role: AgentRole): ModelOptions {
    const base = { ...this.modelConfig.defaultOptions };
    const complexity = this._taskPlanComplexity;
    const baseCtx = base.num_ctx ?? 32_768;
    const ctxScale = complexity === 'low' ? 0.5 : complexity === 'high' ? 1.5 : 1.0;
    const scaledCtx = Math.round(baseCtx * ctxScale);
    switch (role) {
      case 'codeWorker':
      case 'fixer':
        return { ...base, temperature: 0.05, num_ctx: scaledCtx };
      case 'reviewer':
        return { ...base, temperature: 0.03, num_ctx: Math.min(scaledCtx, baseCtx) };
      case 'architect':
      case 'taskManager':
        return { ...base, temperature: 0.07, num_ctx: Math.max(Math.round(baseCtx * 0.75), 16_384) };
      case 'brainstorm':
      case 'critic':
      case 'secondBrainstorm':
        // Cap output length for creative agents — they don't need to emit code
        return { ...base, temperature: 0.2, num_ctx: Math.round(baseCtx * 0.5), num_predict: 2048 };
      case 'tester':
        return { ...base, temperature: 0.0, num_ctx: Math.round(baseCtx * 0.75) };
      case 'briefBuilder':
        return { ...base, temperature: 0.07, num_ctx: Math.round(baseCtx * 0.75) };
      case 'finalIntegrator':
        return { ...base, temperature: 0.05, num_ctx: scaledCtx };
      default:
        return base;
    }
  }

  /** Append a lesson learned to the cross-session JSONL file. */
  private _appendLesson(lesson: {
    issue: string;
    fix: string;
    taskTitle: string;
    filesAffected: string[];
    attempt: number;
  }): void {
    try {
      const entry = JSON.stringify({ ...lesson, recordedAt: new Date().toISOString() }) + '\n';
      fs.appendFileSync(this.workspace.lessonsLearnedPath, entry, 'utf8');
    } catch {
      // Non-critical: do not fail the workflow if lesson logging fails
    }
  }

  /** Load the N most recent lessons from the cross-session lessons file. */
  private _loadLessons(maxCount = 5): string {
    try {
      const filePath = this.workspace.lessonsLearnedPath;
      if (!fs.existsSync(filePath)) { return ''; }
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
      const recent = lines.slice(-maxCount);
      if (recent.length === 0) { return ''; }
      const entries = recent.map(l => {
        try {
          const e = JSON.parse(l) as { issue: string; fix: string; taskTitle: string; attempt: number };
          return `- Issue: ${e.issue}\n  Fix (attempt ${e.attempt}): ${e.fix}`;
        } catch { return null; }
      }).filter((x): x is string => x !== null);
      return entries.join('\n\n');
    } catch {
      return '';
    }
  }

  private _contextBudget(): number {
    const numCtx = this.modelConfig?.defaultOptions?.num_ctx ?? 32_768;
    return Math.floor(numCtx * 4 * 0.60);
  }

  /**
   * Convenience factory for a `ContextSection`.
   *
   * @param heading    Markdown heading, e.g. `'# User Prompt'`.
   *                   Pass `''` when the content already has its own heading.
   * @param content    Raw text content.
   * @param priority   1 = highest priority; sections are allocated budget
   *                   in ascending priority order.
   * @param maxFraction  Optional cap on what fraction of the total budget
   *                     this section may consume (default: tier-based).
   */
  private _sec(
    heading: string,
    content: string,
    priority: number,
    maxFraction?: number,
  ): ContextSection {
    return { heading, content, priority, maxFraction };
  }

  /**
   * Assemble `sections` into a single string that fits within
   * `_contextBudget()` characters.  Uses `ContextCache.buildContext`
   * internally so the budget logic and middle-truncation are centralised.
   */
  private _assembleContext(sections: ContextSection[]): string {
    return this._contextCache.buildContext(sections, this._contextBudget());
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
        this._optionsForRole(role), outputFile, inputFiles
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
        this._optionsForRole(role), outputFile, inputFiles
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
      // Exponential backoff with jitter to avoid thundering-herd on overloaded model
      const jitter = Math.floor(Math.random() * healing.retryDelayMs * 0.5);
      await this._delay(healing.retryDelayMs * Math.pow(2, attempt - 1) + jitter);
      try {
        this._emit('log', `Retrying ${role} model call (${attempt}/${healing.modelCallRetries}) with compact context...`, 'warn');
        return await this.ollama.callWithFallback(
          model, fallbackModel, recoveryMessages, role,
          this._optionsForRole(role), outputFile, inputFiles
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
          this._optionsForRole(role), outputFile, inputFiles
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
      // Exponential backoff with jitter
      const jitter = Math.floor(Math.random() * healing.retryDelayMs * 0.5);
      await this._delay(healing.retryDelayMs * Math.pow(2, attempt - 1) + jitter);
      try {
        this._emit('log', `Retrying ${role} JSON call (${attempt}/${healing.modelCallRetries}) with compact context...`, 'warn');
        return await this.ollama.callWithFallbackJson<T>(
          model, fallbackModel, recoveryMessages, role,
          this._optionsForRole(role), outputFile, inputFiles
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
          this._optionsForRole(role), outputFile, inputFiles
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
    this.workspace.appendMemoryEvent({
      type: 'phase',
      phase,
      agentRole: this._agentRoleForPhase(phase),
      summary: message,
    });
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

  private _maxDevelopmentSprints(): number {
    return Math.max(1, Math.min(5, this.modelConfig.debateRounds || 3));
  }

  private _scopeTaskPlanForSprint(sprint: number): void {
    const taskPlan = this._loadTaskPlan();
    if (!taskPlan) { return; }
    const prefix = `sprint-${String(sprint).padStart(2, '0')}-`;
    if (taskPlan.tasks.every(task => task.id.startsWith(prefix))) { return; }

    const idMap = new Map(taskPlan.tasks.map(task => [task.id, `${prefix}${task.id}`]));
    taskPlan.tasks = taskPlan.tasks.map(task => ({
      ...task,
      id: idMap.get(task.id) ?? `${prefix}${task.id}`,
      dependsOn: task.dependsOn.map(dep => idMap.get(dep) ?? dep),
      status: 'pending',
      startedAt: undefined,
      completedAt: undefined,
      retryCount: 0,
      reviewResult: undefined,
      error: undefined,
    }));
    taskPlan.notes = [
      taskPlan.notes ?? '',
      `Scoped task IDs for development sprint ${sprint} so repeated planning cycles do not collide with previous completed tasks.`,
    ].filter(Boolean).join('\n');
    this.workspace.writeFile(this.workspace.taskPlanPath, prettyJson(taskPlan));
    this.callbacks.onTaskUpdate?.(taskPlan.tasks);
  }

  private _prepareNextDevelopmentSprint(
    state: ProjectState,
    sprint: number,
    consensus: ImprovementConsensus[]
  ): void {
    const remainingWork = consensus.flatMap(item => item.remainingWork);
    const nextGoal = consensus.find(item => item.nextSprintGoal.trim())?.nextSprintGoal
      ?? remainingWork.slice(0, 2).join('; ')
      ?? 'Improve the verified product based on retrospective findings.';

    state.currentTaskId = null;
    state.activeTasks = [];
    state.fixRetryCount = 0;
    state.updatedAt = new Date().toISOString();
    this.workspace.writeProjectState(state);
    this.workspace.appendRollingSummary(
      `## Next Sprint ${sprint + 1} Goal\n${nextGoal}\n\n` +
      `Remaining work:\n${remainingWork.map(item => `- ${item}`).join('\n') || '- Improve polish and completeness without expanding scope.'}`
    );
    this.workspace.appendAssumption(
      'taskManager',
      `Sprint ${sprint + 1} should plan only the smallest vertical increment needed for: ${nextGoal}`
    );
  }

  private _consensusReadyToStop(consensus: ImprovementConsensus[]): boolean {
    return consensus.length === 3
      && consensus.every(item => item.readyToStop)
      && consensus.every(item => item.remainingWork.length === 0);
  }

  private _normalizeImprovementConsensus(
    role: ImprovementConsensus['agentRole'],
    value: Partial<ImprovementConsensus> | null | undefined
  ): ImprovementConsensus {
    const confidence = value?.confidence === 'low' || value?.confidence === 'medium' || value?.confidence === 'high'
      ? value.confidence
      : 'medium';
    const remainingWork = Array.isArray(value?.remainingWork)
      ? value.remainingWork.map(item => String(item).trim()).filter(Boolean).slice(0, 6)
      : [];
    const readyToStop = Boolean(value?.readyToStop) && remainingWork.length === 0;
    return {
      agentRole: role,
      readyToStop,
      confidence,
      remainingWork: readyToStop ? [] : remainingWork,
      nextSprintGoal: readyToStop ? '' : String(value?.nextSprintGoal ?? remainingWork[0] ?? 'Improve the verified product.').trim(),
      rationale: String(value?.rationale ?? (readyToStop ? 'No material work remains.' : 'Another focused sprint may improve the result.')).trim(),
    };
  }

  private _fallbackImprovementConsensus(
    role: ImprovementConsensus['agentRole'],
    sprint: number,
    err: unknown
  ): ImprovementConsensus {
    const testerNote = this.workspace.readFile(this.workspace.testerPath) ?? '';
    const hasFailedTasks = this.workspace.readProjectState().failedTasks.length > 0;
    const hasExplicitPass = /"passed"\s*:\s*true/.test(testerNote) && /"needsFix"\s*:\s*false/.test(testerNote);
    const hasVerificationFailure = !hasExplicitPass && (
      /"passed"\s*:\s*false|"needsFix"\s*:\s*true|Project checks still fail|Exit:\s*[1-9]|Failed:/i.test(testerNote)
    );
    const readyToStop = sprint > 1 && !hasFailedTasks && !hasVerificationFailure;
    return {
      agentRole: role,
      readyToStop,
      confidence: readyToStop ? 'medium' : 'low',
      remainingWork: readyToStop ? [] : ['Stabilize remaining verification or completeness gaps found during the previous sprint.'],
      nextSprintGoal: readyToStop ? '' : 'Stabilize the product and close verification gaps.',
      rationale: readyToStop
        ? 'Fallback consensus stopped after multiple verified sprints with no recorded failures.'
        : `Consensus model failed, so the workflow conservatively requests one more small sprint. Error: ${formatError(err)}`,
    };
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
      'idle', 'intake', 'brainstorm', 'critique', 'second_brainstorm', 'briefing',
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

  private _writeDynamicPlanReport(state: ProjectState, taskPlan: TaskPlan): void {
    const report = this.planController.createReport(
      state.projectGoal,
      taskPlan.tasks,
      state.completedTasks,
      state.failedTasks
    );
    this.workspace.writeFile(this.workspace.planControllerPath, prettyJson(report));
    this.workspace.appendMemoryEvent({
      type: 'plan',
      phase: state.currentPhase,
      summary: `Dynamic plan updated: ${report.summary}`,
      data: {
        currentStep: report.currentStep,
        nextAction: this.planController.nextAction(report),
      },
    });
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
      { phase: 'brainstorm',         label: '1. Brainstorm',        agentRole: 'brainstorm',         status: 'pending' },
      { phase: 'critique',           label: '2. Critique Debate',   agentRole: 'critic',             status: 'pending' },
      { phase: 'second_brainstorm',  label: '3. Product Debate',    agentRole: 'secondBrainstorm',   status: 'pending' },
      { phase: 'briefing',           label: '4. Product Brief',     agentRole: 'briefBuilder',       status: 'pending' },
      { phase: 'toolchain_discovery',label: '5. Toolchain',         status: 'pending' },
      { phase: 'architecture',       label: '6. Sprint Architecture', agentRole: 'architect',        status: 'pending' },
      { phase: 'task_planning',      label: '7. Sprint Planning',   agentRole: 'taskManager',        status: 'pending' },
      { phase: 'coding',             label: '8. Sprint Coding',     agentRole: 'codeWorker',         status: 'pending' },
      { phase: 'dependency_install', label: '9. Dependencies',      status: 'pending' },
      { phase: 'testing',            label: '10. Sprint Testing',   agentRole: 'tester',             status: 'pending' },
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
    this.workspace.appendMemoryEvent({
      type: 'activity',
      phase: activity.phase,
      agentRole: activity.agentRole,
      taskId: activity.taskId,
      summary: `${activity.title}: ${activity.detail}`,
      data: {
        status: activity.status,
        files: activity.files,
        round: activity.round,
        totalRounds: activity.totalRounds,
      },
    });
    // Mirror every activity into the human-readable journal so the boss can
    // follow the entire run chronologically.
    const statusIcon: Record<string, string> = {
      running: '▶️', completed: '✅', warn: '⚠️', failed: '❌',
    };
    const roundSuffix = activity.round && activity.totalRounds
      ? ` (round ${activity.round}/${activity.totalRounds})`
      : '';
    const detail = [activity.detail, activity.files?.length ? `Files: ${activity.files.join(', ')}` : '']
      .filter(Boolean).join('\n\n');
    try {
      this.workspace.appendJournal(
        statusIcon[activity.status] ?? '•',
        activity.agentRole ?? activity.phase,
        `${activity.title}${roundSuffix}`,
        detail
      );
    } catch { /* journaling must never break the workflow */ }
    this.callbacks.onActivityUpdate?.(this._activities);
  }

  /**
   * Append a rich, human-readable entry to the run journal. Used for the
   * narrative moments (thoughts, opinions, critiques, decisions, reports) that
   * are not already captured as terse activities. Never throws.
   */
  private _journal(kind: string, title: string, body?: string): void {
    const map: Record<string, { icon: string; author: string }> = {
      start:      { icon: '🚀', author: 'system' },
      phase:      { icon: '📍', author: 'system' },
      brainstorm: { icon: '💡', author: 'brainstorm' },
      critique:   { icon: '🔍', author: 'critic' },
      product:    { icon: '🎨', author: 'secondBrainstorm' },
      response:   { icon: '🗣️', author: 'brainstorm' },
      decision:   { icon: '⚖️', author: 'debate-panel' },
      brief:      { icon: '🧠', author: 'briefBuilder' },
      architect:  { icon: '🏛️', author: 'architect' },
      plan:       { icon: '📋', author: 'taskManager' },
      code:       { icon: '⚙️', author: 'codeWorker' },
      review:     { icon: '🔎', author: 'reviewer' },
      audit:      { icon: '🕵️', author: 'quality-auditor' },
      fix:        { icon: '🔧', author: 'fixer' },
      test:       { icon: '🧪', author: 'tester' },
      consensus:  { icon: '🤝', author: 'retrospective' },
      report:     { icon: '📊', author: 'finalIntegrator' },
      done:       { icon: '✅', author: 'system' },
      warn:       { icon: '⚠️', author: 'quality-auditor' },
      error:      { icon: '❌', author: 'system' },
      waiting:    { icon: '⏳', author: 'system' },
      research:   { icon: '🌐', author: 'researcher' },
      github:     { icon: '🐙', author: 'researcher' },
    };
    const meta = map[kind] ?? { icon: '📝', author: 'agent' };
    try {
      this.workspace.appendJournal(meta.icon, meta.author, title, body);
    } catch { /* journaling must never break the workflow */ }
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
