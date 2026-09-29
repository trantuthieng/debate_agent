#!/usr/bin/env bash
# Run a long job (default: the brick-breaker benchmark) from a copy of the repo
# on the internal disk, then copy its outputs back to the Data volume and
# delete the copy.
#
# Why: the repo lives in a OneDrive folder on /Volumes/Data. OneDrive has
# made that whole folder disappear mid-run (benchmark runs 4 and 5 died with
# EACCES) and rewritten node_modules/.bin symlinks, so long runs must not
# execute there.
#
# Usage:  scripts/run-on-internal-disk.sh [command ...]
#         (default command: node test/brick_breaker_e2e.js)
# Env:    DEBATE_LOCAL_RUN_ROOT  where the temporary copy goes (default ~/.debate-agent-runs)
#         COPYBACK_WAIT_MINUTES  how long to wait for the Data folder to reappear (default 240)
#         STAGE_WORKSPACE        resume: a workspace under the repo (e.g. demo/brick-breaker-20-…)
#                                to copy to the internal disk too; BRICK_E2E_WORKSPACE is then
#                                pointed at that internal copy, so the resumed run never writes
#                                to the Data volume. It is copied back with demo/ afterwards.
#
# Outputs copied back: demo/ and dist/ (generated projects' node_modules are
# skipped — reinstall with npm install). The run log ends up in
# dist/local-runs/<run-id>.log. The internal copy is deleted only after every
# copied file is verified byte-for-byte; otherwise it is kept and its path printed.
set -uo pipefail

# bash reads a script file lazily while running it. This file lives on the
# Data volume, so when that volume vanished mid-run (runs 12 and 13,
# 2026-09-27) bash could not read the copy-back section and died, leaving the
# outputs stranded on the internal disk. Run from a private internal copy.
if [ -z "${RUN_ON_INTERNAL_REEXEC:-}" ]; then
  SELF_COPY="$(mktemp -t run-on-internal-disk)"
  cp "$0" "$SELF_COPY" || exit 1
  RUN_ON_INTERNAL_REEXEC=1 RUN_ON_INTERNAL_SRC="$(cd "$(dirname "$0")/.." && pwd)" exec bash "$SELF_COPY" "$@"
fi
trap 'rm -f "$0"' EXIT

SRC="${RUN_ON_INTERNAL_SRC:?}"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
DEST="${DEBATE_LOCAL_RUN_ROOT:-$HOME/.debate-agent-runs}/$RUN_ID"
LOG_DIR="$DEST/dist/local-runs"
LOG="$LOG_DIR/$RUN_ID.log"
WAIT_MINUTES="${COPYBACK_WAIT_MINUTES:-240}"
if [ "$#" -eq 0 ]; then set -- node test/brick_breaker_e2e.js; fi

say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [local-run] $*" | tee -a "$LOG"; }

mkdir -p "$LOG_DIR"
say "Source (Data): $SRC"
say "Internal copy: $DEST"
say "Command: $*"

rsync -a \
  --exclude node_modules --exclude out --exclude demo --exclude dist --exclude .git \
  "$SRC/" "$DEST/" || { say "Copy to internal disk failed."; exit 1; }

# Evidence: which source the run used, including uncommitted changes.
if git -C "$SRC" rev-parse HEAD >/dev/null 2>&1; then
  say "Source revision: $(git -C "$SRC" rev-parse HEAD)"
  say "Uncommitted diff sha256: $(git -C "$SRC" diff HEAD | shasum -a 256 | cut -d' ' -f1) ($(git -C "$SRC" status --porcelain | wc -l | tr -d ' ') changed paths)"
  git -C "$SRC" status --porcelain >>"$LOG" 2>&1
fi

if [ -n "${STAGE_WORKSPACE:-}" ]; then
  rel="${STAGE_WORKSPACE#"$SRC"/}"
  case "$rel" in /*|..*) say "STAGE_WORKSPACE must be inside the repo: $STAGE_WORKSPACE"; exit 1;; esac
  [ -d "$SRC/$rel" ] || { say "STAGE_WORKSPACE not found: $SRC/$rel"; exit 1; }
  mkdir -p "$DEST/$rel"
  rsync -a --exclude node_modules "$SRC/$rel/" "$DEST/$rel/" || { say "Staging $rel failed."; exit 1; }
  export BRICK_E2E_WORKSPACE="$DEST/$rel"
  say "Staged workspace for resume: $rel -> $BRICK_E2E_WORKSPACE (node_modules reinstalled by the run)"
fi

cd "$DEST" || exit 1
if ! npm ci --no-audit --no-fund >>"$LOG" 2>&1; then say "npm ci failed."; exit 1; fi
if ! npm run compile >>"$LOG" 2>&1; then say "Compile failed."; exit 1; fi

say "Starting job."
"$@" >>"$LOG" 2>&1 &
CHILD=$!
trap 'say "Signal received; stopping job."; kill -TERM "$CHILD" 2>/dev/null' INT TERM
wait "$CHILD"; STATUS=$?
# A trapped signal interrupts the first wait; wait again for a clean exit.
if kill -0 "$CHILD" 2>/dev/null; then wait "$CHILD"; STATUS=$?; fi
trap - INT TERM
say "Job exited with status $STATUS."

# Reports embed absolute workspace paths; point them at where the data will live.
find "$DEST/dist" -name '*.json' -newer "$DEST/package.json" -print0 2>/dev/null |
  xargs -0 -I{} perl -pi -e "s#\Q$DEST\E#$SRC#g" {}

waited=0
until [ -d "$SRC/src" ] && [ -w "$SRC" ]; do
  if [ "$waited" -ge "$WAIT_MINUTES" ]; then
    say "Data folder still unavailable after $WAIT_MINUTES min; outputs kept at $DEST"
    exit "$STATUS"
  fi
  [ "$waited" -eq 0 ] && say "Data folder unavailable; waiting up to $WAIT_MINUTES min."
  sleep 60; waited=$((waited + 1))
done

say "Copying outputs back to $SRC."
copy_ok=1
for dir in demo dist; do
  [ -d "$DEST/$dir" ] || continue
  mkdir -p "$SRC/$dir"
  rsync -a --exclude node_modules "$DEST/$dir/" "$SRC/$dir/" || copy_ok=0
done

if [ "$copy_ok" -eq 1 ]; then
  mismatches=$(cd "$DEST" && find demo dist -type f -not -path '*/node_modules/*' 2>/dev/null |
    while IFS= read -r f; do cmp -s "$DEST/$f" "$SRC/$f" || echo "$f"; done)
  # The log itself keeps growing below, so it is re-copied once more at the end.
  mismatches=$(printf '%s\n' "$mismatches" | grep -v "^dist/local-runs/$RUN_ID.log$" | grep -v '^$')
  [ -z "$mismatches" ] || { copy_ok=0; say "Copy verification failed for: $(printf '%s' "$mismatches" | head -5 | tr '\n' ' ')"; }
fi

if [ "$copy_ok" -eq 1 ]; then
  say "Outputs verified on Data; deleting internal copy."
  cp "$LOG" "$SRC/dist/local-runs/$RUN_ID.log"
  cd / && rm -rf "$DEST"
  echo "Done. Log: $SRC/dist/local-runs/$RUN_ID.log"
else
  say "Copy-back incomplete; internal copy kept at $DEST"
fi
exit "$STATUS"
