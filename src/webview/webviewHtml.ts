/**
 * Returns the full HTML content for the Local Multi-Agent Coder webview.
 * @param nonce CSP nonce for the inline script tag
 */
export function getWebviewContent(nonce: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Local Multi-Agent Coder</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    :root {
      --surface: var(--vscode-sideBar-background, #181818);
      --panel: var(--vscode-editor-background, #1f1f1f);
      --panel-soft: var(--vscode-list-inactiveSelectionBackground, #272727);
      --border: var(--vscode-panel-border, #3a3a3a);
      --text: var(--vscode-foreground, #d4d4d4);
      --muted: var(--vscode-descriptionForeground, #9a9a9a);
      --accent: var(--vscode-focusBorder, #007acc);
      --success: #3fb950;
      --warn: #d29922;
      --danger: #f85149;
      --info: #58a6ff;
    }

    body {
      margin: 0;
      padding: 10px;
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.45;
      color: var(--text);
      background: var(--surface);
    }

    button, textarea, input { font: inherit; }

    .app-shell {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .app-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 2px 0 4px;
    }

    .brand {
      min-width: 0;
    }

    .brand-title {
      margin: 0;
      font-size: 1.05em;
      font-weight: 650;
      letter-spacing: 0;
    }

    .brand-subtitle {
      margin-top: 2px;
      color: var(--muted);
      font-size: 0.85em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-pill {
      flex-shrink: 0;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 0.78em;
      font-weight: 650;
      text-transform: uppercase;
    }

    .status-idle, .status-stopped { color: var(--muted); }
    .status-running { color: var(--info); border-color: color-mix(in srgb, var(--info) 55%, var(--border)); }
    .status-waiting { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, var(--border)); }
    .status-completed { color: var(--success); border-color: color-mix(in srgb, var(--success) 55%, var(--border)); }
    .status-failed { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); }

    .panel {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 6px;
      overflow: hidden;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 9px;
      background: var(--vscode-sideBarSectionHeader-background, var(--panel-soft));
      cursor: pointer;
      user-select: none;
    }

    .panel-title {
      margin: 0;
      font-size: 0.92em;
      font-weight: 650;
    }

    .panel-body {
      padding: 9px;
    }

    .panel-body.collapsed { display: none; }
    .chevron { color: var(--muted); transition: transform 0.15s ease; }
    .collapsed .chevron { transform: rotate(-90deg); }

    textarea {
      display: block;
      width: 100%;
      min-height: 82px;
      resize: vertical;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      padding: 7px 8px;
    }

    textarea:focus, input:focus {
      outline: 1px solid var(--accent);
      border-color: var(--accent);
    }

    input[type="text"] {
      width: 100%;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      padding: 6px 8px;
    }

    .button-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    button {
      min-height: 28px;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 4px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }

    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }

    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

    button.danger {
      color: var(--vscode-inputValidation-errorForeground, #fff);
      background: var(--vscode-inputValidation-errorBackground, #4b1d1d);
      border-color: var(--vscode-inputValidation-errorBorder, #8b3434);
    }

    .current {
      display: grid;
      gap: 8px;
    }

    .current-kicker {
      color: var(--muted);
      font-size: 0.78em;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .current-title {
      margin: 0;
      font-size: 1.04em;
      font-weight: 700;
    }

    .current-detail {
      color: var(--muted);
      font-size: 0.9em;
    }

    .meter {
      height: 6px;
      border-radius: 999px;
      overflow: hidden;
      background: var(--panel-soft);
      border: 1px solid var(--border);
    }

    .meter-fill {
      width: 0%;
      height: 100%;
      background: var(--accent);
      transition: width 0.2s ease;
    }

    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }

    .chip {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 7px;
      color: var(--muted);
      background: color-mix(in srgb, var(--panel-soft) 75%, transparent);
      font-size: 0.78em;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
    }

    .stat {
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 7px;
      background: var(--panel);
    }

    .stat-value {
      font-size: 1.1em;
      font-weight: 700;
    }

    .stat-label {
      color: var(--muted);
      font-size: 0.75em;
      margin-top: 1px;
    }

    .pipeline-list, .task-list, .activity-list { list-style: none; padding: 0; margin: 0; }

    .pipeline-item {
      position: relative;
      display: grid;
      grid-template-columns: 16px 1fr auto;
      gap: 7px;
      align-items: start;
      padding: 6px 0;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    }

    .pipeline-item:last-child { border-bottom: 0; }

    .dot {
      width: 10px;
      height: 10px;
      margin-top: 4px;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: var(--panel-soft);
    }

    .dot-running { background: var(--info); box-shadow: 0 0 0 3px color-mix(in srgb, var(--info) 16%, transparent); }
    .dot-completed { background: var(--success); }
    .dot-failed { background: var(--danger); }
    .dot-skipped { background: var(--muted); opacity: 0.7; }

    .pipeline-label {
      font-weight: 600;
      font-size: 0.9em;
    }

    .pipeline-meta {
      color: var(--muted);
      font-size: 0.78em;
      margin-top: 1px;
    }

    .status-text {
      color: var(--muted);
      font-size: 0.75em;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .debate-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }

    .debate-lane {
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 8px;
      background: var(--panel-soft);
    }

    .lane-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 5px;
    }

    .lane-title { font-weight: 650; }
    .lane-round { color: var(--muted); font-size: 0.78em; }
    .lane-detail { color: var(--muted); font-size: 0.86em; }

    .task-item {
      display: grid;
      grid-template-columns: 16px 1fr;
      gap: 7px;
      padding: 6px 0;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    }

    .task-item:last-child { border-bottom: 0; }

    .task-title {
      font-weight: 600;
      font-size: 0.9em;
    }

    .task-detail {
      color: var(--muted);
      font-size: 0.78em;
      margin-top: 1px;
    }

    .activity-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 260px;
      overflow-y: auto;
    }

    .activity-item {
      border: 1px solid var(--border);
      border-left-width: 3px;
      border-radius: 5px;
      padding: 7px;
      background: var(--panel);
    }

    .activity-running { border-left-color: var(--info); }
    .activity-completed { border-left-color: var(--success); }
    .activity-failed { border-left-color: var(--danger); }
    .activity-warn { border-left-color: var(--warn); }
    .activity-info, .activity-skipped { border-left-color: var(--muted); }

    .activity-title {
      font-weight: 650;
      font-size: 0.88em;
      margin-bottom: 2px;
    }

    .activity-detail {
      color: var(--muted);
      font-size: 0.8em;
      word-break: break-word;
    }

    .activity-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
    }

    .empty {
      color: var(--muted);
      font-size: 0.86em;
      padding: 6px 0;
    }

    .log-container {
      max-height: 180px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--vscode-terminal-background, #111);
      padding: 6px 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
    }

    .log-line { margin: 1px 0; white-space: pre-wrap; word-break: break-word; }
    .log-info { color: var(--vscode-terminal-foreground, #ccc); }
    .log-warn { color: var(--warn); }
    .log-error { color: var(--danger); }

    .question-box, .patch-box {
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 8px;
      margin-bottom: 8px;
      background: var(--panel-soft);
    }

    .patch-preview, .report-content {
      max-height: 260px;
      overflow-y: auto;
      margin: 6px 0;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 7px;
      background: var(--panel);
      color: var(--text);
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
    }

    .hidden { display: none !important; }

    @media (max-width: 260px) {
      .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .pipeline-item { grid-template-columns: 14px 1fr; }
      .status-text { display: none; }
    }
  </style>
</head>
<body>
  <main class="app-shell">
    <header class="app-header">
      <div class="brand">
        <h1 class="brand-title">Local Agent Coder</h1>
        <div class="brand-subtitle" id="phase-display">Ready to start a new project.</div>
      </div>
      <span class="status-pill status-idle" id="status-badge">idle</span>
    </header>

    <section class="panel" id="sec-prompt">
      <div class="panel-header" data-section="sec-prompt">
        <h2 class="panel-title">Project Prompt</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-prompt-body">
        <textarea id="prompt-input" placeholder="Describe the project to build. Example: Build an arcade game for iOS and Android."></textarea>
        <div class="button-row">
          <button id="btn-start" title="Start autonomous workflow">Start</button>
          <button id="btn-resume" class="secondary" title="Resume paused workflow" disabled>Resume</button>
          <button id="btn-stop" class="danger" title="Stop after the current step" disabled>Stop</button>
        </div>
      </div>
    </section>

    <section class="panel" id="sec-current">
      <div class="panel-header" data-section="sec-current">
        <h2 class="panel-title">Current Work</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-current-body">
        <div class="current">
          <div class="current-kicker" id="current-kicker">Idle</div>
          <h2 class="current-title" id="current-title">Waiting for a prompt</h2>
          <div class="current-detail" id="current-detail">The next run will show each model phase, debate round, task, and verification step here.</div>
          <div class="meter"><div class="meter-fill" id="progress-fill"></div></div>
          <div class="chip-row" id="current-chips"></div>
        </div>
      </div>
    </section>

    <section class="stats-grid" aria-label="Workflow stats">
      <div class="stat"><div class="stat-value" id="stat-progress">0%</div><div class="stat-label">Progress</div></div>
      <div class="stat"><div class="stat-value" id="stat-active">0</div><div class="stat-label">Active</div></div>
      <div class="stat"><div class="stat-value" id="stat-done">0</div><div class="stat-label">Done</div></div>
      <div class="stat"><div class="stat-value" id="stat-failed">0</div><div class="stat-label">Failed</div></div>
    </section>

    <section class="panel" id="sec-pipeline">
      <div class="panel-header" data-section="sec-pipeline">
        <h2 class="panel-title">Pipeline</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-pipeline-body">
        <ul class="pipeline-list" id="timeline-list">
          <li class="empty">Waiting to start.</li>
        </ul>
      </div>
    </section>

    <section class="panel" id="sec-debate">
      <div class="panel-header" data-section="sec-debate">
        <h2 class="panel-title">Debate Board</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-debate-body">
        <div class="debate-grid" id="debate-board">
          <div class="empty">Debate rounds will appear after the brainstorm phase starts.</div>
        </div>
      </div>
    </section>

    <section class="panel" id="sec-tasks">
      <div class="panel-header" data-section="sec-tasks">
        <h2 class="panel-title">Tasks</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-tasks-body">
        <ul class="task-list" id="task-list">
          <li class="empty">No tasks yet.</li>
        </ul>
      </div>
    </section>

    <section class="panel hidden" id="sec-questions">
      <div class="panel-header" data-section="sec-questions">
        <h2 class="panel-title">Input Needed</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-questions-body">
        <div id="questions-container"></div>
      </div>
    </section>

    <section class="panel hidden" id="sec-patch">
      <div class="panel-header" data-section="sec-patch">
        <h2 class="panel-title">File Approval</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-patch-body">
        <div id="patch-container"></div>
      </div>
    </section>

    <section class="panel hidden" id="sec-command">
      <div class="panel-header" data-section="sec-command">
        <h2 class="panel-title">Command Approval</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-command-body">
        <div id="command-container"></div>
      </div>
    </section>

    <section class="panel" id="sec-activity">
      <div class="panel-header" data-section="sec-activity">
        <h2 class="panel-title">Activity Feed</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-activity-body">
        <div class="activity-list" id="activity-list">
          <div class="empty">No model activity yet.</div>
        </div>
      </div>
    </section>

    <section class="panel" id="sec-logs">
      <div class="panel-header" data-section="sec-logs">
        <h2 class="panel-title">Logs</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-logs-body">
        <div class="log-container" id="log-container">
          <div class="log-line log-info">Extension loaded. Ready.</div>
        </div>
        <div class="button-row">
          <button id="btn-clear-logs" class="secondary" title="Clear visible logs">Clear</button>
          <button id="btn-open-notes" class="secondary" title="Open agent output files">Notes</button>
          <button id="btn-open-settings" class="secondary" title="Open model settings">Settings</button>
        </div>
      </div>
    </section>

    <section class="panel hidden" id="sec-report">
      <div class="panel-header" data-section="sec-report">
        <h2 class="panel-title">Final Report</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-report-body">
        <pre class="report-content" id="report-content"></pre>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    let latestState = null;
    let latestTimeline = [];
    let latestTasks = [];
    let latestActivities = [];
    let currentPhase = 'idle';
    let currentMessage = 'Ready to start a new project.';

    wireEvents();
    renderAll();

    function wireEvents() {
      document.querySelectorAll('.panel-header[data-section]').forEach(header => {
        header.addEventListener('click', () => toggleSection(header.getAttribute('data-section')));
      });

      document.getElementById('btn-start').addEventListener('click', startProject);
      document.getElementById('btn-resume').addEventListener('click', resumeWorkflow);
      document.getElementById('btn-stop').addEventListener('click', stopWorkflow);
      document.getElementById('btn-clear-logs').addEventListener('click', clearLogs);
      document.getElementById('btn-open-notes').addEventListener('click', openNotes);
      document.getElementById('btn-open-settings').addEventListener('click', openSettings);

      document.getElementById('questions-container').addEventListener('click', event => {
        const button = getActionButton(event, 'submit-answer');
        if (button) { submitAnswer(button.dataset.questionId); }
      });

      document.getElementById('patch-container').addEventListener('click', event => {
        const applyButton = getActionButton(event, 'apply-patch');
        const rejectButton = getActionButton(event, 'reject-patch');
        if (applyButton) { approvePatch(applyButton.dataset.patchId, true); }
        if (rejectButton) { approvePatch(rejectButton.dataset.patchId, false); }
      });

      document.getElementById('command-container').addEventListener('click', event => {
        const runButton = getActionButton(event, 'run-command');
        const rejectButton = getActionButton(event, 'reject-command');
        if (runButton) { approveCommand(runButton.dataset.commandId, true); }
        if (rejectButton) { approveCommand(rejectButton.dataset.commandId, false); }
      });
    }

    function getActionButton(event, action) {
      if (!event.target || !event.target.closest) { return null; }
      return event.target.closest('button[data-action="' + action + '"]');
    }

    function toggleSection(id) {
      if (!id) { return; }
      const section = document.getElementById(id);
      const body = document.getElementById(id + '-body');
      if (!section || !body) { return; }
      body.classList.toggle('collapsed');
      section.classList.toggle('collapsed');
    }

    function startProject() {
      const prompt = document.getElementById('prompt-input').value.trim();
      if (!prompt) {
        appendLog('Please enter a project description.', 'warn');
        return;
      }
      latestState = {
        ...(latestState || {}),
        status: 'running',
        currentPhase: 'intake',
        projectGoal: prompt,
        activeTasks: [],
        completedTasks: [],
        failedTasks: [],
        openQuestions: []
      };
      currentPhase = 'intake';
      currentMessage = 'Checking workspace and Ollama before starting...';
      latestActivities = [];
      appendLog('Start requested. Checking workspace and Ollama...', 'info');
      renderAll();
      renderActivities();
      vscode.postMessage({ type: 'startProject', prompt });
    }

    function resumeWorkflow() {
      appendLog('Resume requested.', 'info');
      vscode.postMessage({ type: 'resumeWorkflow' });
    }
    function stopWorkflow() {
      currentMessage = 'Stop requested. Cancelling active work...';
      appendLog('Stop requested. Cancelling active work...', 'warn');
      renderCurrentWork();
      vscode.postMessage({ type: 'stopWorkflow' });
    }
    function openNotes() { vscode.postMessage({ type: 'openNotes' }); }
    function openSettings() { vscode.postMessage({ type: 'openSettings' }); }
    function clearLogs() { document.getElementById('log-container').innerHTML = ''; }

    function submitAnswer(questionId) {
      const input = document.getElementById('answer-' + questionId);
      if (!input) { return; }
      const answer = input.value.trim();
      if (!answer) {
        appendLog('Please enter an answer.', 'warn');
        return;
      }
      vscode.postMessage({ type: 'submitAnswer', questionId, answer });
      const box = document.getElementById('qbox-' + questionId);
      if (box) { box.remove(); }
      updateVisibility('questions-container', 'sec-questions');
    }

    function approvePatch(patchId, approved) {
      if (!patchId) { return; }
      vscode.postMessage({ type: 'approvePatch', patchId, approved });
      const box = document.getElementById('patch-' + patchId);
      if (box) { box.remove(); }
      updateVisibility('patch-container', 'sec-patch');
    }

    function approveCommand(commandId, approved) {
      if (!commandId) { return; }
      vscode.postMessage({ type: 'approveCommand', commandId, approved });
      const box = document.getElementById('command-' + commandId);
      if (box) { box.remove(); }
      updateVisibility('command-container', 'sec-command');
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'updateState':
          latestState = msg.state;
          currentPhase = msg.state?.currentPhase || currentPhase;
          if (msg.state?.projectGoal) {
            document.getElementById('prompt-input').value = msg.state.projectGoal;
          }
          renderQuestions(msg.state?.openQuestions || []);
          renderAll();
          break;
        case 'updatePhase':
          currentPhase = msg.phase;
          currentMessage = msg.message || phaseLabel(msg.phase);
          renderCurrentWork();
          break;
        case 'updateTasks':
          latestTasks = msg.tasks || [];
          renderStats();
          renderTasks();
          break;
        case 'updateTimeline':
          latestTimeline = msg.timeline || [];
          renderStats();
          renderTimeline();
          renderCurrentWork();
          break;
        case 'updateActivities':
          latestActivities = msg.activities || [];
          renderCurrentWork();
          renderDebateBoard();
          renderActivities();
          break;
        case 'appendLog':
          appendLog(msg.log, msg.level || 'info');
          break;
        case 'askQuestion':
          showQuestion(msg.question);
          break;
        case 'finalReport':
          showFinalReport(msg.report);
          break;
        case 'error':
          appendLog('ERROR: ' + msg.message, 'error');
          break;
        case 'info':
          appendLog(msg.message, 'info');
          break;
        case 'showPatchApproval':
          showPatchApproval(msg.patchId, msg.preview, msg.targetFiles);
          break;
        case 'showCommandApproval':
          showCommandApproval(msg.commandId, msg.command, msg.reason);
          break;
      }
    });

    function renderAll() {
      renderHeader();
      renderStats();
      renderCurrentWork();
      renderTimeline();
      renderDebateBoard();
      renderTasks();
      renderActivities();
    }

    function renderHeader() {
      const status = latestState?.status || 'idle';
      const badge = document.getElementById('status-badge');
      badge.textContent = status === 'waiting_for_user' ? 'waiting' : status;
      badge.className = 'status-pill status-' + (status === 'waiting_for_user' ? 'waiting' : status);
      document.getElementById('phase-display').textContent = phaseLabel(currentPhase);
      updateButtons(status);
    }

    function updateButtons(status) {
      const running = status === 'running';
      const resumable = status === 'waiting_for_user' || status === 'stopped';
      document.getElementById('btn-start').disabled = running;
      document.getElementById('btn-resume').disabled = !resumable || running;
      document.getElementById('btn-stop').disabled = !running;
    }

    function renderStats() {
      const total = latestTimeline.length;
      const done = latestTimeline.filter(item => item.status === 'completed' || item.status === 'skipped').length;
      const progress = total ? Math.round((done / total) * 100) : 0;
      const activeTasks = latestTasks.filter(task => task.status === 'in_progress' || task.status === 'needs_fix').length;
      const doneTasks = latestTasks.filter(task => task.status === 'completed').length;
      const failedTasks = latestTasks.filter(task => task.status === 'failed').length;
      document.getElementById('stat-progress').textContent = progress + '%';
      document.getElementById('stat-active').textContent = String(activeTasks);
      document.getElementById('stat-done').textContent = String(doneTasks);
      document.getElementById('stat-failed').textContent = String(failedTasks);
      document.getElementById('progress-fill').style.width = progress + '%';
    }

    function renderCurrentWork() {
      const activity = latestActivities.find(item => item.status === 'running') || latestActivities[0];
      const phase = activity?.phase || currentPhase;
      const title = activity?.title || phaseLabel(phase);
      const detail = activity?.detail || currentMessage || 'Waiting for model activity.';
      document.getElementById('current-kicker').textContent = activity?.agentRole ? agentLabel(activity.agentRole) : phaseLabel(phase);
      document.getElementById('current-title').textContent = title;
      document.getElementById('current-detail').textContent = detail;

      const chips = [];
      if (activity?.round && activity?.totalRounds) { chips.push('Round ' + activity.round + '/' + activity.totalRounds); }
      if (activity?.taskId) { chips.push(activity.taskId); }
      if (activity?.files?.length) { chips.push(activity.files.length + ' file(s)'); }
      chips.push((latestState?.status || 'idle').replace(/_/g, ' '));
      document.getElementById('current-chips').innerHTML = chips.map(chip => '<span class="chip">' + escapeHtml(chip) + '</span>').join('');
    }

    function renderTimeline() {
      const list = document.getElementById('timeline-list');
      if (!latestTimeline.length) {
        list.innerHTML = '<li class="empty">Waiting to start.</li>';
        return;
      }
      list.innerHTML = latestTimeline.map(entry => {
        const meta = entry.agentRole ? agentLabel(entry.agentRole) : phaseLabel(entry.phase);
        return '<li class="pipeline-item">' +
          '<span class="dot dot-' + escapeHtml(entry.status || 'pending') + '"></span>' +
          '<div><div class="pipeline-label">' + escapeHtml(entry.label) + '</div>' +
          '<div class="pipeline-meta">' + escapeHtml(meta) + '</div></div>' +
          '<span class="status-text">' + escapeHtml(entry.status || 'pending') + '</span>' +
          '</li>';
      }).join('');
    }

    function renderDebateBoard() {
      const board = document.getElementById('debate-board');
      const critic = latestActivities.find(item => item.phase === 'critique');
      const product = latestActivities.find(item => item.phase === 'second_brainstorm');
      if (!critic && !product) {
        board.innerHTML = '<div class="empty">Debate rounds will appear after the brainstorm phase starts.</div>';
        return;
      }
      board.innerHTML = [
        renderDebateLane('Critic', 'Requirements, security, risk, scope', critic),
        renderDebateLane('Product', 'UX, workflow, developer experience, delivery', product)
      ].join('');
    }

    function renderDebateLane(title, fallback, activity) {
      const round = activity?.round && activity?.totalRounds ? 'Round ' + activity.round + '/' + activity.totalRounds : (activity ? activity.status : 'pending');
      const detail = activity?.detail || fallback;
      return '<div class="debate-lane">' +
        '<div class="lane-head"><div class="lane-title">' + escapeHtml(title) + '</div><div class="lane-round">' + escapeHtml(round) + '</div></div>' +
        '<div class="lane-detail">' + escapeHtml(detail) + '</div>' +
        '</div>';
    }

    function renderTasks() {
      const list = document.getElementById('task-list');
      if (!latestTasks.length) {
        list.innerHTML = '<li class="empty">No tasks yet.</li>';
        return;
      }
      list.innerHTML = latestTasks.map(task => {
        const status = task.status || 'pending';
        const files = Array.isArray(task.allowedFiles) ? task.allowedFiles.slice(0, 3).join(', ') : '';
        return '<li class="task-item">' +
          '<span class="dot dot-' + statusToDot(status) + '"></span>' +
          '<div><div class="task-title">' + escapeHtml('[' + task.id + '] ' + task.title) + '</div>' +
          '<div class="task-detail">' + escapeHtml(status.replace(/_/g, ' ') + (files ? ' - ' + files : '')) + '</div></div>' +
          '</li>';
      }).join('');
    }

    function renderActivities() {
      const list = document.getElementById('activity-list');
      if (!latestActivities.length) {
        list.innerHTML = '<div class="empty">No model activity yet.</div>';
        return;
      }
      list.innerHTML = latestActivities.slice(0, 35).map(item => {
        const chips = [];
        chips.push(phaseLabel(item.phase));
        if (item.agentRole) { chips.push(agentLabel(item.agentRole)); }
        if (item.round && item.totalRounds) { chips.push('Round ' + item.round + '/' + item.totalRounds); }
        if (item.taskId) { chips.push(item.taskId); }
        return '<div class="activity-item activity-' + escapeHtml(item.status) + '">' +
          '<div class="activity-title">' + escapeHtml(item.title) + '</div>' +
          '<div class="activity-detail">' + escapeHtml(item.detail) + '</div>' +
          '<div class="activity-meta">' + chips.map(chip => '<span class="chip">' + escapeHtml(chip) + '</span>').join('') + '</div>' +
          '</div>';
      }).join('');
    }

    function renderQuestions(questions) {
      const container = document.getElementById('questions-container');
      container.innerHTML = '';
      (questions || []).forEach(showQuestion);
      updateVisibility('questions-container', 'sec-questions');
    }

    function showQuestion(question) {
      const container = document.getElementById('questions-container');
      if (document.getElementById('qbox-' + question.id)) { return; }
      const box = document.createElement('div');
      box.className = 'question-box';
      box.id = 'qbox-' + question.id;
      box.innerHTML =
        '<div class="activity-title">' + escapeHtml(agentLabel(question.agentRole)) + '</div>' +
        '<div class="activity-detail">' + escapeHtml(question.question) + '</div>' +
        '<input type="text" id="answer-' + escapeHtml(question.id) + '" placeholder="Answer">' +
        '<div class="button-row"><button data-action="submit-answer" data-question-id="' + escapeHtml(question.id) + '">Submit</button></div>';
      container.appendChild(box);
      document.getElementById('sec-questions').classList.remove('hidden');
    }

    function showPatchApproval(patchId, preview, targetFiles) {
      const container = document.getElementById('patch-container');
      const box = document.createElement('div');
      box.className = 'patch-box';
      box.id = 'patch-' + patchId;
      box.innerHTML =
        '<div class="activity-title">Approve file changes</div>' +
        '<div class="activity-detail">' + escapeHtml((targetFiles || []).join(', ')) + '</div>' +
        '<div class="patch-preview">' + escapeHtml((preview || '').substring(0, 3000)) + '</div>' +
        '<div class="button-row">' +
        '<button data-action="apply-patch" data-patch-id="' + escapeHtml(patchId) + '">Apply</button>' +
        '<button class="danger" data-action="reject-patch" data-patch-id="' + escapeHtml(patchId) + '">Reject</button>' +
        '</div>';
      container.appendChild(box);
      document.getElementById('sec-patch').classList.remove('hidden');
    }

    function showCommandApproval(commandId, command, reason) {
      const container = document.getElementById('command-container');
      if (document.getElementById('command-' + commandId)) { return; }
      const box = document.createElement('div');
      box.className = 'patch-box';
      box.id = 'command-' + commandId;
      box.innerHTML =
        '<div class="activity-title">Approve command</div>' +
        '<div class="activity-detail">' + escapeHtml(reason || '') + '</div>' +
        '<div class="patch-preview">' + escapeHtml(command || '') + '</div>' +
        '<div class="button-row">' +
        '<button data-action="run-command" data-command-id="' + escapeHtml(commandId) + '">Run</button>' +
        '<button class="danger" data-action="reject-command" data-command-id="' + escapeHtml(commandId) + '">Reject</button>' +
        '</div>';
      container.appendChild(box);
      document.getElementById('sec-command').classList.remove('hidden');
    }

    function updateVisibility(containerId, sectionId) {
      const container = document.getElementById(containerId);
      const section = document.getElementById(sectionId);
      if (!container || !section) { return; }
      section.classList.toggle('hidden', container.children.length === 0);
    }

    function appendLog(message, level) {
      const container = document.getElementById('log-container');
      const line = document.createElement('div');
      line.className = 'log-line log-' + (level || 'info');
      line.textContent = '[' + new Date().toTimeString().slice(0, 8) + '] ' + message;
      container.appendChild(line);
      while (container.children.length > 350) {
        container.removeChild(container.firstChild);
      }
      container.scrollTop = container.scrollHeight;
    }

    function showFinalReport(report) {
      document.getElementById('report-content').textContent = report;
      document.getElementById('sec-report').classList.remove('hidden');
      document.getElementById('sec-report').scrollIntoView({ behavior: 'smooth' });
    }

    function phaseLabel(phase) {
      const labels = {
        idle: 'Idle',
        intake: 'Reading prompt',
        briefing: 'Autonomous brief',
        brainstorm: 'Brainstorm',
        critique: 'Critic debate',
        second_brainstorm: 'Product debate',
        toolchain_discovery: 'Toolchain discovery',
        architecture: 'Architecture',
        waiting_for_user: 'Waiting for input',
        task_planning: 'Task planning',
        coding: 'Coding',
        dependency_install: 'Dependency install',
        reviewing: 'Review',
        testing: 'Verification',
        fixing: 'Fixing',
        artifact_delivery: 'Artifact delivery',
        final_integration: 'Final report',
        completed: 'Completed',
        failed: 'Failed',
        stopped: 'Stopped'
      };
      return labels[phase] || String(phase || '').replace(/_/g, ' ');
    }

    function agentLabel(role) {
      const labels = {
        briefBuilder: 'Brief Builder',
        brainstorm: 'Brainstorm',
        critic: 'Critic',
        secondBrainstorm: 'Product',
        architect: 'Architect',
        taskManager: 'Task Manager',
        codeWorker: 'Code Worker',
        reviewer: 'Reviewer',
        tester: 'Tester',
        fixer: 'Fixer',
        finalIntegrator: 'Final Integrator'
      };
      return labels[role] || role || '';
    }

    function statusToDot(status) {
      if (status === 'in_progress' || status === 'needs_fix' || status === 'needs_review') { return 'running'; }
      if (status === 'completed') { return 'completed'; }
      if (status === 'failed') { return 'failed'; }
      if (status === 'skipped') { return 'skipped'; }
      return 'pending';
    }

    function escapeHtml(value) {
      const text = typeof value === 'string' ? value : String(value ?? '');
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'requestState' });
  </script>
</body>
</html>`;
}
