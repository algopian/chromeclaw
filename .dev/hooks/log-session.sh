#!/bin/bash
# Logs session start/end events and sets the per-session log filename

INPUT=$(cat)
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${PROJECT_DIR}/agent_logs"
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
FILE_TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"' 2>/dev/null)
SESSION=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null | head -c 8)
SOURCE=$(echo "$INPUT" | jq -r '.source // empty' 2>/dev/null)
MODEL=$(echo "$INPUT" | jq -r '.model // empty' 2>/dev/null)

# Build log filename with git commit + timestamp (same pattern as run_agent.sh)
COMMIT=""
if git -C "$PROJECT_DIR" rev-parse --short=6 HEAD 2>/dev/null; then
    COMMIT=$(git -C "$PROJECT_DIR" rev-parse --short=6 HEAD)
fi

if [ -n "$COMMIT" ]; then
    LOG_NAME="hooks_${COMMIT}_${FILE_TIMESTAMP}.log"
else
    LOG_NAME="hooks_${FILE_TIMESTAMP}.log"
fi

# On SessionStart: write the log filename to a marker so other hooks can find it
MARKER="${LOG_DIR}/.current_hooks_log"
if [ "$EVENT" = "SessionStart" ]; then
    echo "$LOG_NAME" > "$MARKER"
fi

# Read current log filename from marker (fallback to generic name)
if [ -f "$MARKER" ]; then
    LOG_NAME=$(cat "$MARKER")
fi
LOG_FILE="${LOG_DIR}/${LOG_NAME}"

LINE="[$TIMESTAMP] [$SESSION] === $EVENT === source=$SOURCE model=$MODEL"

echo -e "\033[33m$LINE\033[0m" >&2
echo "$LINE" >> "$LOG_FILE"

exit 0
