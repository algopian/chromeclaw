#!/bin/bash

# Parallel Agent Runner
# Parses a phase todo file for parallel task groups, spawns concurrent Claude Code
# instances (each in its own git worktree), then merges results.
#
# Usage:
#   .dev/run_parallel.sh                          # Auto-detect active phase
#   .dev/run_parallel.sh .dev/todo/active/phase-01-feature.md  # Explicit phase file
#   MAX_PARALLEL=5 .dev/run_parallel.sh           # Max concurrent agents
#
# Task Group Syntax in todo files:
#   ### Tasks — Group A (parallel)     ← tasks run concurrently
#   ### Tasks — Group B (sequential)   ← tasks run one at a time (default)
#   ### Gate                           ← always sequential

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/agent_logs"
SUMMARY_LOG="${LOG_DIR}/parallel_summary.log"
WT_BASE="/tmp/chromeclaw-worktrees"

MAX_PARALLEL="${MAX_PARALLEL:-3}"
AGENT_MODEL="${AGENT_MODEL:-claude-opus-4-6}"

mkdir -p "$LOG_DIR" "$WT_BASE"

# --- Helpers ---

log() {
    echo "[$(date)] $1" | tee -a "$SUMMARY_LOG"
}

cleanup_worktrees() {
    log "Cleaning up worktrees..."
    for wt in "$WT_BASE"/wt-*; do
        if [ -d "$wt" ]; then
            git -C "$PROJECT_DIR" worktree remove --force "$wt" 2>/dev/null || true
        fi
    done
}

trap cleanup_worktrees EXIT

# --- Determine phase file ---

if [ -n "${1:-}" ]; then
    PHASE_FILE="$1"
else
    # Auto-detect from ACTIVE_PHASES.md
    PHASE_FILE=$(grep -oP 'todo/active/\S+\.md' "$SCRIPT_DIR/ACTIVE_PHASES.md" | head -1)
    if [ -z "$PHASE_FILE" ]; then
        log "No active phase found in ACTIVE_PHASES.md"
        exit 0
    fi
    PHASE_FILE="$SCRIPT_DIR/$PHASE_FILE"
fi

if [ ! -f "$PHASE_FILE" ]; then
    log "Phase file not found: $PHASE_FILE"
    exit 1
fi

PHASE_NAME=$(basename "$PHASE_FILE" .md)
log "=== Parallel Agent Runner ==="
log "Phase file:    $PHASE_FILE"
log "Max parallel:  $MAX_PARALLEL"
log "Model:         $AGENT_MODEL"

# Also find requirement file if referenced
REQ_FILE=""
REQ_REF=$(grep -oP 'requirements/\S+\.md' "$SCRIPT_DIR/ACTIVE_PHASES.md" 2>/dev/null | head -1 || true)
if [ -n "$REQ_REF" ] && [ -f "$SCRIPT_DIR/$REQ_REF" ]; then
    REQ_FILE="$SCRIPT_DIR/$REQ_REF"
    log "Requirement:   $REQ_FILE"
fi

# Read overview for context
OVERVIEW_FILE="$SCRIPT_DIR/requirements/overview.md"

# --- Determine base branch ---

BASE_BRANCH="main"
if ! git -C "$PROJECT_DIR" branch --list main | grep -q main 2>/dev/null; then
    BASE_BRANCH="master"
fi

PHASE_BRANCH="agent/${PHASE_NAME}"
log "Base branch:   $BASE_BRANCH"
log "Phase branch:  $PHASE_BRANCH"

# Create phase branch if it doesn't exist
if ! git -C "$PROJECT_DIR" branch --list "$PHASE_BRANCH" | grep -q "$PHASE_BRANCH" 2>/dev/null; then
    git -C "$PROJECT_DIR" checkout -b "$PHASE_BRANCH" 2>/dev/null || git -C "$PROJECT_DIR" checkout "$PHASE_BRANCH"
else
    git -C "$PROJECT_DIR" checkout "$PHASE_BRANCH" 2>/dev/null
fi

# --- Parse phase file into task groups ---

parse_groups() {
    local file="$1"
    local current_group=""
    local current_mode="sequential"
    local task_id=""
    local task_desc=""

    while IFS= read -r line; do
        # Detect group headers: ### Tasks — Group A (parallel)
        if echo "$line" | grep -qiP '###.*\(parallel\)'; then
            current_group=$(echo "$line" | sed 's/###[[:space:]]*//' | sed 's/[[:space:]]*(.*//')
            current_mode="parallel"
            echo "GROUP_START|${current_group}|${current_mode}"
            continue
        elif echo "$line" | grep -qiP '###.*tasks|###.*gate'; then
            current_group=$(echo "$line" | sed 's/###[[:space:]]*//')
            current_mode="sequential"
            echo "GROUP_START|${current_group}|${current_mode}"
            continue
        fi

        # Detect tasks: - [ ] **NN.X**: Description
        if echo "$line" | grep -qP '^\- \[ \] \*\*'; then
            task_id=$(echo "$line" | grep -oP '\*\*[^*]+\*\*' | head -1 | tr -d '*')
            task_desc=$(echo "$line" | sed 's/^- \[ \] \*\*[^*]*\*\*:[[:space:]]*//')
            echo "TASK|${task_id}|${task_desc}|${current_mode}"
        fi
    done < "$file"
}

# Collect parallel and sequential tasks
declare -a PARALLEL_TASKS=()
declare -a PARALLEL_IDS=()
declare -a SEQUENTIAL_TASKS=()
declare -a SEQUENTIAL_IDS=()
CURRENT_MODE="sequential"

while IFS='|' read -r type arg1 arg2 arg3; do
    case "$type" in
        GROUP_START)
            CURRENT_MODE="$arg2"
            ;;
        TASK)
            if [ "$arg3" = "parallel" ]; then
                PARALLEL_IDS+=("$arg1")
                PARALLEL_TASKS+=("$arg2")
            else
                SEQUENTIAL_IDS+=("$arg1")
                SEQUENTIAL_TASKS+=("$arg2")
            fi
            ;;
    esac
done < <(parse_groups "$PHASE_FILE")

log "Parallel tasks: ${#PARALLEL_TASKS[@]}"
log "Sequential tasks: ${#SEQUENTIAL_TASKS[@]}"

# --- Run parallel tasks ---

if [ "${#PARALLEL_TASKS[@]}" -gt 0 ]; then
    log "=== Running ${#PARALLEL_TASKS[@]} parallel tasks (max ${MAX_PARALLEL} concurrent) ==="

    PIDS=()
    TASK_BRANCHES=()
    RUNNING=0

    for idx in "${!PARALLEL_TASKS[@]}"; do
        task_id="${PARALLEL_IDS[$idx]}"
        task_desc="${PARALLEL_TASKS[$idx]}"
        task_slug=$(echo "$task_id" | tr '.' '-')
        task_branch="${PHASE_BRANCH}-task-${task_slug}"
        wt_dir="${WT_BASE}/wt-${PHASE_NAME}-${task_slug}"

        # Wait if at max concurrency
        while [ "$RUNNING" -ge "$MAX_PARALLEL" ]; do
            # Wait for any child to finish
            for i in "${!PIDS[@]}"; do
                if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
                    wait "${PIDS[$i]}" 2>/dev/null || true
                    unset 'PIDS[$i]'
                    RUNNING=$((RUNNING - 1))
                    break
                fi
            done
            # Re-index array
            PIDS=("${PIDS[@]}")
            sleep 1
        done

        log "  Spawning task ${task_id}: ${task_desc}"

        # Create worktree with its own branch
        git -C "$PROJECT_DIR" worktree add "$wt_dir" -b "$task_branch" "$PHASE_BRANCH" 2>/dev/null || {
            # Branch might already exist, try checkout
            git -C "$PROJECT_DIR" worktree add "$wt_dir" "$task_branch" 2>/dev/null || {
                log "  ERROR: Failed to create worktree for ${task_id}"
                continue
            }
        }

        TASK_BRANCHES+=("$task_branch")

        # Build the per-task prompt
        TASK_PROMPT="You are implementing a single task for the ChromeClaw project.

Task ID: ${task_id}
Task: ${task_desc}

Working directory: ${wt_dir}
Branch: ${task_branch}

Context from the phase todo file:
$(grep -A 10 "${task_id}" "$PHASE_FILE" | head -12)

$([ -n "$REQ_FILE" ] && echo "Requirement spec:" && cat "$REQ_FILE" || echo "No separate requirement file.")

Instructions:
1. cd to ${wt_dir} first
2. Implement ONLY this task — do not modify files outside its scope
3. Run: cd ${wt_dir} && pnpm build && pnpm type-check
4. If it passes, commit with message: \"${task_id}: ${task_desc}\"
5. If it fails, fix and retry (max 3 attempts)
6. Do NOT run the full test suite — that happens after merge
7. Do NOT modify the todo file — the orchestrator handles that"

        TASK_LOG="${LOG_DIR}/parallel_${PHASE_NAME}_${task_slug}_$(date +%Y%m%d_%H%M%S).log"

        # Spawn agent in background
        ANTHROPIC_BASE_URL="http://localhost:4141" ANTHROPIC_AUTH_TOKEN="anything" \
        claude --dangerously-skip-permissions \
               -p "$TASK_PROMPT" \
               --model "$AGENT_MODEL" \
               --output-format stream-json --verbose \
               2>&1 > "$TASK_LOG" &
        PIDS+=($!)
        RUNNING=$((RUNNING + 1))

        log "  PID $!: task ${task_id} in ${wt_dir}"
    done

    # Wait for all remaining parallel tasks
    log "Waiting for ${RUNNING} parallel agents to complete..."
    for pid in "${PIDS[@]}"; do
        wait "$pid" 2>/dev/null || true
    done
    log "All parallel tasks complete."

    # --- Merge task branches into phase branch ---
    log "=== Merging ${#TASK_BRANCHES[@]} task branches into ${PHASE_BRANCH} ==="
    git -C "$PROJECT_DIR" checkout "$PHASE_BRANCH"

    MERGE_FAILURES=0
    for task_branch in "${TASK_BRANCHES[@]}"; do
        log "  Merging ${task_branch}..."
        if git -C "$PROJECT_DIR" merge --no-ff "$task_branch" -m "merge: ${task_branch}" 2>&1; then
            log "  Merged ${task_branch} successfully"
            # Clean up task branch
            git -C "$PROJECT_DIR" branch -d "$task_branch" 2>/dev/null || true
        else
            log "  CONFLICT merging ${task_branch} — attempting auto-resolve"
            # Try to auto-resolve with theirs strategy for non-overlapping changes
            if git -C "$PROJECT_DIR" merge --abort 2>/dev/null; then
                if git -C "$PROJECT_DIR" merge -X theirs --no-ff "$task_branch" -m "merge: ${task_branch} (auto-resolved)" 2>&1; then
                    log "  Auto-resolved ${task_branch}"
                    git -C "$PROJECT_DIR" branch -d "$task_branch" 2>/dev/null || true
                else
                    git -C "$PROJECT_DIR" merge --abort 2>/dev/null || true
                    log "  FAILED to merge ${task_branch} — skipping (needs manual resolution)"
                    MERGE_FAILURES=$((MERGE_FAILURES + 1))
                fi
            fi
        fi
    done

    if [ "$MERGE_FAILURES" -gt 0 ]; then
        log "WARNING: ${MERGE_FAILURES} merge failures. Manual resolution may be needed."
    fi

    # Update todo: mark parallel tasks as [x]
    for task_id in "${PARALLEL_IDS[@]}"; do
        sed -i "s/- \[ \] \*\*${task_id}\*\*/- [x] **${task_id}**/" "$PHASE_FILE" 2>/dev/null || true
    done
    git -C "$PROJECT_DIR" add "$PHASE_FILE" && git -C "$PROJECT_DIR" commit -m "chore: mark parallel tasks complete" 2>/dev/null || true

    # Cleanup worktrees
    cleanup_worktrees
fi

# --- Run sequential tasks (gate, review, commit) ---

if [ "${#SEQUENTIAL_TASKS[@]}" -gt 0 ]; then
    log "=== Running ${#SEQUENTIAL_TASKS[@]} sequential tasks ==="

    # Build prompt for sequential work (remaining tasks)
    SEQ_PROMPT="$(cat "${SCRIPT_DIR}/AGENT_PROMPT.md")"

    SEQ_LOG="${LOG_DIR}/parallel_${PHASE_NAME}_sequential_$(date +%Y%m%d_%H%M%S).log"

    claude --dangerously-skip-permissions \
           -p "$SEQ_PROMPT" \
           --model "$AGENT_MODEL" \
           --output-format stream-json --verbose \
           2>&1 | tee "$SEQ_LOG"

    log "Sequential tasks complete."
fi

log "=== Parallel runner finished for ${PHASE_NAME} ==="
