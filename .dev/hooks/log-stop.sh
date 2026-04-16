#!/bin/bash
# Logs when Claude stops responding (end of a turn)
# Captures stop reason, token usage, cost, and duration if available

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

# Parse fields from stop event
SESSION=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null | head -c 8)
REASON=$(echo "$INPUT" | jq -r '.stop_reason // .reason // "unknown"' 2>/dev/null)
TOTAL_COST=$(echo "$INPUT" | jq -r '.total_cost_usd // .cost_usd // empty' 2>/dev/null)
DURATION=$(echo "$INPUT" | jq -r '.duration_ms // empty' 2>/dev/null)
INPUT_TOKENS=$(echo "$INPUT" | jq -r '.usage.input_tokens // .input_tokens // empty' 2>/dev/null)
OUTPUT_TOKENS=$(echo "$INPUT" | jq -r '.usage.output_tokens // .output_tokens // empty' 2>/dev/null)
NUM_TURNS=$(echo "$INPUT" | jq -r '.num_turns // empty' 2>/dev/null)

# Build summary line
SUMMARY="reason=$REASON"
[ -n "$TOTAL_COST" ] && SUMMARY="$SUMMARY cost=\$${TOTAL_COST}"
[ -n "$DURATION" ] && {
    DURATION_S=$(echo "scale=1; ${DURATION} / 1000" | bc 2>/dev/null || echo "${DURATION}ms")
    SUMMARY="$SUMMARY duration=${DURATION_S}s"
}
[ -n "$INPUT_TOKENS" ] && SUMMARY="$SUMMARY in=${INPUT_TOKENS}"
[ -n "$OUTPUT_TOKENS" ] && SUMMARY="$SUMMARY out=${OUTPUT_TOKENS}"
[ -n "$NUM_TURNS" ] && SUMMARY="$SUMMARY turns=${NUM_TURNS}"

LINE="[$TIMESTAMP] [$SESSION] --- STOP --- $SUMMARY"

echo -e "\033[35m$LINE\033[0m" >&2
echo "$LINE" >> "$LOG_FILE"

# Also dump raw JSON for debugging (only to file, not console)
echo "[$TIMESTAMP] [$SESSION] stop_raw: $(echo "$INPUT" | jq -c '.' 2>/dev/null || echo "$INPUT")" >> "$LOG_FILE"

exit 0
