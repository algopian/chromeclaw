#!/bin/bash
# Logs every tool use with timestamp, tool name, and key details to console + log file

INPUT=$(cat)
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${PROJECT_DIR}/agent_logs"
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

# Read current session's log filename from marker (set by log-session.sh on SessionStart)
MARKER="${LOG_DIR}/.current_hooks_log"
if [ -f "$MARKER" ]; then
    LOG_NAME=$(cat "$MARKER")
else
    LOG_NAME="hooks_$(date +"%Y%m%d_%H%M%S").log"
fi
LOG_FILE="${LOG_DIR}/${LOG_NAME}"

# Check if jq is available
if ! command -v jq &>/dev/null; then
    echo "[$TIMESTAMP] ERROR: jq not installed" >> "$LOG_FILE"
    echo "[$TIMESTAMP] ERROR: jq not installed" >&2
    exit 0
fi

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"' 2>/dev/null)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)
SESSION=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null | head -c 8)

# Extract useful detail depending on tool type
case "$TOOL" in
    Bash)
        DETAIL=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null | head -c 120)
        ;;
    Write|Edit|Read)
        DETAIL=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
        ;;
    Glob)
        DETAIL=$(echo "$INPUT" | jq -r '.tool_input.pattern // empty' 2>/dev/null)
        ;;
    Grep)
        DETAIL=$(echo "$INPUT" | jq -r '"\(.tool_input.pattern // "") in \(.tool_input.path // ".")"' 2>/dev/null)
        ;;
    Task)
        DETAIL=$(echo "$INPUT" | jq -r '.tool_input.description // empty' 2>/dev/null)
        ;;
    *)
        DETAIL=$(echo "$INPUT" | jq -r '.tool_input | keys | join(", ")' 2>/dev/null || echo "")
        ;;
esac

LINE="[$TIMESTAMP] [$SESSION] $EVENT | $TOOL | $DETAIL"

echo -e "\033[36m$LINE\033[0m" >&2
echo "$LINE" >> "$LOG_FILE"

exit 0
