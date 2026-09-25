(() => {
  'use strict';

  const chatEl = document.getElementById('chat');
  const composerEl = document.getElementById('composer');
  const questionEl = document.getElementById('question');
  const sendBtn = document.getElementById('sendBtn');
  const connStatusEl = document.getElementById('connStatus');
  const logPanel = document.getElementById('logPanel');
  const logOutput = document.getElementById('logOutput');
  const clearLogBtn = document.getElementById('clearLogBtn');
  const toggleLogBtn = document.getElementById('toggleLogBtn');

  const settingsBtn = document.getElementById('settingsBtn');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const settingsOverlay = document.getElementById('settingsOverlay');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const settingsErrorEl = document.getElementById('settingsError');
  const roundsInput = document.getElementById('roundsInput');
  const roundsValueEl = document.getElementById('roundsValue');
  const agentCountInput = document.getElementById('agentCountInput');
  const agentCountValueEl = document.getElementById('agentCountValue');
  const agentCountHintEl = document.getElementById('agentCountHint');
  const webSearchInput = document.getElementById('webSearchInput');

  let socket = null;
  let reconnectDelayMs = 1000;
  let busy = false;
  let currentExchange = null;
  let settings = { rounds: 2, agentCount: 5, webSearchEnabled: true };
  const MAX_LOG_LINES = 400;

  // ---------------------------------------------------------------
  // Terminal-style process log
  // ---------------------------------------------------------------

  function timestamp() {
    return new Date().toLocaleTimeString('vi-VN', { hour12: false });
  }

  function appendLog(message, level = 'info') {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.dataset.level = level;
    line.textContent = `[${timestamp()}] ${message}`;
    logOutput.appendChild(line);
    while (logOutput.children.length > MAX_LOG_LINES) {
      logOutput.removeChild(logOutput.firstElementChild);
    }
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  clearLogBtn.addEventListener('click', () => {
    logOutput.replaceChildren();
    appendLog('Log cleared.', 'debug');
  });

  toggleLogBtn.addEventListener('click', () => {
    logPanel.classList.toggle('collapsed');
    const collapsed = logPanel.classList.contains('collapsed');
    toggleLogBtn.textContent = collapsed ? '▸' : '▾';
    toggleLogBtn.title = collapsed ? 'Mở log' : 'Thu gọn log';
    toggleLogBtn.setAttribute('aria-label', toggleLogBtn.title);
  });

  appendLog('UI loaded. Waiting for backend connection...', 'debug');

  // ---------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------

  /**
   * Ollama can be slow under real load (e.g. cold-loading several large
   * models for a readiness check), and a plain `fetch()` has no timeout of
   * its own — without this, a slow backend leaves the settings panel (or a
   * save click) hanging indefinitely with no feedback at all.
   */
  function fetchWithTimeout(url, options, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  async function loadSettings() {
    try {
      appendLog('Loading chat settings and installed models...', 'debug');
      const [configRes, modelsRes] = await Promise.all([
        fetchWithTimeout('/api/config').then(r => r.json()),
        fetchWithTimeout('/api/models').then(r => r.json()),
      ]);
      settings = { rounds: configRes.rounds, agentCount: configRes.agentCount, webSearchEnabled: configRes.webSearchEnabled };
      roundsInput.max = String(configRes.maxRounds ?? 6);
      agentCountInput.min = String(configRes.minAgents ?? 3);
      agentCountInput.max = String(configRes.maxAgents ?? 8);
      if (Array.isArray(modelsRes.models)) {
        const cap = Math.max(configRes.minAgents ?? 3, Math.min(configRes.maxAgents ?? 8, modelsRes.models.length));
        agentCountInput.max = String(cap);
        agentCountHintEl.textContent = `${modelsRes.models.length} model đang cài đặt trên máy. Tối đa ${cap} agent.`;
      }
      applySettingsToInputs();
      appendLog(`Settings ready: ${settings.agentCount} agents, ${settings.rounds} rounds, web search ${settings.webSearchEnabled ? 'on' : 'off'}.`, 'success');
    } catch (err) {
      // Even when the network round-trip fails or times out, fall back to
      // the in-memory defaults so the panel is still usable (inputs show
      // sane values, Save still works against /api/config) instead of
      // silently doing nothing.
      applySettingsToInputs();
      settingsErrorEl.hidden = false;
      settingsErrorEl.textContent = err.name === 'AbortError'
        ? 'Máy chủ phản hồi chậm (có thể đang bận tải model) — dùng cài đặt mặc định, bạn vẫn lưu được bình thường.'
        : `Không tải được cài đặt: ${err.message}`;
      appendLog(`Settings load failed: ${err.message}`, 'warn');
    }
  }

  function applySettingsToInputs() {
    roundsInput.value = String(settings.rounds);
    roundsValueEl.textContent = String(settings.rounds);
    agentCountInput.value = String(Math.min(Number(agentCountInput.max), settings.agentCount));
    agentCountValueEl.textContent = agentCountInput.value;
    webSearchInput.checked = !!settings.webSearchEnabled;
  }

  roundsInput.addEventListener('input', () => { roundsValueEl.textContent = roundsInput.value; });
  agentCountInput.addEventListener('input', () => { agentCountValueEl.textContent = agentCountInput.value; });

  function openSettings() { settingsOverlay.hidden = false; }
  function closeSettings() { settingsOverlay.hidden = true; }

  let savingSettings = false;
  async function saveSettings() {
    if (savingSettings) { return; }
    savingSettings = true;
    settingsErrorEl.hidden = true;
    const body = {
      rounds: Number(roundsInput.value),
      agentCount: Number(agentCountInput.value),
      webSearchEnabled: webSearchInput.checked,
    };
    try {
      appendLog(`Saving settings: ${body.agentCount} agents, ${body.rounds} rounds, web search ${body.webSearchEnabled ? 'on' : 'off'}...`);
      const res = await fetchWithTimeout('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const updated = await res.json();
      if (!res.ok) { throw new Error(updated.error || `HTTP ${res.status}`); }
      settings = { rounds: updated.rounds, agentCount: updated.agentCount, webSearchEnabled: updated.webSearchEnabled };
      applySettingsToInputs();
      closeSettings();
      appendLog('Settings saved.', 'success');
    } catch (err) {
      settingsErrorEl.hidden = false;
      settingsErrorEl.textContent = err.name === 'AbortError'
        ? 'Máy chủ phản hồi chậm — thử lại sau vài giây.'
        : `Không lưu được cài đặt: ${err.message}`;
      appendLog(`Settings save failed: ${err.message}`, 'error');
    } finally {
      savingSettings = false;
    }
  }

  // Bound on both bubble and capture phase, and on pointerup as well as
  // click: some browsers/extensions have been seen to swallow a plain
  // bubble-phase 'click' on specific elements (e.g. Edge's built-in page
  // features) without throwing anything — capture-phase + pointerup give
  // independent paths that don't share whatever is eating the bubble click.
  function bindActivation(el, handler) {
    let firedAt = 0;
    const fire = () => {
      const now = Date.now();
      if (now - firedAt < 300) { return; } // de-dupe when multiple event types fire for one interaction
      firedAt = now;
      handler();
    };
    el.addEventListener('click', fire);
    el.addEventListener('click', fire, true);
    el.addEventListener('pointerup', fire);
  }

  bindActivation(settingsBtn, openSettings);
  bindActivation(closeSettingsBtn, closeSettings);
  bindActivation(saveSettingsBtn, saveSettings);
  settingsOverlay.addEventListener('click', e => { if (e.target === settingsOverlay) { closeSettings(); } });

  // Keyboard fallback: a completely different event path from mouse
  // clicks, so it keeps working even if something upstream is only
  // intercepting pointer/click events on the dialog's buttons.
  settingsOverlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSettings(); }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); saveSettings(); }
  });

  // ---------------------------------------------------------------
  // Chat + task-panel (chain-of-thought) rendering
  // ---------------------------------------------------------------
  // Each question gets an "exchange": the question bubble, a collapsible
  // task panel that fills in step-by-step as the debate streams in (one
  // step per round + a "getting ready" step for readiness/research status,
  // each step expandable to show every agent's turn), and finally the
  // answer bubble. The panel auto-collapses once the answer arrives — the
  // reasoning trace stays available on demand, not as the primary content.

  function scrollToBottom() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function appendBubble(text, kind) {
    const row = document.createElement('div');
    row.className = `bubble-row ${kind === 'user' ? 'user' : 'agent'}`;
    const bubble = document.createElement('div');
    bubble.className = `bubble ${kind}`;
    bubble.textContent = text;
    row.appendChild(bubble);
    chatEl.appendChild(row);
    scrollToBottom();
    return bubble;
  }

  function createExchange(question) {
    const wrap = document.createElement('div');
    wrap.className = 'exchange';

    const userRow = document.createElement('div');
    userRow.className = 'bubble-row user';
    const userBubble = document.createElement('div');
    userBubble.className = 'bubble user';
    userBubble.textContent = question;
    userRow.appendChild(userBubble);
    wrap.appendChild(userRow);

    const panel = document.createElement('div');
    panel.className = 'task-panel';
    panel.dataset.state = 'running';

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'task-panel-header';
    const title = document.createElement('span');
    title.className = 'task-panel-title';
    title.textContent = 'Đang chuẩn bị...';
    const toggle = document.createElement('span');
    toggle.className = 'task-panel-toggle';
    toggle.textContent = '▾';
    header.appendChild(title);
    header.appendChild(toggle);
    header.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      toggle.textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
    });
    panel.appendChild(header);

    const stepsEl = document.createElement('ol');
    stepsEl.className = 'task-steps';
    panel.appendChild(stepsEl);

    wrap.appendChild(panel);
    chatEl.appendChild(wrap);
    scrollToBottom();

    return { wrap, panel, header, title, stepsEl, steps: new Map(), currentStepKey: null };
  }

  function createStep(exchange, label) {
    const li = document.createElement('li');
    li.className = 'task-step';
    li.dataset.status = 'running';
    const head = document.createElement('div');
    head.className = 'task-step-head';
    const icon = document.createElement('span');
    icon.className = 'step-icon';
    const labelEl = document.createElement('span');
    labelEl.className = 'step-label';
    labelEl.textContent = label;
    head.appendChild(icon);
    head.appendChild(labelEl);
    li.appendChild(head);
    const turnsEl = document.createElement('ul');
    turnsEl.className = 'agent-turns';
    li.appendChild(turnsEl);
    exchange.stepsEl.appendChild(li);
    return { li, labelEl, turnsEl, status: 'running' };
  }

  function setStepStatus(entry, status) {
    entry.status = status;
    entry.li.dataset.status = status;
  }

  /** Creates a step the first time `key` is seen; updates its label on later calls with the same key. */
  function upsertStep(exchange, key, label) {
    let entry = exchange.steps.get(key);
    if (entry) {
      entry.labelEl.textContent = label;
      return entry;
    }
    if (exchange.currentStepKey) {
      const prev = exchange.steps.get(exchange.currentStepKey);
      if (prev && prev.status === 'running') { setStepStatus(prev, 'done'); }
    }
    entry = createStep(exchange, label);
    exchange.steps.set(key, entry);
    exchange.currentStepKey = key;
    scrollToBottom();
    return entry;
  }

  function addAgentTurn(exchange, key, agentId, summary) {
    const step = exchange.steps.get(key);
    if (!step) { return; }
    const li = document.createElement('li');
    li.className = 'agent-turn';
    const b = document.createElement('b');
    b.textContent = `${agentId}: `;
    const text = document.createElement('span');
    text.className = 'agent-turn-text';
    text.textContent = summary;
    li.appendChild(b);
    li.appendChild(text);
    step.turnsEl.appendChild(li);
    scrollToBottom();
  }

  function finishExchange(exchange, success) {
    if (exchange.currentStepKey) {
      const last = exchange.steps.get(exchange.currentStepKey);
      if (last && last.status === 'running') { setStepStatus(last, success ? 'done' : 'error'); }
    }
    exchange.panel.dataset.state = success ? 'done' : 'error';
    exchange.panel.classList.add('collapsed');
    exchange.header.querySelector('.task-panel-toggle').textContent = '▸';
    exchange.title.textContent = success
      ? `Xem quá trình tranh luận (${exchange.steps.size} bước)`
      : 'Quá trình tranh luận (dừng vì lỗi)';
  }

  function setBusy(isBusy) {
    busy = isBusy;
    sendBtn.disabled = isBusy;
    questionEl.disabled = isBusy;
  }

  // ---------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    appendLog(`Connecting WebSocket: ${protocol}//${location.host}/ws`, 'debug');
    socket = new WebSocket(`${protocol}//${location.host}/ws`);

    socket.addEventListener('open', () => {
      connStatusEl.classList.remove('offline');
      connStatusEl.classList.add('online');
      connStatusEl.title = 'Đã kết nối';
      reconnectDelayMs = 1000;
      appendLog('WebSocket connected.', 'success');
    });

    socket.addEventListener('close', () => {
      connStatusEl.classList.remove('online');
      connStatusEl.classList.add('offline');
      connStatusEl.title = 'Mất kết nối — đang thử lại...';
      setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
      appendLog(`WebSocket closed. Reconnecting in ${reconnectDelayMs / 1000}s...`, 'warn');
    });

    socket.addEventListener('error', () => {
      appendLog('WebSocket error.', 'error');
      socket.close();
    });

    socket.addEventListener('message', event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleEvent(msg);
    });
  }

  function handleEvent(msg) {
    if (!currentExchange) { return; }
    const exchange = currentExchange;
    switch (msg.type) {
      case 'status':
        appendLog(msg.message);
        upsertStep(exchange, 'prep', msg.message);
        break;
      case 'round':
        appendLog(`Round ${msg.round}: ${roundLabelVi(msg.label)}`);
        upsertStep(exchange, `round-${msg.round}`, `Vòng ${msg.round}: ${roundLabelVi(msg.label)}`);
        exchange.title.textContent = `Đang tranh luận — vòng ${msg.round}...`;
        break;
      case 'agent':
        appendLog(`${msg.agentId}: ${msg.summary}`, 'debug');
        addAgentTurn(exchange, `round-${msg.round}`, msg.agentId, msg.summary);
        break;
      case 'transcript':
        // Full transcript text is available on the event but not rendered
        // live — the per-round/per-agent steps already summarize it, and a
        // full raw transcript view can be added later without changing the protocol.
        break;
      case 'answer':
        appendLog('Answer received. Debate complete.', 'success');
        finishExchange(exchange, true);
        appendBubble(msg.answer, 'agent');
        setBusy(false);
        currentExchange = null;
        break;
      case 'error':
        appendLog(msg.message || 'Unknown backend error.', 'error');
        finishExchange(exchange, false);
        appendBubble(msg.message || 'Đã có lỗi xảy ra.', 'error');
        setBusy(false);
        currentExchange = null;
        break;
      default:
        break;
    }
  }

  function roundLabelVi(label) {
    switch (label) {
      case 'Initial positions': return 'nêu quan điểm ban đầu';
      case 'Debate': return 'tranh luận, đọc ý kiến người khác';
      case 'Synthesis': return 'tổng hợp câu trả lời';
      default: return label;
    }
  }

  // ---------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------

  questionEl.addEventListener('input', () => {
    questionEl.style.height = 'auto';
    questionEl.style.height = `${Math.min(questionEl.scrollHeight, 120)}px`;
  });

  composerEl.addEventListener('submit', e => {
    e.preventDefault();
    const question = questionEl.value.trim();
    if (!question || busy) { return; }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendBubble('Chưa kết nối được tới máy chủ. Đang thử kết nối lại...', 'error');
      appendLog('Cannot send: WebSocket is not connected.', 'error');
      return;
    }
    questionEl.value = '';
    questionEl.style.height = 'auto';
    setBusy(true);
    currentExchange = createExchange(question);
    appendLog(`Question submitted: ${question}`);
    appendLog(`Run config: ${settings.agentCount} agents, ${settings.rounds} rounds, web search ${settings.webSearchEnabled ? 'on' : 'off'}.`, 'debug');
    socket.send(JSON.stringify({
      type: 'ask',
      question,
      rounds: settings.rounds,
      agentCount: settings.agentCount,
      webSearch: settings.webSearchEnabled,
    }));
  });

  loadSettings();
  connect();
})();
