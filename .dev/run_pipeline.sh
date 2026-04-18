#!/bin/bash

# ChromeClaw Agent Pipeline
# Runs coding agent → review agent → fix loop automatically.
# The coding agent implements tasks, the review agent reviews and merges or rejects.
# If rejected, the coding agent runs again to fix issues. Repeats up to MAX_CYCLES.
#
# Usage:
#   .dev/run_pipeline.sh                          # Defaults (3 cycles, 10 iterations per cycle)
#   MAX_CYCLES=5 .dev/run_pipeline.sh             # More fix cycles
#   AGENT_MAX_ITERATIONS=20 .dev/run_pipeline.sh  # More iterations per coding agent run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/agent_logs"
SUMMARY_LOG="${LOG_DIR}/pipeline_summary.log"

MAX_CYCLES="${MAX_CYCLES:-3}"
AGENT_MAX_ITERATIONS="${AGENT_MAX_ITERATIONS:-10}"  # Budget guard: cap iterations per cycle
REVIEW_MODEL="${REVIEW_MODEL:-claude-opus-4-7}"     # Review model
NOTIFY_WEBHOOK="${NOTIFY_WEBHOOK:-}"                # Optional: Slack/Discord webhook URL for notifications

mkdir -p "$LOG_DIR"

echo "=== ChromeClaw Agent Pipeline ===" | tee -a "$SUMMARY_LOG"
echo "Max cycles:              ${MAX_CYCLES}" | tee -a "$SUMMARY_LOG"
echo "Max iterations per cycle: ${AGENT_MAX_ITERATIONS}" | tee -a "$SUMMARY_LOG"
echo "Review model:            ${REVIEW_MODEL}" | tee -a "$SUMMARY_LOG"
echo "[$(date)] Pipeline started" | tee -a "$SUMMARY_LOG"
echo "" | tee -a "$SUMMARY_LOG"

# --- Notification helper ---
notify() {
    local message="$1"
    if [ -n "$NOTIFY_WEBHOOK" ]; then
        curl -s -X POST "$NOTIFY_WEBHOOK" \
            -H "Content-Type: application/json" \
            -d "{\"text\": \"$message\", \"content\": \"$message\"}" \
            >/dev/null 2>&1 || true
    fi
}

# Determine base branch
BASE_BRANCH="main"
if ! git -C "$PROJECT_DIR" branch --list main | grep -q main; then
    BASE_BRANCH="master"
fi

# Prune old logs (older than 7 days)
find "$LOG_DIR" -name "agent_*.log" -mtime +7 -delete 2>/dev/null || true
find "$LOG_DIR" -name "review_*.log" -mtime +7 -delete 2>/dev/null || true

STILL_UNMERGED=0

for i in $(seq 1 "$MAX_CYCLES"); do
    echo "[$(date)] === Cycle ${i}/${MAX_CYCLES}: Coding Agent ===" | tee -a "$SUMMARY_LOG"

    # Run coding agent — parallel or sequential
    if [ "${PARALLEL:-0}" = "1" ]; then
        "$SCRIPT_DIR/run_parallel.sh"
    else
        MAX_ITERATIONS="$AGENT_MAX_ITERATIONS" "$SCRIPT_DIR/run_agent.sh"
    fi
    AGENT_EXIT=$?

    if [ "$AGENT_EXIT" -ne 0 ]; then
        echo "[$(date)] Coding agent failed (exit $AGENT_EXIT). Stopping pipeline." | tee -a "$SUMMARY_LOG"
        notify "ChromeClaw pipeline FAILED: coding agent exit $AGENT_EXIT in cycle $i"
        exit 1
    fi

    # Check if there are unmerged agent branches to review
    UNMERGED=$(git -C "$PROJECT_DIR" branch --no-merged "$BASE_BRANCH" --format='%(refname:short)' 2>/dev/null | grep '^agent/' | wc -l)

    if [ "$UNMERGED" -eq 0 ]; then
        echo "[$(date)] No unmerged agent branches." | tee -a "$SUMMARY_LOG"

        # Check if all phases complete
        if grep -qi "ALL PHASES COMPLETE\|No active phases" "${SCRIPT_DIR}/ACTIVE_PHASES.md" 2>/dev/null; then
            echo "[$(date)] All phases complete. Pipeline done." | tee -a "$SUMMARY_LOG"
            notify "ChromeClaw pipeline COMPLETE: all phases done, no branches to review"
            exit 0
        fi

        echo "[$(date)] No branches but work may remain. Continuing..." | tee -a "$SUMMARY_LOG"
        continue
    fi

    echo "[$(date)] === Cycle ${i}/${MAX_CYCLES}: Review Agent (${UNMERGED} branches) ===" | tee -a "$SUMMARY_LOG"

    REVIEW_LOG="${LOG_DIR}/review_cycle${i}_$(date +%Y%m%d_%H%M%S).log"

    # Run review agent (uses cheaper model by default — Sonnet for review, Opus for coding)
    export ANTHROPIC_BASE_URL="http://localhost:4141"
    export ANTHROPIC_AUTH_TOKEN="anything"

    claude --dangerously-skip-permissions \
           -p "$(cat "${SCRIPT_DIR}/CODE_REVIEW_AGENT_PROMPT.md")" \
           --model "$REVIEW_MODEL" \
           --output-format stream-json --verbose \
           2>&1 | tee "$REVIEW_LOG" &
    REVIEW_PID=$!
    wait "$REVIEW_PID" 2>/dev/null || true

    # Check if all branches were merged
    STILL_UNMERGED=$(git -C "$PROJECT_DIR" branch --no-merged "$BASE_BRANCH" --format='%(refname:short)' 2>/dev/null | grep '^agent/' | wc -l)

    if [ "$STILL_UNMERGED" -eq 0 ]; then
        echo "[$(date)] All branches merged by review agent. Pipeline complete." | tee -a "$SUMMARY_LOG"
        notify "ChromeClaw pipeline COMPLETE: all branches merged after cycle $i"
        exit 0
    fi

    echo "[$(date)] ${STILL_UNMERGED} branches still unmerged. Re-running coding agent..." | tee -a "$SUMMARY_LOG"
done

echo "[$(date)] Max cycles (${MAX_CYCLES}) reached. ${STILL_UNMERGED} branches still unmerged." | tee -a "$SUMMARY_LOG"
notify "ChromeClaw pipeline STALLED: max cycles reached, $STILL_UNMERGED branches unmerged"
exit 1
