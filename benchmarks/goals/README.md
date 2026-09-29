# M-Core acceptance briefs — v1

Locked on 2026-09-26 before the two additional goals run. Brick Breaker v1
records the prompt already used by run 11; that run remains exploratory and
cannot be retroactively treated as a clean-revision acceptance run.

Each JSON file contains the complete user goal and independently reviewable
requirements. Record its SHA-256 with every run. Change a brief only by creating
a new version and recording why; never edit it to accommodate generated output.

For each goal, require two consecutive passes from fresh workspaces on the same
pipeline revision/configuration. Preserve failed runs too. Every run must show
at least five distinct local models, all four debate rounds, independent review,
real build/test execution, and the requirement evidence below. Do not substitute
handwritten product code, weaken assertions, or count hook-only checks as real
input/collision evidence.

Record revision and dirty-file hashes, brief hash, models/config, phase durations,
retry/fix counts, checkpoints, call logs, stdout, assertion results, screenshots
where applicable, and clean-copy installation/run evidence. A run missing required
evidence is unverified, never a pass. A crash/restart acceptance must retain the
workspace and prove completed actions were not repeated. Budget the next matrix
runs after measuring run 11; record that budget before each run, not afterwards.

For browser goals, check desktop (1280×800) and mobile (390×844), readable controls,
no obstructed input, clear success/error states, keyboard and pointer interaction.
Synthetic DOM events and test hooks are supplementary evidence; retain a real
browser input run for the required user flows. A clean console alone is insufficient.

Node CLI is the chosen third goal (not an additional API product). All data for
tests stays in temporary workspaces. No external service credentials are needed.
