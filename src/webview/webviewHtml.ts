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

    .brand { min-width: 0; }
    .brand-title { margin: 0; font-size: 1.05em; font-weight: 650; }
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
    .panel-title { margin: 0; font-size: 0.92em; font-weight: 650; }
    .panel-body { padding: 9px; }
    .panel-body.collapsed { display: none; }
    .chevron { color: var(--muted); transition: transform 0.15s ease; }
    .collapsed .chevron { transform: rotate(-90deg); }

    textarea {
      display: block;
      width: 100%;
      min-height: 72px;
      resize: vertical;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      padding: 7px 8px;
    }
    textarea:focus, input:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
    input[type="text"] {
      width: 100%;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      padding: 6px 8px;
    }

    .button-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
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
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.danger {
      color: var(--vscode-inputValidation-errorForeground, #fff);
      background: var(--vscode-inputValidation-errorBackground, #4b1d1d);
      border-color: var(--vscode-inputValidation-errorBorder, #8b3434);
    }
    button.link {
      background: none;
      border: none;
      color: var(--accent);
      padding: 0;
      min-height: auto;
      font-size: 0.85em;
    }

    .meter { height: 5px; border-radius: 999px; overflow: hidden; background: var(--panel-soft); border: 1px solid var(--border); }
    .meter-fill { width: 0%; height: 100%; background: var(--accent); transition: width 0.2s ease; }

    .chip-row { display: flex; flex-wrap: wrap; gap: 5px; }
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

    .stats-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
    .stat { min-width: 0; border: 1px solid var(--border); border-radius: 5px; padding: 7px; background: var(--panel); }
    .stat-value { font-size: 1.1em; font-weight: 700; }
    .stat-label { color: var(--muted); font-size: 0.75em; margin-top: 1px; }

    /* ---- Chain of thought: one unified, ordered reasoning/task trace ---- */
    .chain-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; }

    .chain-step {
      position: relative;
      padding: 0 0 12px 22px;
      border-left: 2px solid var(--border);
      margin-left: 7px;
    }
    .chain-step:last-child { border-left-color: transparent; padding-bottom: 0; }

    .chain-dot {
      position: absolute;
      left: -8px;
      top: 1px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 2px solid var(--panel);
      background: var(--panel-soft);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 8px;
      color: #fff;
    }
    .chain-dot.dot-running { background: var(--info); animation: chainPulse 1.3s ease-in-out infinite; }
    .chain-dot.dot-completed { background: var(--success); }
    .chain-dot.dot-completed::before { content: "\\2713"; }
    .chain-dot.dot-failed { background: var(--danger); }
    .chain-dot.dot-failed::before { content: "\\2715"; }
    .chain-dot.dot-skipped { background: var(--muted); opacity: 0.65; }
    @keyframes chainPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

    .chain-step-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    .chain-step-label { font-weight: 650; font-size: 0.92em; }
    .chain-step[data-status="completed"] .chain-step-label,
    .chain-step[data-status="skipped"] .chain-step-label { color: var(--muted); font-weight: 600; }
    .chain-step-status { color: var(--muted); font-size: 0.75em; text-transform: uppercase; flex-shrink: 0; }

    .chain-step-detail { color: var(--muted); font-size: 0.85em; margin-top: 2px; }

    .chain-sub-list {
      list-style: none;
      margin: 7px 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .chain-step.collapsed .chain-sub-list { display: none; }

    .chain-sub-item {
      border: 1px solid var(--border);
      border-left-width: 3px;
      border-radius: 5px;
      padding: 6px 8px;
      background: var(--panel-soft);
      font-size: 0.85em;
    }
    .chain-sub-item.sub-running { border-left-color: var(--info); }
    .chain-sub-item.sub-completed { border-left-color: var(--success); }
    .chain-sub-item.sub-failed { border-left-color: var(--danger); }
    .chain-sub-item.sub-warn { border-left-color: var(--warn); }
    .chain-sub-item.sub-info, .chain-sub-item.sub-skipped { border-left-color: var(--muted); }
    .chain-sub-title { font-weight: 600; }
    .chain-sub-body { color: var(--muted); margin-top: 1px; word-break: break-word; }
    .chain-sub-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }

    .chain-task-mini { display: flex; align-items: center; gap: 6px; font-size: 0.85em; padding: 2px 0; }
    .chain-task-mini .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--panel-soft); border: 1px solid var(--border); }
    .chain-task-mini .dot-running { background: var(--info); }
    .chain-task-mini .dot-completed { background: var(--success); }
    .chain-task-mini .dot-failed { background: var(--danger); }
    .chain-task-mini .dot-skipped { background: var(--muted); }
    .chain-task-mini .task-mini-label { color: var(--text); }
    .chain-task-mini.task-done .task-mini-label { color: var(--muted); }

    .empty { color: var(--muted); font-size: 0.86em; padding: 6px 0; }

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
      .chain-step-status { display: none; }
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

    <section class="stats-grid" aria-label="Workflow stats">
      <div class="stat"><div class="stat-value" id="stat-progress">0%</div><div class="stat-label">Progress</div></div>
      <div class="stat"><div class="stat-value" id="stat-active">0</div><div class="stat-label">Active</div></div>
      <div class="stat"><div class="stat-value" id="stat-done">0</div><div class="stat-label">Done</div></div>
      <div class="stat"><div class="stat-value" id="stat-failed">0</div><div class="stat-label">Failed</div></div>
    </section>
    <div class="meter"><div class="meter-fill" id="progress-fill"></div></div>

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

    <section class="panel" id="sec-chain">
      <div class="panel-header" data-section="sec-chain">
        <h2 class="panel-title">Reasoning &amp; Tasks</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body" id="sec-chain-body">
        <ol class="chain-list" id="chain-list">
          <li class="empty">Waiting to start.</li>
        </ol>
      </div>
    </section>

    <section class="panel" id="sec-logs">
      <div class="panel-header" data-section="sec-logs">
        <h2 class="panel-title">Logs</h2>
        <span class="chevron">v</span>
      </div>
      <div class="panel-body panel-body collapsed" id="sec-logs-body">
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
    // Steps the boss collapsed/expanded by hand — preserved across re-renders
    // so we don't fight their clicks; a step not in this map uses its default
    // (expanded if running, collapsed otherwise).
    const stepOverrides = {};

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

      document.getElementById('chain-list').addEventListener('click', event => {
        const head = event.target.closest('.chain-step-head');
        if (!head) { return; }
        const step = head.closest('.chain-step');
        if (!step) { return; }
        const key = step.dataset.key;
        const collapsed = step.classList.toggle('collapsed');
        stepOverrides[key] = collapsed;
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
      for (const key of Object.keys(stepOverrides)) { delete stepOverrides[key]; }
      appendLog('Start requested. Checking workspace and Ollama...', 'info');
      renderAll();
      vscode.postMessage({ type: 'startProject', prompt });
    }

    function resumeWorkflow() {
      appendLog('Resume requested.', 'info');
      vscode.postMessage({ type: 'resumeWorkflow' });
    }
    function stopWorkflow() {
      currentMessage = 'Stop requested. Cancelling active work...';
      appendLog('Stop requested. Cancelling active work...', 'warn');
      renderChain();
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
          renderHeader();
          renderChain();
          break;
        case 'updateTasks':
          latestTasks = msg.tasks || [];
          renderStats();
          renderChain();
          break;
        case 'updateTimeline':
          latestTimeline = msg.timeline || [];
          renderStats();
          renderChain();
          break;
        case 'updateActivities':
          latestActivities = msg.activities || [];
          renderChain();
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
      renderChain();
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
      const resumable = status === 'waiting_for_user' || status === 'stopped' || status === 'failed';
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

    /**
     * The single, unified "chain of thought" trace: one step per timeline
     * phase (in order), each expandable to show the fine-grained activity
     * entries — and, for the coding phase, the task list — that happened
     * during it. Replaces the old separate Pipeline/Debate Board/Tasks/
     * Activity Feed sections with one narrative the boss can read top to
     * bottom, matching the chatbot's per-round debate trace.
     */
    function renderChain() {
      const list = document.getElementById('chain-list');
      if (!latestTimeline.length) {
        list.innerHTML = '<li class="empty">Waiting to start.</li>';
        return;
      }

      list.innerHTML = latestTimeline.map((entry, index) => {
        const key = entry.phase + '-' + index;
        const status = entry.status || 'pending';
        const isRunning = status === 'running';
        const defaultCollapsed = !isRunning;
        const collapsed = key in stepOverrides ? stepOverrides[key] : defaultCollapsed;

        const activities = latestActivities.filter(item => item.phase === entry.phase).slice(-25);
        const subItems = activities.map(renderActivitySub).join('');
        const taskItems = entry.phase === 'coding' ? renderTaskMiniList() : '';
        const body = subItems || taskItems
          ? '<ul class="chain-sub-list">' + subItems + taskItems + '</ul>'
          : (isRunning ? '<div class="chain-step-detail">' + escapeHtml(currentMessage || 'Working...') + '</div>' : '');

        const meta = entry.agentRole ? agentLabel(entry.agentRole) : '';
        return '<li class="chain-step' + (collapsed ? ' collapsed' : '') + '" data-key="' + escapeHtml(key) + '" data-status="' + escapeHtml(status) + '">' +
          '<span class="chain-dot dot-' + escapeHtml(status) + '"></span>' +
          '<div class="chain-step-head">' +
          '<span class="chain-step-label">' + escapeHtml(entry.label) + (meta ? ' <span class="chain-step-status">' + escapeHtml(meta) + '</span>' : '') + '</span>' +
          '<span class="chain-step-status">' + escapeHtml(status) + '</span>' +
          '</div>' +
          body +
          '</li>';
      }).join('');
    }

    function renderActivitySub(item) {
      const chips = [];
      if (item.round && item.totalRounds) { chips.push('Round ' + item.round + '/' + item.totalRounds); }
      if (item.taskId) { chips.push(item.taskId); }
      if (item.files && item.files.length) { chips.push(item.files.length + ' file(s)'); }
      return '<li class="chain-sub-item sub-' + escapeHtml(item.status || 'info') + '">' +
        '<div class="chain-sub-title">' + escapeHtml(item.title || '') + (item.agentRole ? ' — ' + escapeHtml(agentLabel(item.agentRole)) : '') + '</div>' +
        '<div class="chain-sub-body">' + escapeHtml(item.detail || '') + '</div>' +
        (chips.length ? '<div class="chain-sub-meta">' + chips.map(chip => '<span class="chip">' + escapeHtml(chip) + '</span>').join('') + '</div>' : '') +
        '</li>';
    }

    function renderTaskMiniList() {
      if (!latestTasks.length) { return ''; }
      return latestTasks.map(task => {
        const status = task.status || 'pending';
        const dotClass = statusToDot(status);
        const done = status === 'completed' || status === 'skipped';
        return '<li class="chain-task-mini' + (done ? ' task-done' : '') + '">' +
          '<span class="dot dot-' + dotClass + '"></span>' +
          '<span class="task-mini-label">[' + escapeHtml(task.id) + '] ' + escapeHtml(task.title) + '</span>' +
          '</li>';
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
        '<div class="chain-sub-title">' + escapeHtml(agentLabel(question.agentRole)) + '</div>' +
        '<div class="chain-sub-body">' + escapeHtml(question.question) + '</div>' +
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
        '<div class="chain-sub-title">Approve file changes</div>' +
        '<div class="chain-sub-body">' + escapeHtml((targetFiles || []).join(', ')) + '</div>' +
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
        '<div class="chain-sub-title">Approve command</div>' +
        '<div class="chain-sub-body">' + escapeHtml(reason || '') + '</div>' +
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
