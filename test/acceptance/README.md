# Independent M-Core acceptance

The locked requirements live in `benchmarks/goals/*.v1.json`. These harnesses
inspect generated products; their fixtures validate the harnesses themselves
and must never be substituted for a generated product.

## Tasks CLI

```sh
node test/acceptance/tasksCliAcceptance.js /absolute/generated-workspace /absolute/report.json -- node /absolute/generated-workspace/bin/tasks.js
```

Supply the actual documented executable and arguments. The harness appends
`--data <temporary-file> <command> <arguments> --json`, and launches each command
in a separate process without a shell. It accepts a list array or an object with
a `tasks` array. It exercises persistence, CRUD, errors, store isolation and JSON
output. Reports include command outputs and requirement-level results.

Exit 1 means a failure. Exit 2 means the implemented subset passed but full
acceptance is still unverified: T06 needs an injected write failure before atomic
replacement, and T08 needs installation/testing from a clean product copy.
Perform those checks against the actual product and retain the evidence; do not
change the report to `passed` merely because the subprocess checks passed.

## Generating the two additional products

`test/mcore_goal_e2e.js` accepts `--goal-id local-notes|tasks-cli`, a required
`--workspace`, and a time budget declared with `--budget-minutes`. Use the
internal-disk runner for long local-model work. Only one model benchmark may run
at a time; coordinate through `talking.md` before starting.

Fresh runs require an empty workspace. `--resume` requires the stored brief hash
to match exactly and a saved project state. Reports are invocation-specific;
pipeline completion is always separate from independent product acceptance.
Do not count a resumed or mixed-revision run as either of the two required fresh
consecutive passes. Keep the complete workspace and report directory together,
including logs and checkpoints, when archiving a run.

## Brick Breaker limitations

The existing gameplay harness uses test hooks to accelerate level completion and
life loss. Those checks prove transitions only. Real collisions, natural life
loss, real keyboard/pointer/touch input, distinct level content, visual quality
and clean-copy delivery still need evidence from the generated product. Synthetic
DOM keyboard events are not proof of trusted browser input. A green harness alone
does not satisfy every B01–B08 requirement.
