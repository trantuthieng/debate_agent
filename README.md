# Local Multi-Agent Coder

A VS Code extension that turns one boss prompt into a runtime-designed local agent team, a four-round debate, an implementation plan, reviewed code, artifact-aware verification, and an evidence-backed delivery report. Models run locally through Ollama.

## Autonomous workflow

The sidebar **Start** action always runs the autonomous entry point:

1. Runtime preflight reads Ollama's installed inventory and calls candidate models sequentially.
2. At least five distinct, responsive local models are selected. The workflow stops before debate if fewer than five qualify.
3. A meta-agent staffs six required responsibilities: researcher, strategist, architect, builder, critic, and verifier.
4. The team completes four dependent rounds: independent proposals, cross-critique, author revisions, then weighted independent scoring.
5. The verdict becomes the authoritative input to architecture, task planning, coding, review, and testing.
6. Verification is planned from the generated artifact's actual stack. Web products are built and opened in a real headless browser; failed commands, startup errors, broken resources, JavaScript exceptions, placeholder tests, missing deliverables, and unfinished work block completion.

Dependency conflicts are repaired using the package manager's actual error output and verified by reinstalling. The workflow saves a checkpoint before each implementation phase. **Resume** continues failed or stopped runs from that checkpoint, preserving existing code. Reaching the sprint limit while work remains produces a failed/incomplete state, never a success report.

Resume preserves the autonomous debate/build mode, retries failed and skipped coding tasks, and reruns verification before a resumed retrospective. A worker that proposes no changes can submit existing task files for ordinary review; this does not automatically mark the task complete.

Runtime evidence is stored under `.agent-workspace/`, including:

- `.agent-workspace/agents/dynamic_team_plan.json`
- `.agent-workspace/agents/dynamic_team_debate.md`
- `.agent-workspace/agents/dynamic_team_decision.json`
- `.agent-workspace/logs/model_readiness.json`
- `.agent-workspace/logs/verification_plan.json`
- `.agent-workspace/logs/test_result.log`
- `.agent-workspace/delivery_manifest.json`

The legacy `AgentOrchestrator.start()` method is retained for focused maintenance callers. Sidebar prompts and the `Autonomous Goal` command use `runAutonomousGoal()`.

## Requirements

- VS Code 1.85 or newer
- Node.js 22 or newer for development and Extension Host automation
- Ollama reachable at the configured `ollamaBaseUrl`
- At least five distinct installed chat/code models that pass a short readiness call
- Sufficient free disk and memory for the selected models

Models run sequentially, including code-generation waves. The client releases the previous model before switching and bounds context using the model's native capacity, weight size, attention cache estimate, and physical RAM. This allows larger models to use available memory without trying to keep the whole debate team resident together. The OS memory-pressure guard still applies; estimates are not proof that every model will fit alongside other apps.

The default roster uses Devstral Small 2, Qwen2.5 Coder 14B/7B, DeepSeek Coder V2 16B, Mistral Small 3.2, and Gemma 3 12B. Automatic discovery excludes embedding models and the locally unstable `qwen3-coder:30b`; explicit configuration can opt back into that model. Matching model digests do not count twice toward debate diversity.

Install models with commands such as:

```bash
ollama pull qwen2.5-coder:7b-instruct
ollama pull qwen2.5-coder:14b-instruct
ollama pull deepseek-coder-v2:16b
```

Use five genuinely different installed model names. A missing configured model may be replaced by another installed, responsive model, but the verdict is marked `degraded`. Fewer than five responsive distinct models produces `blocked`, never a silent duplicate fallback.

## Development

```bash
npm install
npm run compile
npm run lint
npm test
```

Press `F5` in VS Code to launch an Extension Development Host. Open a workspace, select the **Local Multi-Agent Coder** activity-bar view, enter a goal, and choose **Start**.

The real Ollama E2E is intentionally separate because it is slow and hardware-dependent:

```bash
npm run compile
npm run test:e2e:ollama
```

It discovers five installed models, calls `runAutonomousGoal()`, and asserts that the dynamic-team artifacts exist and a completed state contains no active tasks. It also executes the generated CLI to verify its user-facing contract, then writes `dist/benchmarks/ollama-e2e-latest.json` with model readiness timings, phase transitions, Ollama call totals, elapsed time, host memory evidence, and a `usedDeterministicRecovery` flag. That flag is `true` when the deliverable was produced (at least in part) by the deterministic template fallback rather than the model pipeline — a passing run can still legitimately exercise that resilience path, but the benchmark must say so rather than let a template pass as model output.

For faster diagnosis of downstream regressions after a full debate has already been validated, run the real-model build pipeline in isolation:

```bash
npm run test:e2e:build:ollama
```

This exercises briefing, architecture, task planning, code/recovery, review, tests, delivery, and final integration; it writes `dist/benchmarks/ollama-build-e2e-latest.json`. It does not replace the full debate E2E in release evidence.

For predictable execution on unified-memory Macs, the E2E prefers five installed 7B–16B models, assigns code generation/review to coding-specialized models, caps dynamic-team context at 8K and responses at 768 tokens, and proportionally compacts every participant's text before aggregate critique/refinement/scoring prompts. Its fixture is intentionally dependency-free so network installation cannot affect the result. Override the benchmark roster when needed with `E2E_MODELS=model-a,model-b,model-c,model-d,model-e npm run test:e2e:ollama`.

The real VS Code Extension Host smoke test downloads a matching VS Code test runtime on first use, activates the packaged extension entry point, verifies every contributed command, focuses the actual sidebar, and exercises the safe Stop command:

```bash
npm run test:vscode
```

## Model configuration

The first run creates `.agent-workspace/model_config.json`. Important controls include:

- `ollamaBaseUrl` and `requestTimeoutMs`
- role-specific primary and fallback models under `agents`
- `defaultOptions.num_ctx` for memory pressure
- `maxFixRetries` and `requireVerificationScripts`
- `maxDevelopmentSprints` (default 5), independent of debate rounds
- `selfHealing.allowProductTemplates` (default `false`): optional legacy built-in product templates; keep disabled when measuring model-generated product quality
- command approval, web research, GitHub, skills, and app-smoke-test policies
- `allowSelfWorkspace` (default `false`)

Model names in configuration are requests, not proof of availability. `ModelReadinessService` resolves them against `OllamaClient.listModels()` and probes exact models without fallback before a debate can begin.

### Self-workspace guard

Before writing any product file, `runAutonomousGoal()`/`start()` refuse to build into a workspace that is this extension's own development source tree (detected by its `package.json` name plus the presence of `src/orchestrator/AgentOrchestrator.ts`). This exists because a real run once merged a generated product straight into this extension's own `src/`, corrupting it and leaking into a release archive. Open a separate, empty folder for the generated product; set `"allowSelfWorkspace": true` in `.agent-workspace/model_config.json` only if you intentionally want the agent to modify this extension itself.

## Artifact-aware verification

`VerificationPlanner` detects Node, Python, Go, Rust, Java/Gradle/Maven, .NET, and Swift projects. It uses package scripts where present and stack-native commands such as `python3 -m pytest`, `go test ./...`, `cargo test`, `mvn test`, `dotnet test`, and `swift test`.

Each sprint installs declared Node/Python dependencies when `autoInstallDependencies` is enabled (default). Failures trigger bounded manifest repair with the original stdout/stderr supplied to the fixer. Repairs preserve dependency declarations and verification scripts; they cannot bypass the resolver with `--force` or `--legacy-peer-deps`. Every repair is reinstalled before success, and test fixes that change manifests trigger a fresh installation.

Browser smoke verification requires Chrome, Chromium, or Edge (or `DEBATE_AGENT_BROWSER_PATH`). It uses a temporary browser profile, checks resource loading and uncaught JavaScript errors, and saves `.agent-workspace/logs/browser-smoke.png`. Static HTML works without a package manifest. Webpack/Vite projects without a build script receive an explicit local build check. A successful startup check does not by itself prove gameplay, accessibility, frame rate, or every requested feature.

For explicit collection counts such as “20 levels”, agents create `acceptance.json` pointing to the product's actual JSON array or JavaScript array export. The verifier counts that collection independently, including arrays generated by code, and sends missing or failing evidence through the fixer. The original goal supplies the expected count; a model cannot change it in the manifest. Evidence is saved to `.agent-workspace/logs/collection_acceptance.json`. Count verification complements behavioral tests; it does not establish that every item behaves correctly.

If build, runtime, and tests pass but a measured collection is still too small, the remaining content is planned in the next sprint. Broken or missing bindings remain repair work. Final completion still requires every requested count to pass.

Run the real 20-level product benchmark with shipped settings:

```bash
npm run test:e2e:brick-breaker
```

It sends one goal to `runAutonomousGoal()`, preserves generated files under `demo/brick-breaker-20-*`, and writes `dist/benchmarks/brick-breaker-20-latest.json`. The report distinguishes pipeline completion, template recovery, and the separate gameplay review. To resume a preserved failed run: `BRICK_E2E_WORKSPACE=/absolute/path node test/brick_breaker_e2e.js --resume`.

Python artifacts must include a non-empty `requirements.txt` or recognizable `pyproject.toml`. Placeholder tests such as `assert True`, empty test functions, and empty JavaScript test callbacks are blockers. Extension tests are not substituted for generated-product tests.

## Visual asset search (opt-in)

Local chat/code models cannot draw or generate images — Ollama does not host text-to-image models. For products that need real artwork (a game's character sprites, icons, thumbnails), `AssetLibraryService` gives agents a `search_image_assets` / `fetch_image_asset` tool pair backed by [Openverse](https://openverse.org), a search engine over openly-licensed images that requires no API key.

- Disabled by default (`assetLibrary.enabled: false`); auto-enabled for a run when the goal mentions a game, character, sprite, artwork, or similar (bilingual EN/VI), same mechanism as the web-research auto-enable.
- `search_image_assets` returns candidate images filtered to `assetLibrary.allowedLicenses` (default `cc0`, `pdm`, `by`, `by-sa`), each with a direct URL, creator, and license.
- `fetch_image_asset` downloads one chosen image into the workspace, rejects non-image responses and anything over `assetLibrary.maxBytes` (default 5 MB), and appends its license/creator/source to `ASSET_LICENSES.md` in the generated project — review that file before shipping or publishing.
- This complements, not replaces, code-drawn (Canvas/SVG) art: procedural shapes still cost nothing and need no license review, and remain the default for simple games.

## Pre-run resource guard

Running five local models sequentially through a full debate is heavy. Before the first model call, `SystemResourceService` always logs a resource advisory — free RAM, swap, and the biggest RAM-consuming apps right now (grouped by app, e.g. "Microsoft Edge: ~4.4 GB across 25 processes") — so the boss can close what isn't needed before a long run, without the extension touching any other process itself.

- On macOS, the block decision uses the OS's own memory-pressure verdict (`kern.memorystatus_vm_pressure_level`), not raw free-RAM or swap numbers — macOS routinely shows low "free" memory and nonzero swap on a perfectly healthy machine (it uses spare RAM as reclaimable disk cache), so those numbers alone would false-positive constantly. The run is hard-blocked only when macOS itself reports critical pressure.
- Off macOS (or if that signal can't be read), it falls back to `resourceGuard.minFreeMemoryPercent` (default 10%).
- Configurable via `resourceGuard` in `model_config.json` (`enabled`, `minFreeMemoryPercent`, `topProcessCount`); enabled by default.
- A block is an honest stop (`InsufficientResourcesError`), same family as the self-workspace guard — it never suspends, kills, or reprioritizes other processes. Close some of the listed apps (or wait) and start again.

## Controlled external actions

The connector foundation lives in `src/connectors/`:

- capability declarations for research, read/write, OAuth, upload, scheduling, and publish;
- an idempotent persistent job queue with bounded retries, audit history, and optional rollback;
- `VSCodeSecretVault`, which stores credentials in VS Code `SecretStorage`, never workspace JSON or journals;
- explicit per-run approval scopes and `draft-only` or `auto-publish` policies.

The first vertical is `YouTubeConnector`. It supports API-key research, OAuth 2.0 authorization-code exchange and refresh, resumable private draft upload, thumbnail upload, scheduled publishing, and status reads. Upload requires the YouTube upload OAuth scope and explicit `musicRightsConfirmed: true`. Scheduling is rejected under `draft-only` before any network call.

Run **Local Multi-Agent Coder: Configure YouTube Connector** from the Command Palette. It stores the client ID, client secret, optional research API key, granted scope, publish policy, access token, and refresh token in VS Code `SecretStorage`; none are written to the workspace. The user completes Google consent once, after which approved jobs can run without a per-video prompt.

## Chatbot (Q&A over the debate core, Docker + Tailscale)

A second, independent entry point exposes the same multi-model debate rigor as a general
question-answering chatbot ("should I buy iPhone 18?") reachable from a phone over Tailscale —
separate from the VS Code extension and from the software-build pipeline. It reuses the debate
core (`DynamicAgent`, `OllamaClient`, `WebSearchService`) through a **new, lighter debate engine**
(`src/dynamic/QaDebate.ts`) tuned for short factual/decision questions: it does not touch the
VS Code extension, the software-build `DynamicTeam` protocol, or any of its checkpoint/resume state.

**Run locally (no Docker) against your own Ollama:**
```bash
npm run server
# Chatbot at http://localhost:8787 — reads OLLAMA_BASE_URL (default http://localhost:11434 is
# NOT the default here; see below), PORT, CHAT_DATA_DIR env vars.
OLLAMA_BASE_URL=http://localhost:11434 npm run server
```

**Run in Docker with a private Tailscale link to your phone:**
```bash
cp .env.example .env            # then paste your own key into TS_AUTHKEY (see the file for the URL)
docker compose up -d
docker compose logs ts-chatbot  # find the tailnet hostname assigned to "debate-chatbot"
```
Open `https://debate-chatbot.<your-tailnet>.ts.net` on any device signed into your tailnet
(e.g. the Tailscale app on your phone) — private to your own devices, never exposed to the public
internet (`AllowFunnel: false` in `tailscale/config/serve.json`). Ollama itself is **not** moved
into Docker — the container reaches it on the host via `OLLAMA_BASE_URL` (default
`http://host.docker.internal:11434`), so your existing models/weights stay exactly where they are.

The web UI's settings panel (gear icon) persists these as defaults (`GET`/`POST /api/config`):
- **Số vòng tranh luận (debate rounds, 1–6)** — round 1 is every agent's independent initial
  answer; each additional round makes every agent read the others' latest positions and revise its
  own before a final synthesis call produces the actual answer. Round 1 alone is a "quick mode."
- **Số AI Agent (agent count, 3–8)** — independent, distinct-model participants; capped live to
  however many distinct models are actually installed (`GET /api/models`).
- **Web search toggle** — grounds the debate in one shared `ResearchService.webResearch()` call
  before round 1 (DuckDuckGo scrape, no API key), rather than every agent searching independently.

## Current limits

- OAuth consent still requires the user's browser interaction on first connection.
- Copyright ownership cannot be inferred reliably; uploads require an explicit rights confirmation and remain subject to YouTube checks.
- Real-model E2E and RAM/time benchmarks require a self-hosted Mac with Ollama and are not suitable for every pull request.
- External publishing only occurs through a registered connector job with the required approval scope and policy.
- The Docker + Tailscale chatbot deployment is tested by unit/integration tests against a fake Ollama client (`test/unit/serverRoutes.test.js`, `test/unit/qaDebate.test.js`) and by manually running the plain-Node server; the `docker compose up` + real Tailscale path itself requires your own Docker daemon and Tailscale account and has not been exercised end to end in CI.

## Release checks

Fast CI runs compile, lint, and deterministic unit/integration tests with fake Ollama. The manual/nightly workflow runs the real autonomous E2E on a self-hosted macOS runner after verifying that at least five local models are installed.

To run the complete local release gate and build an installable VSIX:

```bash
npm run check:release
npm run package:vsix
```

The package is written to `dist/local-multi-agent-coder-1.0.1.vsix`. The packaging command automatically installs it into a temporary clean VS Code profile and verifies its manifest and compiled entry point before reporting success.
