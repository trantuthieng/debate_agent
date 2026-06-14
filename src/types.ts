// ============================================================
// Core TypeScript types for Local Multi-Agent Coder extension
// ============================================================

// ----- Agent Roles -----

export type AgentRole =
  | 'briefBuilder'
  | 'brainstorm'
  | 'critic'
  | 'secondBrainstorm'
  | 'architect'
  | 'taskManager'
  | 'codeWorker'
  | 'reviewer'
  | 'tester'
  | 'fixer'
  | 'finalIntegrator';

// ----- Workflow Phases -----

export type WorkflowPhase =
  | 'idle'
  | 'intake'
  | 'briefing'
  | 'brainstorm'
  | 'critique'
  | 'second_brainstorm'
  | 'toolchain_discovery'
  | 'architecture'
  | 'waiting_for_user'
  | 'task_planning'
  | 'coding'
  | 'dependency_install'
  | 'reviewing'
  | 'testing'
  | 'fixing'
  | 'artifact_delivery'
  | 'final_integration'
  | 'completed'
  | 'failed'
  | 'stopped';

// ----- Task Status -----

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'needs_review'
  | 'needs_fix'
  | 'skipped';

// ----- Model Configuration -----

export interface ModelOptions {
  temperature?: number;
  num_ctx?: number;
  top_p?: number;
  num_predict?: number;
}

export interface AgentConfig {
  model: string;
  fallbackModel: string;
}

export interface SelfHealingConfig {
  enabled: boolean;
  modelCallRetries: number;
  retryDelayMs: number;
  alternateModelLimit: number;
  compactContextChars: number;
}

export interface CommandPolicyConfig {
  approvedPrefixes: string[];
  requireApprovalForNetwork: boolean;
  requireApprovalForExternalWrites: boolean;
  allowLongRunningSessions: boolean;
}

export interface WebSearchConfig {
  enabled: boolean;
  maxResults: number;
  officialDocsOnly: boolean;
  allowedDomains: string[];
}

export interface AppVerificationConfig {
  enabled: boolean;
  startServer: boolean;
  httpSmokeTest: boolean;
  browserSmokeTest: boolean;
}

export interface GitHubIntegrationConfig {
  enabled: boolean;
  preferGhCli: boolean;
  /**
   * Allow agents to read code from public GitHub/GitLab repositories on the
   * network (repo discovery + file reads) to learn from existing high-quality
   * code. Opt-in; independent from reading the local repository context.
   */
  allowExternalRepoReads?: boolean;
}

export interface SkillConfig {
  enabled: boolean;
  skillDirs: string[];
}

export interface ToolCallingConfig {
  enabled: boolean;
  maxToolRounds: number;
}

export interface ModelConfig {
  ollamaBaseUrl: string;
  requestTimeoutMs: number;
  safeMode: boolean;
  autonomousMode: boolean;
  askPolicy: 'allow' | 'never';
  debateRounds: number;
  maxFixRetries: number;
  autoInstallDependencies: boolean;
  artifactDir: string;
  createFinalArchive: boolean;
  requireVerificationScripts: boolean;
  selfHealing: SelfHealingConfig;
  commandPolicy: CommandPolicyConfig;
  webSearch: WebSearchConfig;
  appVerification: AppVerificationConfig;
  githubIntegration: GitHubIntegrationConfig;
  skills: SkillConfig;
  toolCalling: ToolCallingConfig;
  defaultOptions: ModelOptions;
  agents: Record<AgentRole, AgentConfig>;
}

// ----- Ollama API -----

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  keep_alive: number;
  format?: string;
  options?: ModelOptions;
}

export interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaCallLog {
  timestamp: string;
  agentRole: string;
  model: string;
  durationMs: number;
  success: boolean;
  error?: string;
  inputFiles: string[];
  outputFile: string;
  usedFallback?: boolean;
  tokenCount?: number;
}

// ----- Project State -----

export interface UserQuestion {
  id: string;
  agentRole: AgentRole;
  phase: WorkflowPhase;
  question: string;
  context?: string;
  answer?: string;
  answeredAt?: string;
}

export interface Decision {
  id: string;
  phase: WorkflowPhase;
  description: string;
  madeAt: string;
}

export interface ProjectState {
  projectGoal: string;
  status: 'idle' | 'running' | 'waiting_for_user' | 'completed' | 'failed' | 'stopped';
  currentPhase: WorkflowPhase;
  confirmedByUser: boolean;
  createdAt: string;
  updatedAt: string;
  openQuestions: UserQuestion[];
  decisions: Decision[];
  activeTasks: string[];
  completedTasks: string[];
  failedTasks: string[];
  currentTaskId: string | null;
  fixRetryCount: number;
}

// ----- Tasks -----

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  assignedAgent: AgentRole;
  model?: string;
  dependsOn: string[];
  allowedFiles: string[];
  forbiddenActions: string[];
  acceptanceCriteria: string[];
  status: TaskStatus;
  result?: string;
  reviewResult?: ReviewResult;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  retryCount?: number;
}

export interface TaskPlan {
  tasks: TaskItem[];
  totalTasks: number;
  estimatedComplexity: 'low' | 'medium' | 'high';
  notes?: string;
  createdAt: string;
}

export interface TaskResults {
  results: Record<string, TaskResult>;
  updatedAt: string;
}

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  files: FileChange[];
  notes?: string;
  completedAt: string;
}

// ----- Autonomous Project Brief -----

export interface ProjectBrief {
  projectName: string;
  goal: string;
  appType: string;
  targetPlatforms: string[];
  chosenStack: string[];
  coreFeatures: string[];
  assumptions: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  deliveryArtifacts: string[];
  buildAndRunCommands: string[];
  verificationCommands: string[];
}

// ----- Toolchain / Delivery -----

export interface ToolchainCheck {
  name: string;
  command: string;
  available: boolean;
  version?: string;
  error?: string;
}

export interface ToolchainReport {
  generatedAt: string;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  checks: ToolchainCheck[];
  missing: string[];
  notes: string[];
}

export interface GitStatusFile {
  path: string;
  rawStatus: string;
  indexStatus: string;
  workingTreeStatus: string;
  originalPath?: string;
}

export interface GitCommitSummary {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitRepositorySnapshot {
  generatedAt: string;
  workspaceRoot: string;
  isRepository: boolean;
  repositoryRoot?: string;
  branch?: string;
  head?: string;
  branchStatus?: string;
  ahead?: number;
  behind?: number;
  changedFiles: GitStatusFile[];
  changedFileCount: number;
  untrackedFileCount: number;
  recentCommits: GitCommitSummary[];
  unstagedDiffStat?: string;
  stagedDiffStat?: string;
  warnings: string[];
  error?: string;
}

export interface DeliveryManifest {
  generatedAt: string;
  artifactDir: string;
  archivePath?: string;
  archiveCommand?: string;
  archiveCreated: boolean;
  filesIncluded: string[];
  verificationLog?: string;
  toolchainReport?: ToolchainReport;
  gitSnapshot?: GitRepositorySnapshot;
  notes: string[];
}

// ----- Structured Memory -----

export interface StructuredMemoryEvent {
  timestamp: string;
  type:
    | 'activity'
    | 'assumption'
    | 'command'
    | 'diagnostic'
    | 'file_baseline'
    | 'github'
    | 'patch'
    | 'phase'
    | 'plan'
    | 'search'
    | 'skill'
    | 'tool'
    | 'verification';
  phase?: WorkflowPhase;
  agentRole?: AgentRole;
  taskId?: string;
  summary: string;
  data?: Record<string, unknown>;
}

// ----- File Operations -----

export interface FileSnapshot {
  path: string;
  exists: boolean;
  capturedAt: string;
  hash?: string;
  size?: number;
  mtimeMs?: number;
}

export interface FileChange {
  path: string;
  action: 'create' | 'modify' | 'append' | 'delete';
  content?: string;
  description?: string;
  patch?: string;
}

export interface CodeWorkerOutput {
  reasoning: string;
  files: FileChange[];
  needUserInput: boolean;
  questions: string[];
  blockedReason?: string;
  toolRequests?: ToolCallRequest[];
  toolResults?: ToolCallResult[];
}

// ----- Review -----

export interface ReviewResult {
  taskId: string;
  approved: boolean;
  issues: string[];
  suggestions: string[];
  securityConcerns: string[];
  needsFix: boolean;
  fixSuggestions: string[];
  uncertainties?: string[];
  reviewedAt: string;
}

// ----- Testing -----

export interface TesterOutput {
  passed: boolean;
  testsRun: number;
  errors: string[];
  warnings: string[];
  needsFix: boolean;
  fixDescription?: string;
  rawOutput?: string;
}

// ----- Terminal -----

export interface TerminalRunResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface TerminalSessionResult extends TerminalRunResult {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  timedOut: boolean;
}

// ----- Patches -----

export interface PatchResult {
  applied: boolean;
  approved: boolean;
  patchFile?: string;
  targetFiles: string[];
  preview: string;
  error?: string;
}

// ----- Architect -----

export interface ArchitectPlan {
  summary: string;
  technology: string[];
  projectStructure: string[];
  keyDecisions: string[];
  constraints: string[];
  needUserInput: boolean;
  questions: string[];
  readyToCode: boolean;
}

// ----- Timeline (for UI) -----

export interface TimelineEntry {
  phase: WorkflowPhase;
  agentRole?: AgentRole;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
}

export interface AgentActivity {
  id: string;
  timestamp: string;
  phase: WorkflowPhase;
  agentRole?: AgentRole;
  title: string;
  detail: string;
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'info' | 'warn';
  round?: number;
  totalRounds?: number;
  taskId?: string;
  files?: string[];
}

// ----- Webview Messages -----

export type WebviewToExtensionMessage =
  | { type: 'startProject'; prompt: string }
  | { type: 'resumeWorkflow' }
  | { type: 'stopWorkflow' }
  | { type: 'submitAnswer'; questionId: string; answer: string }
  | { type: 'openNotes' }
  | { type: 'openSettings' }
  | { type: 'ready' }
  | { type: 'requestState' }
  | { type: 'approvePatch'; patchId: string; approved: boolean }
  | { type: 'approveCommand'; commandId: string; approved: boolean };

export type ExtensionToWebviewMessage =
  | { type: 'updateState'; state: ProjectState }
  | { type: 'updatePhase'; phase: WorkflowPhase; message: string }
  | { type: 'updateTasks'; tasks: TaskItem[] }
  | { type: 'updateActivities'; activities: AgentActivity[] }
  | { type: 'appendLog'; log: string; level: 'info' | 'warn' | 'error' }
  | { type: 'askQuestion'; question: UserQuestion }
  | { type: 'updateTimeline'; timeline: TimelineEntry[] }
  | { type: 'finalReport'; report: string }
  | { type: 'error'; message: string }
  | { type: 'info'; message: string }
  | { type: 'showPatchApproval'; patchId: string; preview: string; targetFiles: string[] }
  | { type: 'showCommandApproval'; commandId: string; command: string; reason: string };

// ----- Web Fetcher -----

export interface WebFetchResult {
  url: string;
  success: boolean;
  text: string;
  error?: string;
}

export interface SearchResult {
  file: string;
  line: number;
  text: string;
}

export interface RepositorySearchReport {
  generatedAt: string;
  queries: string[];
  results: SearchResult[];
  filesInspected: string[];
  warnings: string[];
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  id: string;
  name: string;
  success: boolean;
  output: string;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  safe: boolean;
}

export interface SkillDescriptor {
  name: string;
  path: string;
  description: string;
  triggers: string[];
}

export interface SkillMatch {
  skill: SkillDescriptor;
  score: number;
  matchedTriggers: string[];
}

export interface GitHubRepositoryContext {
  generatedAt: string;
  available: boolean;
  remoteUrl?: string;
  owner?: string;
  repo?: string;
  currentBranch?: string;
  pullRequestNumber?: number;
  warnings: string[];
}

export interface AppVerificationResult {
  generatedAt: string;
  checks: TerminalRunResult[];
  smokeUrls: string[];
  warnings: string[];
  failed: boolean;
  summary: string;
}

export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  evidence: string[];
  nextAction?: string;
}

export interface AutonomousPlanReport {
  generatedAt: string;
  goal: string;
  steps: PlanStep[];
  currentStep?: string;
  summary: string;
}

// ----- Orchestrator Callbacks -----

export interface OrchestratorCallbacks {
  onPhaseChange?: (phase: WorkflowPhase, message: string) => void;
  onLog?: (message: string, level: 'info' | 'warn' | 'error') => void;
  onQuestionNeeded?: (question: UserQuestion) => void;
  onTaskUpdate?: (tasks: TaskItem[]) => void;
  onTimelineUpdate?: (timeline: TimelineEntry[]) => void;
  onActivityUpdate?: (activities: AgentActivity[]) => void;
  onComplete?: (report: string) => void;
  onError?: (error: string) => void;
  onStateUpdate?: (state: ProjectState) => void;
  onPatchApprovalNeeded?: (patchId: string, preview: string, targetFiles: string[]) => void;
  onCommandApprovalNeeded?: (commandId: string, command: string, reason: string) => void;
}
