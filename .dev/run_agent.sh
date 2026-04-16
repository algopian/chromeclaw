#!/bin/bash

# ChromeClaw Agent Runner
# Runs Claude in an infinite loop for autonomous long-running tasks.
# Each iteration picks up where the last left off via git state and TODO.md.
#
# Usage:
#   .dev/run_agent.sh                  # Run with defaults (max 100 iterations)
#   MAX_ITERATIONS=50 .dev/run_agent.sh  # Custom iteration limit
#   COOLDOWN=5 .dev/run_agent.sh        # Custom cooldown between iterations

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/agent_logs"
SUMMARY_LOG="${LOG_DIR}/run_summary.log"

# Guard rails — configurable via environment variables
MAX_ITERATIONS="${MAX_ITERATIONS:-100}"
COOLDOWN="${COOLDOWN:-2}"               # Seconds between iterations
MAX_CONSECUTIVE_FAILURES="${MAX_CONSECUTIVE_FAILURES:-5}"

mkdir -p "$LOG_DIR"

# --- Pre-flight checks ---
echo "=== Deep Agent Runner ==="
echo "Working directory:         ${PROJECT_DIR}"
echo "Logs directory:            ${LOG_DIR}"
echo "Max iterations:            ${MAX_ITERATIONS}"
echo "Cooldown between runs:     ${COOLDOWN}s"
echo "Max consecutive failures:  ${MAX_CONSECUTIVE_FAILURES}"
echo ""

if ! command -v claude &>/dev/null; then
    echo "ERROR: 'claude' CLI not found in PATH. Install Claude Code first."
    exit 1
fi

# --- Trap Ctrl+C (SIGINT) and SIGTERM to stop cleanly ---
CHILD_PID=""
cleanup() {
    echo ""
    echo "[$(date)] Caught interrupt signal. Shutting down..." | tee -a "$SUMMARY_LOG"
    if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
        kill "$CHILD_PID" 2>/dev/null
        wait "$CHILD_PID" 2>/dev/null
    fi
    echo "[$(date)] Agent runner stopped." | tee -a "$SUMMARY_LOG"
    exit 0
}
trap cleanup SIGINT SIGTERM

echo "[$(date)] Agent runner started" | tee -a "$SUMMARY_LOG"
echo "Press Ctrl+C to stop."
echo ""

ITERATION=0
CONSECUTIVE_FAILURES=0

while true; do
    ITERATION=$((ITERATION + 1))
    TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

    # --- Guard rail: max iterations ---
    if [ "$ITERATION" -gt "$MAX_ITERATIONS" ]; then
        echo "[$(date)] Max iterations ($MAX_ITERATIONS) reached. Stopping." | tee -a "$SUMMARY_LOG"
        exit 0
    fi

    # Use git commit hash if in a repo, otherwise use timestamp
    COMMIT=""
    if git -C "$PROJECT_DIR" rev-parse --short=6 HEAD 2>/dev/null; then
        COMMIT=$(git -C "$PROJECT_DIR" rev-parse --short=6 HEAD)
    fi

    if [ -n "$COMMIT" ]; then
        LOGFILE="${LOG_DIR}/agent_${COMMIT}_${TIMESTAMP}.log"
    else
        LOGFILE="${LOG_DIR}/agent_${TIMESTAMP}.log"
    fi

    echo "[$(date)] Iteration #${ITERATION}/${MAX_ITERATIONS} — logging to ${LOGFILE}" | tee -a "$SUMMARY_LOG"

    # Run Claude session in background so trap can catch Ctrl+C
    # Stream JSON to log file (raw) and formatted output to console
    # Use RAW_OUTPUT=1 to see raw JSON on screen instead
    export ANTHROPIC_BASE_URL="http://localhost:4141"
    export ANTHROPIC_AUTH_TOKEN="anything"

    FORMATTER="${SCRIPT_DIR}/hooks/format-stream.sh"
    if [ "${RAW_OUTPUT:-0}" = "1" ] || [ ! -x "$FORMATTER" ]; then
        # Raw mode: stream-json straight to screen + log
        claude --dangerously-skip-permissions \
               -p "$(cat "${SCRIPT_DIR}/AGENT_PROMPT.md")" \
               --model claude-opus-4-6 \
               --output-format stream-json --verbose \
               2>&1 | tee "$LOGFILE" &
    else
        # Formatted mode: raw JSON to log, pretty output to screen
        claude --dangerously-skip-permissions \
               -p "$(cat "${SCRIPT_DIR}/AGENT_PROMPT.md")" \
               --model claude-opus-4-6 \
               --output-format stream-json --verbose \
               2>&1 | tee "$LOGFILE" | "$FORMATTER" &
    fi
    CHILD_PID=$!
    wait "$CHILD_PID" 2>/dev/null
    EXIT_CODE=$?
    CHILD_PID=""

    # --- Guard rail: track consecutive failures ---
    if [ "$EXIT_CODE" -ne 0 ]; then
        CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
        echo "[$(date)] Iteration #${ITERATION} FAILED (exit code: ${EXIT_CODE}, consecutive: ${CONSECUTIVE_FAILURES})" | tee -a "$SUMMARY_LOG"

        if [ "$CONSECUTIVE_FAILURES" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
            echo "[$(date)] ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Stopping to prevent runaway spending." | tee -a "$SUMMARY_LOG"
            echo "Last log: ${LOGFILE}"
            exit 1
        fi
    else
        CONSECUTIVE_FAILURES=0
        echo "[$(date)] Iteration #${ITERATION} completed successfully." | tee -a "$SUMMARY_LOG"
    fi

    # --- Check if project says DONE ---
    if [ -f "${SCRIPT_DIR}/ACTIVE_PHASES.md" ] && grep -qi "ALL PHASES COMPLETE\|No active phases" "${SCRIPT_DIR}/ACTIVE_PHASES.md" 2>/dev/null; then
        echo "[$(date)] ACTIVE_PHASES.md indicates no active work. Stopping." | tee -a "$SUMMARY_LOG"
        exit 0
    fi

    sleep "$COOLDOWN"
done
