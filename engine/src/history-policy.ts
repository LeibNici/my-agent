import { DomainMessage, DomainBlock, isToolRelay } from "./domain.js";

/** Port of app/main.py:274 `_HISTORY_IMAGE_PLACEHOLDER` — verbatim string. */
export const HISTORY_IMAGE_PLACEHOLDER =
  "[历史消息中的截图已省略；如需模型重看，请让用户重新发送图片]";

/**
 * Port of app/main.py:277-348 `_prepare_model_messages`. Shape persisted
 * history into what gets SENT to the model this turn. The DB copy (the
 * `history` array passed in) is never modified.
 *
 * - Image blocks from past turns are replaced with a text placeholder.
 * - The CURRENT turn (everything from the last plain user message on) is
 *   always sent whole, even if it alone exceeds the window.
 * - PAST turns are condensed rather than sliced: tool_use/tool_result
 *   bookkeeping is dropped and only the text survives.
 * - What's left of the condensed past is then windowed to fit under
 *   maxHistoryMessages alongside the current turn.
 */
export function prepareModelMessages(
  history: DomainMessage[],
  maxHistoryMessages: number
): DomainMessage[] {
  const msgs: DomainMessage[] = history.map((m) => {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map((b: DomainBlock): DomainBlock =>
        b.type === "image" ? { type: "text", text: HISTORY_IMAGE_PLACEHOLDER } : b
      );
    }
    return { role: m.role, content };
  });

  const limit = maxHistoryMessages;
  if (!limit || msgs.length <= limit) {
    return msgs;
  }

  let lastTurnStart = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user" && !isToolRelay(msgs[i])) {
      lastTurnStart = i;
      break;
    }
  }
  const currentTurn = msgs.slice(lastTurnStart);

  const condensed: DomainMessage[] = [];
  for (const m of msgs.slice(0, lastTurnStart)) {
    if (m.role === "user") {
      if (!isToolRelay(m)) {
        // a real question, not a tool_result relay
        condensed.push(m);
      }
    } else if (Array.isArray(m.content)) {
      const texts = m.content.filter((b: DomainBlock) => b.type === "text");
      if (texts.length) {
        // keep what it said, drop the tool_use blocks
        condensed.push({ role: "assistant", content: texts });
      }
    } else {
      // plain-text assistant answer (incl. checkpoint summaries)
      condensed.push(m);
    }
  }

  const room = Math.max(limit - currentTurn.length, 0);
  let windowed = condensed;
  if (condensed.length > room) {
    windowed = room ? condensed.slice(condensed.length - room) : [];
  }
  while (windowed.length && windowed[0].role !== "user") {
    windowed.shift(); // a conversation may not open on an assistant message
  }
  return windowed.concat(currentTurn);
}
