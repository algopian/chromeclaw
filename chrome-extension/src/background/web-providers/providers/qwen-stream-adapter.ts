/**
 * Qwen SSE stream adapter — handles phase-based think/answer transitions
 * and native function_call interception for Qwen and DeepSeek web providers.
 *
 * Extracted from web-llm-bridge.ts so the logic is independently testable.
 */

import { escapeXml } from '../tool-prompt';
import type { SseStreamAdapter } from '../sse-stream-adapter';

interface ChoiceDelta {
  phase?: string;
  status?: string;
  role?: string;
  content?: string;
  function_call?: { name: string; arguments: string };
  function_id?: string;
  name?: string;
}

/** Extract the first choice delta from a parsed SSE payload. */
const getChoiceDelta = (parsed: unknown): ChoiceDelta | undefined => {
  const choices = (parsed as Record<string, unknown>).choices as
    | Array<{ delta?: ChoiceDelta }>
    | undefined;
  return choices?.[0]?.delta;
};

/** Default key when no function_id is present on the SSE event. */
const DEFAULT_FN_KEY = '__default__';

/**
 * Matches Qwen's native "tool not found" response.
 * Known messages: "Tool list does not exists.", "Tool browser does not exists."
 * Case-insensitive to guard against future phrasing changes.
 */
const NATIVE_TOOL_FAILURE_RE = /\btool\b.+\bdoes not exist/i;

/** Safety cap for the completed-default queue to prevent unbounded growth. */
const MAX_DEFAULT_QUEUE = 50;

interface PendingCall {
  name: string;
  arguments: string;
}

const createQwenStreamAdapter = (): SseStreamAdapter => {
  let currentPhase: string | undefined;
  /** Set to true when a native tool call gets "Tool X does not exists" from Qwen's server. */
  let nativeToolFailed = false;
  /**
   * Track pending native function_calls by function_id.
   * Qwen can send multiple parallel function_calls (e.g. two web_search calls
   * with different function_ids). Using a Map ensures each response is matched
   * to the correct call, preventing "Tool X does not exists" text from leaking
   * into the output when earlier responses consume the wrong pending call.
   */
  const pendingFunctionCalls = new Map<string, PendingCall>();

  /**
   * FIFO queue for completed function_calls that had no function_id.
   *
   * Qwen sometimes sends multiple sequential function_calls without function_id
   * (e.g. 6 `read` calls in a row). Each new call resets `arguments` to `""`,
   * while the previous call had fully-accumulated non-empty arguments. When we
   * detect this reset, we move the completed call into this queue so it isn't
   * overwritten. Function responses without function_id dequeue from here first.
   */
  const completedDefaultQueue: PendingCall[] = [];

  /** Build prefix string for a phase transition. */
  const phasePrefix = (fromPhase: string | undefined, toPhase: string | undefined): string => {
    let prefix = '';
    if (fromPhase === 'think') prefix += '</think>';
    if (toPhase === 'think') prefix += '<think>';
    return prefix;
  };

  return {
    processEvent({ parsed, delta }) {
      const choiceDelta = getChoiceDelta(parsed);
      const phase = choiceDelta?.phase;

      // --- Native function_call accumulation ---
      if (choiceDelta?.function_call) {
        const fnKey = choiceDelta.function_id ?? DEFAULT_FN_KEY;
        const existing = pendingFunctionCalls.get(fnKey);

        // Detect a NEW sequential call on the default key: the existing entry
        // has non-empty arguments but the incoming arguments reset to empty.
        // This means Qwen is starting a new call — save the completed one.
        if (
          fnKey === DEFAULT_FN_KEY &&
          existing &&
          existing.arguments.length > 0 &&
          choiceDelta.function_call.arguments === ''
        ) {
          if (completedDefaultQueue.length >= MAX_DEFAULT_QUEUE) {
            completedDefaultQueue.shift(); // drop oldest to stay bounded
          }
          completedDefaultQueue.push(existing);
        }

        pendingFunctionCalls.set(fnKey, {
          name: choiceDelta.function_call.name,
          arguments: choiceDelta.function_call.arguments,
        });
        // Close thinking if phase changed
        if (phase && phase !== currentPhase) {
          const prefix = phasePrefix(currentPhase, undefined);
          currentPhase = phase;
          if (prefix) return { feedText: prefix };
        }
        return null;
      }

      // --- Native function response → XML tool_call conversion ---
      if (choiceDelta?.role === 'function') {
        // Match response to the correct pending call by function_id
        const fnKey = choiceDelta.function_id ?? DEFAULT_FN_KEY;

        // For responses without function_id, check the completed queue first
        // (FIFO order), then fall back to the in-progress pending entry.
        let pending: PendingCall | undefined;
        if (fnKey === DEFAULT_FN_KEY && completedDefaultQueue.length > 0) {
          pending = completedDefaultQueue.shift();
        } else {
          pending = pendingFunctionCalls.get(fnKey);
          if (pending) {
            pendingFunctionCalls.delete(fnKey);
          }
        }

        if (pending) {
          // Detect native tool failure: Qwen says "Tool X does not exists."
          // This means Qwen's server doesn't have this tool — our bridge will
          // handle it. Everything Qwen generates after this point is based on
          // the false assumption that the tool is unavailable.
          const content = choiceDelta.content ?? '';
          if (NATIVE_TOOL_FAILURE_RE.test(content)) {
            nativeToolFailed = true;
          }

          let prefix = '';
          if (currentPhase === 'think') {
            prefix = '</think>';
            currentPhase = 'answer';
          }
          const toolId = crypto.randomUUID().slice(0, 8);
          const safeName = escapeXml(pending.name);
          const xmlToolCall = `<tool_call id="${toolId}" name="${safeName}">${pending.arguments}</tool_call>`;
          return { feedText: prefix + xmlToolCall };
        }
        // No matching pending call — suppress the "Tool X does not exists" content
        // that Qwen sends as the function response body. Without this guard the
        // error text would leak into the visible text stream.
        return null;
      }

      // --- Regular delta with phase tracking ---
      if (delta) {
        let feedText = delta;
        if (phase && phase !== currentPhase) {
          feedText = phasePrefix(currentPhase, phase) + delta;
        }
        currentPhase = phase;
        return { feedText };
      }

      // --- Empty delta but phase changed ---
      if (phase && phase !== currentPhase) {
        const prefix = phasePrefix(currentPhase, undefined);
        currentPhase = phase;
        if (prefix) return { feedText: prefix };
      }

      return null;
    },

    flush() {
      if (currentPhase === 'think') {
        currentPhase = undefined;
        return { feedText: '</think>' };
      }
      return null;
    },

    shouldAbort() {
      return nativeToolFailed;
    },
  };
};

export { createQwenStreamAdapter };
