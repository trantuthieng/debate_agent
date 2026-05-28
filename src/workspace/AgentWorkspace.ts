import * as fs from 'fs';
import * as path from 'path';
import type { ModelConfig, ProjectState } from '../types';
import { prettyJson } from '../utils/json';
import { logInfo } from '../utils/logging';

// -----------------------------------------------------------------------
// Default model configuration
// -----------------------------------------------------------------------
const DEFAULT_MODEL_CONFIG: ModelConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  requestTimeoutMs: 600_000,
  safeMode: false,
  autonomousMode: true,
  askPolicy: 'never',
  debateRounds: 3,
  maxFixRetries: 8,
  autoInstallDependencies: true,
  artifactDir: 'dist',
  createFinalArchive: true,
  requireVerificationScripts: true,
  selfHealing: {
    enabled: true,
    modelCallRetries: 2,
    retryDelayMs: 5_000,
    alternateModelLimit: 3,
    compactContextChars: 12_000,
  },
  defaultOptions: {
    temperature: 0.1,
    num_ctx: 8192,
    top_p: 0.9,
  },
  agents: {
    briefBuilder: {
      model: 'devstral-small-2',
      fallbackModel: 'qwen2.5-coder:14b-instruct',
    },
    brainstorm: {
      model: 'qwen3-coder:30b',
      fallbackModel: 'devstral-small-2',
    },
    critic: {
      model: 'deepseek-coder-v2:16b',
      fallbackModel: 'qwen2.5-coder:14b-instruct',
    },
    secondBrainstorm: {
      model: 'qwen2.5-coder:14b-instruct',
      fallbackModel: 'qwen2.5-coder:7b-instruct',
    },
    architect: {
      model: 'devstral-small-2',
      fallbackModel: 'qwen3-coder:30b',
    },
    taskManager: {
      model: 'devstral-small-2',
      fallbackModel: 'qwen2.5-coder:14b-instruct',
    },
    codeWorker: {
      model: 'devstral-small-2',
      fallbackModel: 'qwen2.5-coder:14b-instruct',
    },
    reviewer: {
      model: 'deepseek-coder-v2:16b',
      fallbackModel: 'qwen2.5-coder:14b-instruct',
    },
    tester: {
      model: 'qwen2.5-coder:7b-instruct',
      fallbackModel: 'qwen2.5-coder:14b-instruct',
    },
    fixer: {
      model: 'devstral-small-2',
      fallbackModel: 'qwen2.5-coder:14b-instruct',
    },
    finalIntegrator: {
      model: 'devstral-small-2',
      fallbackModel: 'qwen3-coder:30b',
    },
  },
};

// -----------------------------------------------------------------------
// Default project state
// -----------------------------------------------------------------------
function createDefaultProjectState(): ProjectState {
  const now = new Date().toISOString();
  return {
    projectGoal: '',
    status: 'idle',
    currentPhase: 'idle',
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

// -----------------------------------------------------------------------
// AgentWorkspace: manages the .agent-workspace/ folder structure
// -----------------------------------------------------------------------
export class AgentWorkspace {
  readonly rootDir: string;       // Workspace root (e.g. /home/user/myproject)
  readonly agentDir: string;      // .agent-workspace/

  constructor(workspaceRoot: string) {
    this.rootDir = workspaceRoot;
    this.agentDir = path.join(workspaceRoot, '.agent-workspace');
  }

  // ------------------------------------------------------------------
  // Well-known paths
  // ------------------------------------------------------------------

  get projectStatePath(): string   { return path.join(this.agentDir, 'project_state.json'); }
  get userPromptPath(): string     { return path.join(this.agentDir, 'user_prompt.md'); }
  get modelConfigPath(): string    { return path.join(this.agentDir, 'model_config.json'); }

  get memoryDir(): string          { return path.join(this.agentDir, 'memory'); }
  get rollingSummaryPath(): string { return path.join(this.memoryDir, 'rolling_summary.md'); }
  get decisionsPath(): string      { return path.join(this.memoryDir, 'decisions.md'); }
  get constraintsPath(): string    { return path.join(this.memoryDir, 'constraints.md'); }
  get openQuestionsPath(): string  { return path.join(this.memoryDir, 'open_questions.md'); }
  get assumptionsPath(): string    { return path.join(this.memoryDir, 'assumptions.md'); }

  get agentsDir(): string          { return path.join(this.agentDir, 'agents'); }
  get tasksDir(): string           { return path.join(this.agentDir, 'tasks'); }
  get patchesDir(): string         { return path.join(this.agentDir, 'patches'); }
  get logsDir(): string            { return path.join(this.agentDir, 'logs'); }

  get taskPlanPath(): string       { return path.join(this.tasksDir, 'task_plan.json'); }
  get taskResultsPath(): string    { return path.join(this.tasksDir, 'task_results.json'); }

  get ollamaCallsLogPath(): string { return path.join(this.logsDir, 'ollama_calls.jsonl'); }
  get terminalLogPath(): string    { return path.join(this.logsDir, 'terminal.log'); }
  get testResultLogPath(): string  { return path.join(this.logsDir, 'test_result.log'); }
  get dependencyInstallLogPath(): string { return path.join(this.logsDir, 'dependency_install.log'); }
  get workflowLogPath(): string    { return path.join(this.logsDir, 'workflow.log'); }

  agentNotePath(filename: string): string { return path.join(this.agentsDir, filename); }

  // Agent note filenames
  get brainstormPath(): string      { return this.agentNotePath('01_brainstorm.md'); }
  get criticPath(): string          { return this.agentNotePath('02_critic.md'); }
  get secondBrainstormPath(): string{ return this.agentNotePath('03_second_brainstorm.md'); }
  get projectBriefPath(): string    { return this.agentNotePath('00_project_brief.json'); }
  get toolchainReportPath(): string { return this.agentNotePath('00_toolchain_report.json'); }
  get gitSnapshotPath(): string     { return this.agentNotePath('00_git_snapshot.json'); }
  get architectMdPath(): string     { return this.agentNotePath('04_architect.md'); }
  get architectJsonPath(): string   { return this.agentNotePath('04_architect_plan.json'); }
  get taskManagerPath(): string     { return this.agentNotePath('05_task_manager.md'); }
  get codeWorkerPath(): string      { return this.agentNotePath('06_code_worker.md'); }
  get reviewerPath(): string        { return this.agentNotePath('07_reviewer.md'); }
  get testerPath(): string          { return this.agentNotePath('08_tester.md'); }
  get deliveryManifestPath(): string { return this.agentNotePath('08_delivery_manifest.json'); }
  get finalReportPath(): string     { return this.agentNotePath('09_final_report.md'); }

  // ------------------------------------------------------------------
  // Initialization
  // ------------------------------------------------------------------

  /**
   * Create all required directories and default files.
   * Safe to call multiple times (idempotent).
   */
  async initialize(): Promise<void> {
    logInfo('Initializing agent workspace...');

    const dirs = [
      this.agentDir,
      this.memoryDir,
      this.agentsDir,
      this.tasksDir,
      this.patchesDir,
      this.logsDir,
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logInfo(`Created directory: ${dir}`);
      }
    }

    // Create default model_config.json only if it doesn't exist
    if (!fs.existsSync(this.modelConfigPath)) {
      fs.writeFileSync(this.modelConfigPath, prettyJson(DEFAULT_MODEL_CONFIG), 'utf8');
      logInfo('Created default model_config.json');
    } else {
      fs.writeFileSync(this.modelConfigPath, prettyJson(this.readModelConfig()), 'utf8');
      logInfo('Updated model_config.json with current defaults');
    }

    // Create default project_state.json only if it doesn't exist
    if (!fs.existsSync(this.projectStatePath)) {
      fs.writeFileSync(this.projectStatePath, prettyJson(createDefaultProjectState()), 'utf8');
      logInfo('Created default project_state.json');
    }

    // Create placeholder memory files
    const memoryFiles: Array<[string, string]> = [
      [this.rollingSummaryPath, '# Rolling Summary\n\n_Updated by agents during the workflow._\n'],
      [this.decisionsPath,      '# Decisions\n\n_Recorded by agents during the workflow._\n'],
      [this.constraintsPath,    '# Constraints\n\n_Recorded during architecture phase._\n'],
      [this.openQuestionsPath,  '# Open Questions\n\n_Updated when user input is required._\n'],
      [this.assumptionsPath,    '# Autonomous Assumptions\n\n_Recorded when agents resolve ambiguity without asking the user._\n'],
    ];

    for (const [filePath, content] of memoryFiles) {
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, content, 'utf8');
      }
    }

    logInfo('Agent workspace initialized.');
  }

  // ------------------------------------------------------------------
  // Project State I/O
  // ------------------------------------------------------------------

  readProjectState(): ProjectState {
    if (!fs.existsSync(this.projectStatePath)) {
      return createDefaultProjectState();
    }
    try {
      const raw = fs.readFileSync(this.projectStatePath, 'utf8');
      return JSON.parse(raw) as ProjectState;
    } catch {
      return createDefaultProjectState();
    }
  }

  writeProjectState(state: ProjectState): void {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.projectStatePath, prettyJson(state), 'utf8');
  }

  // ------------------------------------------------------------------
  // Model Config I/O
  // ------------------------------------------------------------------

  readModelConfig(): ModelConfig {
    if (!fs.existsSync(this.modelConfigPath)) {
      return DEFAULT_MODEL_CONFIG;
    }
    try {
      const raw = fs.readFileSync(this.modelConfigPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ModelConfig>;
      // Merge with defaults so new fields are always present
      const merged: ModelConfig = {
        ...DEFAULT_MODEL_CONFIG,
        ...parsed,
        agents: { ...DEFAULT_MODEL_CONFIG.agents, ...(parsed.agents ?? {}) },
        selfHealing: { ...DEFAULT_MODEL_CONFIG.selfHealing, ...(parsed.selfHealing ?? {}) },
        defaultOptions: { ...DEFAULT_MODEL_CONFIG.defaultOptions, ...(parsed.defaultOptions ?? {}) },
      };
      merged.debateRounds = Math.max(1, Math.min(10, Number(merged.debateRounds) || DEFAULT_MODEL_CONFIG.debateRounds));
      const maxFixRetries = Number(merged.maxFixRetries);
      const requestTimeoutMs = Number(merged.requestTimeoutMs);
      const modelCallRetries = Number(merged.selfHealing.modelCallRetries);
      const retryDelayMs = Number(merged.selfHealing.retryDelayMs);
      const alternateModelLimit = Number(merged.selfHealing.alternateModelLimit);
      const compactContextChars = Number(merged.selfHealing.compactContextChars);
      merged.maxFixRetries = Number.isFinite(maxFixRetries) ? Math.max(0, Math.min(20, maxFixRetries)) : DEFAULT_MODEL_CONFIG.maxFixRetries;
      merged.requestTimeoutMs = Number.isFinite(requestTimeoutMs) ? Math.max(30_000, requestTimeoutMs) : DEFAULT_MODEL_CONFIG.requestTimeoutMs;
      merged.selfHealing.modelCallRetries = Number.isFinite(modelCallRetries) ? Math.max(0, Math.min(5, modelCallRetries)) : DEFAULT_MODEL_CONFIG.selfHealing.modelCallRetries;
      merged.selfHealing.retryDelayMs = Number.isFinite(retryDelayMs) ? Math.max(0, retryDelayMs) : DEFAULT_MODEL_CONFIG.selfHealing.retryDelayMs;
      merged.selfHealing.alternateModelLimit = Number.isFinite(alternateModelLimit) ? Math.max(0, Math.min(10, alternateModelLimit)) : DEFAULT_MODEL_CONFIG.selfHealing.alternateModelLimit;
      merged.selfHealing.compactContextChars = Number.isFinite(compactContextChars) ? Math.max(2_000, compactContextChars) : DEFAULT_MODEL_CONFIG.selfHealing.compactContextChars;
      if (merged.autonomousMode || merged.askPolicy === 'never') {
        merged.safeMode = false;
        merged.askPolicy = 'never';
      }
      return merged;
    } catch {
      return DEFAULT_MODEL_CONFIG;
    }
  }

  // ------------------------------------------------------------------
  // Convenience read/write
  // ------------------------------------------------------------------

  readFile(filePath: string): string | null {
    if (!fs.existsSync(filePath)) { return null; }
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  }

  writeFile(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(filePath, content, 'utf8');
  }

  appendFile(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.appendFileSync(filePath, content, 'utf8');
  }

  fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  /**
   * Write user prompt to user_prompt.md
   */
  writeUserPrompt(prompt: string): void {
    const content = `# User Project Prompt\n\n${prompt}\n`;
    this.writeFile(this.userPromptPath, content);
  }

  /**
   * Read user prompt
   */
  readUserPrompt(): string {
    return this.readFile(this.userPromptPath) ?? '';
  }

  /**
   * Append a line to the rolling summary
   */
  appendRollingSummary(entry: string): void {
    const line = `\n## ${new Date().toISOString()}\n\n${entry}\n`;
    this.appendFile(this.rollingSummaryPath, line);
  }

  /**
   * Append an answered question to open_questions.md
   */
  appendAnsweredQuestion(question: string, answer: string): void {
    const entry =
      `\n## Question\n\n${question}\n\n` +
      `**Answer:** ${answer}\n\n` +
      `_Answered at: ${new Date().toISOString()}_\n`;
    this.appendFile(this.openQuestionsPath, entry);
  }

  /**
   * Append an autonomous assumption that replaced a user question.
   */
  appendAssumption(source: string, assumption: string): void {
    const entry =
      `\n## ${new Date().toISOString()} — ${source}\n\n` +
      `${assumption}\n`;
    this.appendFile(this.assumptionsPath, entry);
  }

  /**
   * List all files in a directory (relative paths from workspace root).
   */
  listDir(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) { return []; }
    try {
      return fs.readdirSync(dirPath).map(f => path.join(dirPath, f));
    } catch { return []; }
  }
}
