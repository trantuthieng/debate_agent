<div align="center">

# 🤖 Local Multi-Agent Coder

**Generate entire software projects from a single prompt — powered by local LLMs via Ollama, right inside VS Code.**

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-blue?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Ollama](https://img.shields.io/badge/Ollama-local%20LLM-black?logo=ollama)](https://ollama.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## ✨ What is this?

**Local Multi-Agent Coder** is a VS Code extension that orchestrates a **pipeline of specialized AI agents** to autonomously plan, design, write, review, and test code — all running **100% locally** on your machine through [Ollama](https://ollama.com/). No API keys. No cloud. No data leaves your computer.

Give it a prompt like _"Build a REST API with authentication and a PostgreSQL database"_ — and watch the agents go to work.

---

## 🚀 How it works

The extension runs a sequential multi-agent workflow, where each agent has a distinct role:

```
User Prompt
    │
    ▼
🧠 Brief Builder   — Understands the project scope
    │
    ▼
💡 Brainstorm      — Generates ideas and approaches
    │
    ▼
🔍 Critic          — Challenges assumptions, finds gaps
    │
    ▼
💡 Second Brainstorm — Refines ideas after critique
    │
    ▼
🏛️  Architect       — Designs the technical architecture
    │
    ▼
📋 Task Manager    — Breaks architecture into actionable tasks
    │
    ▼
⚙️  Code Worker     — Implements each task (file by file)
    │
    ▼
🔎 Reviewer        — Reviews code quality & security
    │
    ▼
🔧 Fixer           — Applies fixes based on review feedback
    │
    ▼
🧪 Tester          — Runs tests, triggers self-healing loop
    │
    ▼
✅ Done!
```

---

## 🌟 Key Features

| Feature | Description |
|---|---|
| 🔒 **100% Local** | All LLMs run via Ollama — your code never leaves your machine |
| 🤝 **Multi-Agent Pipeline** | 9 specialized agents collaborate on every project |
| 🔄 **Self-Healing** | Automatically retries with fallback models when a call fails |
| 🌿 **Git-Aware** | Reads your repo snapshot and shares it with every agent |
| 🛡️ **Safe Mode** | Optional user approval before any file is written |
| 📝 **Full Audit Trail** | Every agent decision, patch, and assumption is logged |
| ⚡ **Model Fallback** | Primary → fallback → alternate models, automatically |

---

## 📦 Requirements

- [VS Code](https://code.visualstudio.com/) `^1.85`
- [Ollama](https://ollama.com/) installed and running locally
- At least one LLM pulled, e.g.:
  ```bash
  ollama pull qwen2.5-coder:14b-instruct
  ollama pull devstral-small-2
  ```

---

## 🛠️ Installation & Setup

1. **Clone the repo and install dependencies**
   ```bash
   git clone https://github.com/trantuthieng/debate_agent.git
   cd debate_agent
   npm install
   ```

2. **Compile the extension**
   ```bash
   npm run compile
   ```

3. **Launch in VS Code**
   - Press `F5` to open the Extension Development Host
   - Click the 🤖 icon in the Activity Bar to open the Agent Coder panel

4. **Configure your models** by editing `.agent-workspace/model_config.json`

---

## 🎮 Usage

1. Open the **Agent Coder** panel from the Activity Bar
2. Type your project description in the prompt field
3. Click **Start** and watch the agents work in real-time
4. Review the generated files in your workspace

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

## 🗂️ Project Structure

```
src/
├── 📄 extension.ts              # Extension entry point
├── 🎮 commands/                 # VS Code command handlers
├── 🏛️  orchestrator/             # AgentOrchestrator — the brain
├── 🤖 ollama/                   # Ollama API client
├── 📦 models/                   # TypeScript interfaces & types
├── ⚙️  services/                 # App generation, code, templates
├── 🧩 templates/                # Reusable code templates
├── 🖥️  terminal/                 # Terminal runner for npm/test commands
├── 🗃️  workspace/                # File manager & agent workspace
├── 🌐 webview/                  # Sidebar panel UI
└── 🔧 utils/                    # Helpers (strings, dates, logging…)

test/
├── 🧪 unit/                     # Unit tests
└── 🔗 integration/              # Integration tests
```

---

## ⚙️ Configuration

Edit `.agent-workspace/model_config.json` to customize models per agent, set fallbacks, enable safe mode, and tune self-healing behaviour.

```jsonc
{
  "models": {
    "codeWorker": { "model": "devstral-small-2", "fallback": "qwen2.5-coder:14b-instruct" },
    "architect":  { "model": "deepseek-coder-v2:16b" }
  },
  "safeMode": false,
  "selfHealing": { "enabled": true, "modelCallRetries": 2 }
}
```

---

## 🧪 Running Tests

```bash
npm test
```

---

## 🤝 Contributing

Pull requests are welcome! Please open an issue first to discuss what you'd like to change.

---

## 📄 License

MIT © [trantuthieng](https://github.com/trantuthieng)
