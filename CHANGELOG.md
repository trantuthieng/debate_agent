# Changelog

All notable changes to this project will be documented in this file.

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
