<div align="center">

# 🤖 Local Multi-Agent Coder

**One prompt in. A finished, verified software project out — debated, cross-checked, and built entirely by local LLMs through Ollama, inside VS Code.**

🇻🇳 *Một câu lệnh của boss → các agent local tự tranh luận, kiểm tra chéo và xây ra sản phẩm hoàn chỉnh. Không cloud, không API key, không rò rỉ dữ liệu.*

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-blue?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Ollama](https://img.shields.io/badge/Ollama-local%20LLM-black?logo=ollama)](https://ollama.com/)
[![Tests](https://img.shields.io/badge/tests-46%20passing-brightgreen)](#-running-tests)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## ✨ What is this?

**Local Multi-Agent Coder** is a VS Code extension that turns a single instruction into a working software project. Behind the scenes, a team of specialized AI agents — each running on a **different local model** via [Ollama](https://ollama.com/) — **debate** the approach, **vote** on the best plan, write the code, **cross-check each other's work**, run the tests, and keep iterating until the product is genuinely done.

It is built around three principles:

- **🎯 Highest possible output quality.** Nothing ships until multiple independent models agree it is production-ready.
- **🙋 Minimal human intervention.** Ideally the boss gives one instruction; the agents resolve every ambiguity with explicit assumptions instead of asking questions.
- **🏠 Fully local.** Designed to run on modest hardware (e.g. a **Mac mini M4, 24 GB RAM**). No API keys, no cloud, no data leaving your machine.

> Give it a prompt like _"Build a relaxing instrumental-music YouTube channel: research the niche, produce the code, the strategy, and auto-upload"_ — and the agents research, debate, and execute. The only thing they'll ask you for is something they genuinely cannot self-provide, like a YouTube API key.

---

## 🧠 The Debate Engine

This is the heart of the project. **Before a single line of code is written**, the approach goes through a full multi-round, multi-model debate so the team converges on the strongest plan:

```
                          ┌─────────────────────────────────────────────┐
   User Prompt ──────────►│            🧠 DEBATE  (no code yet)          │
                          └─────────────────────────────────────────────┘
        │
        ▼
   💡 Round 1 — Proposal            Brainstorm model proposes the approach
        │
        ▼
   🔍 Round 2 — Cross-critique      Critic (N rounds) + Product/UX (N rounds)
        │                           challenge the proposal from every angle
        ▼
   🗣️  Round 3 — Response           The proposer answers every critique
        │                           and converges on one coherent direction
        ▼
   ⚖️  Round 4 — Score & Vote       A panel of 5 DIFFERENT models scores the
        │                           approach (feasibility, completeness, risk,
        │                           UX, quality) and votes on the winner
        ▼
   🧠 Project Brief                 The winning direction is frozen into an
                                    executable brief
```

Then the build begins — in small, verifiable sprints:

```
   🏛️  Architect      Locks the tech stack, structure, and data models
        │
        ▼
   📋 Task Manager    Splits the work into small, dependency-ordered tasks
        │
        ▼
   ┌──────────────────── per-task loop ────────────────────┐
   │ ⚙️  Code Worker    LLM A writes the code               │
   │      │                                                 │
   │      ▼                                                 │
   │ 🔎 Reviewer       LLM B checks task acceptance         │
   │      │                                                 │
   │      ▼                                                 │
   │ 🕵️  Quality Audit  LLM C (independent, stronger) audits │
   │      │            overall production quality           │
   │      ▼                                                 │
   │ 🔧 Fixer          Repeats until B *and* C are satisfied│
   └────────────────────────────────────────────────────────┘
        │
        ▼
   🧪 Tester          Runs compile/tests, self-heals failures
        │
        ▼
   🤝 Retrospective   3 models vote: ship, or run another sprint?
        │
        ▼
   📦 Delivery  →  📊 Final Report  →  ✅ Done
```

---

## 🌟 Key Features

| Feature | Description |
|---|---|
| 🔒 **100% Local** | Every model runs via Ollama — your code never leaves your machine |
| ⚖️ **4-Round Scored Debate** | Propose → cross-critique → respond → a **5-model panel scores and votes** on the best direction before any code is written |
| 🕵️ **3-Model Code Cross-Check** | One model writes, a second reviews task acceptance, a third (independent, stronger) audits overall quality — the fix loop repeats **until all are satisfied** |
| 📔 **Live Work Journal** | Auto-generates `AGENT_JOURNAL.md` — a timestamped, icon-tagged log of every thought, critique, decision, task, and report. The main **boss ⇄ agents** communication channel |
| 🤝 **Multi-Model by Design** | Each role is bound to a distinct model, so debate and review bring genuinely independent perspectives |
| 🔁 **Sprint Retrospectives** | After each sprint, models vote on whether the product is complete or needs another pass |
| 🔄 **Self-Healing** | Automatically retries with fallback/alternate models, compacts context, and recovers from bad output |
| 🧠 **Memory & Audit Trail** | Rolling summary, decisions, assumptions, lessons learned, and full call/terminal logs under `.agent-workspace/` |
| 🌿 **Git-Aware** | Reads a snapshot of your repo and shares it with every agent |
| 🛠️ **Tool-Using Agents** | Agents can read files, search the repo, run safe commands, apply patches, and fetch URLs |
| 🛡️ **Command Safety Policy** | Dangerous commands and out-of-workspace writes require approval; safe build/test commands run automatically |
| 💾 **Hardware-Aware** | Tuned model keep-alive and context budgets to fit constrained RAM (e.g. 24 GB) |

---

## 📦 Requirements

- [VS Code](https://code.visualstudio.com/) `^1.85`
- [Ollama](https://ollama.com/) installed and running locally
- The local models referenced in your config pulled ahead of time. The default roster, for example:
  ```bash
  ollama pull qwen3-coder:30b
  ollama pull deepseek-coder-v2:16b
  ollama pull qwen2.5-coder:14b-instruct
  ollama pull qwen2.5-coder:7b-instruct
  ollama pull devstral-small-2
  ```
  > 💡 On 24 GB machines, prefer a roster you can actually keep resident. Every role can fall back to a smaller model, and you can point all roles at one or two models if you're tight on RAM.

---

## 🛠️ Installation & Setup

1. **Clone and install**
   ```bash
   git clone https://github.com/trantuthieng/debate_agent.git
   cd debate_agent
   npm install
   ```

2. **Compile**
   ```bash
   npm run compile
   ```

3. **Launch in VS Code**
   - Press `F5` to open the Extension Development Host
   - Click the 🤖 icon in the Activity Bar to open the **Agent Coder** panel

4. **Configure your models** in `.agent-workspace/model_config.json` (see [Configuration](#️-configuration))

---

## 🎮 Usage

1. Open the **Agent Coder** panel from the Activity Bar.
2. Type what you want built — one clear instruction is enough.
3. Click **Start** and watch the timeline, agent activity, and debate unfold in real time.
4. Follow along in **`AGENT_JOURNAL.md`** (created at the workspace root) for the full narrative.
5. Review the generated files, the final report, and the audit trail in `.agent-workspace/`.

### Available Commands

| Command | Description |
|---|---|
| `Local Multi-Agent Coder: Open Panel` | Open the main UI |
| `Local Multi-Agent Coder: Start New Project` | Start a fresh generation |
| `Local Multi-Agent Coder: Resume Workflow` | Continue an interrupted run |
| `Local Multi-Agent Coder: Stop Workflow` | Abort the current run |
| `Local Multi-Agent Coder: Show Agent Notes` | View agent reasoning & decisions |
| `Local Multi-Agent Coder: Open Settings File` | Edit model configuration |

---

## 📔 The Work Journal

Every run writes **`AGENT_JOURNAL.md`** to the workspace root — a human-readable, chronological log (newest at the bottom) that doubles as the communication channel between you and the agents:

```markdown
# 🤖 Agent Work Journal

### 🚀 Workflow started — route: full_project
`2026-06-14 09:12:03 UTC` · **system**

### 💡 Round 1 — Initial proposal
`2026-06-14 09:12:48 UTC` · **brainstorm**
> Core goal, suggested architecture, risks…

### 🔍 Round 2 — Critique (round 1/3)
`2026-06-14 09:14:10 UTC` · **critic**
> Missing requirements, security concerns…

### ⚖️ Round 4 — Panel verdict: 8.4/10 (high agreement)
`2026-06-14 09:21:55 UTC` · **debate-panel**
> Winning direction + ranked recommendations…

### 🕵️ Quality audit for task-003
`2026-06-14 09:40:12 UTC` · **quality-auditor**
> ✅ Passed holistic quality audit.
```

Icons map to the moment: 🚀 start · 💡 propose · 🔍 critique · 🎨 product · 🗣️ respond · ⚖️ vote · 🧠 brief · 🏛️ architecture · 📋 plan · ⚙️ code · 🔎 review · 🕵️ audit · 🔧 fix · 🧪 test · 🤝 retrospective · 📊 report · ✅ done · ⚠️ warn · ❌ error.

---

## 🗂️ Project Structure

```
src/
├── 📄 extension.ts              # Extension entry point
├── 🏛️  orchestrator/             # AgentOrchestrator — the brain (debate, sprints, cross-check)
├── 🤖 ollama/                   # Ollama API client (timeouts, fallback, keep-alive)
├── 💬 prompts/                  # System prompts per agent role
├── 📦 types.ts                  # TypeScript interfaces & types
├── ⚙️  services/                 # Verification, patches, search, research, web/github fetch…
├── 🧰 tools/                    # Autonomous tool registry (read/search/run/patch/fetch/research)
├── 🖥️  terminal/                 # Command runner + safety policy + approval
├── 🗃️  workspace/                # File manager, agent workspace, the work journal
├── 🧠 context/                  # Context cache & budget assembly
├── 🌿 git/                      # Repo snapshot reader
├── 🌐 webview/                  # Sidebar panel UI
└── 🔧 utils/                    # Helpers (json, errors, logging…)

test/
├── 🧪 unit/                     # Unit tests (capabilities, research, policy…)
└── 🔗 orchestrator.test.js      # Debate scoring, panel diversity, consensus, recovery…

.agent-workspace/               # Per-run state (gitignored, except model_config.json)
├── memory/                     # rolling summary, decisions, assumptions, lessons
├── agents/                     # every agent note + debate rounds + scores
├── tasks/                      # task plan & results
├── patches/                    # applied-patch audit trail
└── logs/                       # ollama calls, terminal, workflow logs
AGENT_JOURNAL.md                # human-readable run journal (gitignored)
```

---

## ⚙️ Configuration

Everything is driven by `.agent-workspace/model_config.json`. Assign a distinct model (and fallback) to each role, tune the debate, self-healing, and command safety:

```jsonc
{
  "ollamaBaseUrl": "http://localhost:11434",
  "requestTimeoutMs": 600000,

  "autonomousMode": true,      // run end-to-end without approval prompts
  "safeMode": false,           // ⚠️ forced off while autonomousMode is on
  "askPolicy": "never",        // resolve ambiguity with assumptions, don't ask

  "debateRounds": 3,           // inner rounds for the critic & product debate
  "maxFixRetries": 8,          // quality over speed: keep fixing until clean
  "autoInstallDependencies": true,
  "requireVerificationScripts": true,

  "selfHealing": {
    "enabled": true,
    "modelCallRetries": 2,
    "retryDelayMs": 5000,
    "alternateModelLimit": 3,
    "compactContextChars": 12000
  },

  "commandPolicy": {
    "approvedPrefixes": [],
    "requireApprovalForNetwork": true,
    "requireApprovalForExternalWrites": true
  },

  "defaultOptions": { "temperature": 0.1, "num_ctx": 8192, "top_p": 0.9 },

  "agents": {
    "briefBuilder":     { "model": "devstral-small-2",            "fallbackModel": "qwen2.5-coder:14b-instruct" },
    "brainstorm":       { "model": "qwen3-coder:30b",             "fallbackModel": "devstral-small-2" },
    "critic":           { "model": "deepseek-coder-v2:16b",       "fallbackModel": "qwen2.5-coder:14b-instruct" },
    "secondBrainstorm": { "model": "qwen2.5-coder:14b-instruct",  "fallbackModel": "qwen2.5-coder:7b-instruct" },
    "architect":        { "model": "devstral-small-2",            "fallbackModel": "qwen3-coder:30b" },
    "taskManager":      { "model": "qwen2.5-coder:14b-instruct",  "fallbackModel": "qwen3-coder:30b" },
    "codeWorker":       { "model": "qwen2.5-coder:14b-instruct",  "fallbackModel": "qwen3-coder:30b" },
    "reviewer":         { "model": "deepseek-coder-v2:16b",       "fallbackModel": "qwen2.5-coder:14b-instruct" },
    "tester":           { "model": "qwen2.5-coder:7b-instruct",   "fallbackModel": "qwen2.5-coder:14b-instruct" },
    "fixer":            { "model": "qwen2.5-coder:14b-instruct",  "fallbackModel": "qwen3-coder:30b" },
    "finalIntegrator":  { "model": "devstral-small-2",            "fallbackModel": "qwen3-coder:30b" }
  }
}
```

**Notes**
- The **quality auditor** (the 3rd cross-check model) reuses the strongest role — `brainstorm` — so the audit is independent of the code writer and task reviewer.
- The **scoring panel** uses 5 distinct role models: `brainstorm`, `critic`, `secondBrainstorm`, `architect`, `reviewer`.
- `autonomousMode: true` disables `safeMode` and approval prompts — intended for hands-off runs. Set it to `false` (and `askPolicy: "allow"`) if you want approval gates.
- Tight on RAM? Point several roles at the same model; the debate/cross-check logic still works, just with less model diversity.

---

## 🧪 Running Tests

```bash
npm test          # unit + integration + orchestrator tests
```

Static checks:

```bash
npm run compile   # TypeScript build
npm run lint      # ESLint
```

---

## 🤝 Contributing

Pull requests are welcome! Please open an issue first to discuss substantial changes. Keep `npm run compile`, `npm run lint`, and `npm test` green.

---

## 📄 License

MIT © [trantuthieng](https://github.com/trantuthieng)
