#!/bin/bash
# Formats Claude's stream-json output into readable console output
# Usage: claude --output-format stream-json ... | ./format-stream.sh
#
# Colors:
#   Green  = Claude's text output
#   Cyan   = Tool calls
#   Yellow = Tool results (truncated)
#   Red    = Errors

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

while IFS= read -r line; do
    # Skip empty lines
    [ -z "$line" ] && continue

    # Try to parse as JSON
    TYPE=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)

    case "$TYPE" in
        assistant)
            # Claude's text output — content is an array of {type, text} objects
            MSG=$(echo "$line" | jq -r '[.message.content[]? | select(.type=="text") | .text] | join("\n") // empty' 2>/dev/null)
            if [ -n "$MSG" ]; then
                echo -e "\n${GREEN}${MSG}${RESET}"
            fi
            ;;
        content_block_delta)
            # Streaming text delta
            TEXT=$(echo "$line" | jq -r '.delta.text // empty' 2>/dev/null)
            if [ -n "$TEXT" ]; then
                printf "${GREEN}%s${RESET}" "$TEXT"
            fi
            ;;
        content_block_stop)
            # End of a content block
            echo ""
            ;;
        tool_use)
            # Tool being called
            TOOL=$(echo "$line" | jq -r '.tool // .name // empty' 2>/dev/null)
            case "$TOOL" in
                Bash)
                    CMD=$(echo "$line" | jq -r '.input.command // empty' 2>/dev/null | head -c 150)
                    echo -e "${CYAN}${BOLD}▶ Bash:${RESET}${CYAN} ${CMD}${RESET}"
                    ;;
                Read)
                    FILE=$(echo "$line" | jq -r '.input.file_path // empty' 2>/dev/null)
                    echo -e "${CYAN}${BOLD}▶ Read:${RESET}${CYAN} ${FILE}${RESET}"
                    ;;
                Write)
                    FILE=$(echo "$line" | jq -r '.input.file_path // empty' 2>/dev/null)
                    echo -e "${CYAN}${BOLD}▶ Write:${RESET}${CYAN} ${FILE}${RESET}"
                    ;;
                Edit)
                    FILE=$(echo "$line" | jq -r '.input.file_path // empty' 2>/dev/null)
                    echo -e "${CYAN}${BOLD}▶ Edit:${RESET}${CYAN} ${FILE}${RESET}"
                    ;;
                Glob)
                    PAT=$(echo "$line" | jq -r '.input.pattern // empty' 2>/dev/null)
                    echo -e "${CYAN}${BOLD}▶ Glob:${RESET}${CYAN} ${PAT}${RESET}"
                    ;;
                Grep)
                    PAT=$(echo "$line" | jq -r '.input.pattern // empty' 2>/dev/null)
                    echo -e "${CYAN}${BOLD}▶ Grep:${RESET}${CYAN} ${PAT}${RESET}"
                    ;;
                Task)
                    DESC=$(echo "$line" | jq -r '.input.description // empty' 2>/dev/null)
                    echo -e "${CYAN}${BOLD}▶ Task:${RESET}${CYAN} ${DESC}${RESET}"
                    ;;
                *)
                    echo -e "${CYAN}${BOLD}▶ ${TOOL}${RESET}"
                    ;;
            esac
            ;;
        tool_result)
            # Tool result (show truncated)
            TOOL=$(echo "$line" | jq -r '.tool // empty' 2>/dev/null)
            # Show first 200 chars of result
            RESULT=$(echo "$line" | jq -r '.content // .output // empty' 2>/dev/null | head -c 200)
            if [ -n "$RESULT" ]; then
                echo -e "${DIM}${YELLOW}  ← ${TOOL}: ${RESULT}${RESET}"
            fi
            ;;
        error)
            MSG=$(echo "$line" | jq -r '.error.message // .message // empty' 2>/dev/null)
            echo -e "${RED}${BOLD}ERROR: ${MSG}${RESET}"
            ;;
        result)
            # Final result — extract stats from the result event
            SUBTYPE=$(echo "$line" | jq -r '.subtype // "unknown"' 2>/dev/null)
            IS_ERROR=$(echo "$line" | jq -r '.is_error // false' 2>/dev/null)
            DURATION_MS=$(echo "$line" | jq -r '.duration_ms // 0' 2>/dev/null)
            NUM_TURNS=$(echo "$line" | jq -r '.num_turns // 0' 2>/dev/null)
            COST=$(echo "$line" | jq -r '.total_cost_usd // 0' 2>/dev/null)
            RESULT_TEXT=$(echo "$line" | jq -r '.result // empty' 2>/dev/null)

            # Convert duration to human-readable
            if [ "$DURATION_MS" -gt 0 ] 2>/dev/null; then
                DURATION_S=$((DURATION_MS / 1000))
                MINS=$((DURATION_S / 60))
                SECS=$((DURATION_S % 60))
                if [ "$MINS" -gt 0 ]; then
                    DURATION_STR="${MINS}m ${SECS}s"
                else
                    DURATION_STR="${SECS}s"
                fi
            else
                DURATION_STR="unknown"
            fi

            echo ""
            if [ "$IS_ERROR" = "true" ]; then
                echo -e "${RED}${BOLD}━━━ ✗ Session FAILED ━━━${RESET}"
            else
                echo -e "${GREEN}${BOLD}━━━ ✓ Session Complete ━━━${RESET}"
            fi
            echo ""

            if [ -n "$RESULT_TEXT" ]; then
                echo -e "${GREEN}${RESULT_TEXT}${RESET}"
                echo ""
            fi

            # Stats summary
            echo -e "${DIM}──── Stats ────${RESET}"
            printf "  ⏱  Duration:  %s\n" "$DURATION_STR"
            printf "  🔄 Turns:     %s\n" "$NUM_TURNS"
            printf "  💰 Cost:      \$%s\n" "$COST"

            # Per-model cost breakdown
            MODEL_KEYS=$(echo "$line" | jq -r '.modelUsage // {} | keys[]' 2>/dev/null)
            if [ -n "$MODEL_KEYS" ]; then
                echo -e "  ${DIM}Model breakdown:${RESET}"
                echo "$MODEL_KEYS" | while read -r model; do
                    M_COST=$(echo "$line" | jq -r ".modelUsage[\"$model\"].costUSD // 0" 2>/dev/null)
                    M_IN=$(echo "$line" | jq -r ".modelUsage[\"$model\"].inputTokens // 0" 2>/dev/null)
                    M_OUT=$(echo "$line" | jq -r ".modelUsage[\"$model\"].outputTokens // 0" 2>/dev/null)
                    printf "    %-32s  \$%-10s  in:%-8s  out:%-8s\n" "$model" "$M_COST" "$M_IN" "$M_OUT"
                done
            fi
            echo -e "${DIM}───────────────${RESET}"
            ;;
        *)
            # Unknown type — print raw if it looks meaningful
            if echo "$line" | jq -e '.type' &>/dev/null; then
                echo -e "${DIM}${line}${RESET}" | head -c 200
            fi
            ;;
    esac
done
