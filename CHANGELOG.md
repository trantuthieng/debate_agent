# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Guaranteed multi-model debate panel**: a runtime guard now assigns a *distinct* local model to each of the five round-4 judges even when two roles share a primary model in config (e.g. critic and reviewer). Each judge keeps its role lens but borrows a still-unused model from the roster; if the roster is too small to reach five, the shortfall is logged, journaled, and recorded as an assumption instead of silently passing.
- **On-demand research capability** (`ResearchService`): agents can call `web_search` (cited, freshness-stamped findings) and — when enabled — `find_code_examples` / `read_repo_file` to discover and read code from public GitHub/GitLab repositories and learn from existing high-quality implementations. Web research is no longer gated by a narrow keyword whitelist: it runs whenever it can add value (explicit research intent or any new-project build) and is opt-in/policy-governed via `webSearch.enabled` and `githubIntegration.allowExternalRepoReads`. All findings carry source URLs + retrieval timestamps and are journaled as citations.
- Unit tests for the debate-panel diversity guard, the opt-in research service (citations/format), and the command-approval tool flow.

### Changed
- **Quality audit no longer silently passes on failure**: if the independent auditor model is unavailable even after self-healing retries, the cross-check now degrades to a deterministic heuristic audit (stubs/TODOs/empty bodies) and records an explicit "DEGRADED" uncertainty in the journal and brief, instead of returning a false approval.
- **Command approval is now wired end-to-end**: a risky command requested via the `run_command` tool asks the boss for approval (honoring the ask-policy) and runs only if approved; in fully autonomous / never-ask mode it is declined with a clearly logged, journaled reason instead of failing opaquely or hanging.

- **4-round debate engine**: the pre-build debate now runs Round 1 (proposal) → Round 2 (critic + product cross-critique) → Round 3 (proposer responds to every critique and converges) → Round 4 (a 5-model judging panel scores the approach across weighted criteria and votes on the winning direction). The decision is fed into the project brief.
- **Code quality cross-check**: after the task reviewer passes, an independent, stronger model audits the change against overall production standards (correctness, completeness, error handling, security, architecture consistency). Its findings feed the existing fix loop, which now iterates until both the reviewer and the auditor are satisfied.
- **Live work journal** (`AGENT_JOURNAL.md`): a human-readable, timestamped, icon-tagged log written at the workspace root throughout the run — every proposal, critique, debate verdict, task, review/audit result, retrospective, and final report, appended chronologically (newest at the bottom).
- Unit tests for the debate score aggregation/normalization, the journal, the transactional patch apply, and stderr-redirect command policy.

### Changed
- Generalized the Code Worker prompt: domain/locale rules are now derived from the project brief instead of being hardcoded to a single industry/locale.
- `OllamaClient` text keep-alive is now configurable and defaults to 30s (was 60s) to reduce VRAM pressure on constrained hardware (e.g. 24 GB Macs).
- Raised the default `maxFixRetries` from 5 to 8 to favour final-product quality over speed.
- Command policy now evaluates external-write redirections even for otherwise safe-prefixed commands (previously a safe prefix could bypass the check).

### Fixed
- `CommandPolicy` now also detects external-write redirections via `2>`, `&>`, and numbered file descriptors (previously only `>`/`>>`).
- App smoke verification no longer treats HTTP 4xx responses as success (now requires `< 400`).
- Multi-file patches are applied transactionally — nothing is written to disk unless every file patches cleanly.

### Removed
- Deleted the dead, unwired legacy template generator subsystem (`generateAppCommand`, `appGeneratorService`, `codeGenerationService`, `templateMatcherService`, `dependencyResolverService`, the `models/` directory, and their tests). It was fully superseded by the `AgentOrchestrator` multi-agent workflow and was reachable from nothing. This also removed the last hardcoded single-domain (VN finance/gold) code templates.
- Cleaned local scratch/generated artifacts from the repo working tree (improvement reports, ad-hoc `test/run_*.js` scripts, `generated-apps/`, runtime logs).

## [1.0.1] - 2026-05-30

### Added
- Cross-session lessons memory and micro-sprint feedback injection into coding context.
- Wave-based parallel code-worker execution with safer sequential apply/review/fix processing.

### Changed
- Increased default local model context window from 8k to 32k.
- Added per-role model effort tuning (temperature/context/output behavior by agent role).
- Improved reviewer policy with uncertainty reporting and stronger runtime-failure gating.

### Fixed
- Reduced redundant micro-sprint check runs within coding waves.
- Refreshed architecture and rolling-summary reads per wave to avoid stale context.
- Improved self-healing retries with exponential backoff and jitter.

## [1.0.0] - 2026-05-29

### Added
- Initial project setup with basic structure and functionality.
- Autonomous multi-agent workflow hardening, deterministic recovery paths, URL context fetching, and expanded node:test coverage.
- Basic error handling mechanism.
- Unit tests for core services.
- Documentation updates.

### Changed
- Refactored code organization to improve modularity.
- Updated dependencies to latest versions.

### Fixed
- Resolved minor bugs in template matching.

## [0.9.0] - 2026-05-27

### Added
- Initial commit with basic project structure.
