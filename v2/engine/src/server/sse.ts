// SSE chat orchestration — port of v1's `chat_event_stream`
// (git show v1-python-final:app/main.py). Owns: message-length rejection,
// session resolution (new/not_found/resolved -> transparent new session),
// draining the injected engine's DomainEvent stream into wire-shaped SSE
// frames, and the persistence side effects that happen ALONGSIDE streaming
// (user message first, each tool_exchange the instant it lands, the final
// assistant text at "done", llm_metrics batched and flushed at turn end).
//
// Wire fidelity: the browser (web/app.js) is a HAND-ROLLED SSE line parser
// expecting v1's exact JSON field spellings (snake_case: session_id,
// message_id, budget_exhausted, tool_use_id-shaped blocks) — this file is
// the one place camelCase DomainEvent data gets translated back to that
// wire shape. Two v1 wire-shape facts worth flagging (see task-5-report.md
// for the full verification trail):
//   - tool_exchange is PERSISTED ONLY, never forwarded as an SSE frame
//     (confirmed straight from v1's chat_event_stream: no `yield` in that
//     branch, just two add_message calls).
//   - v1's tool_result SSE event carries a `name` field
//     (`{"id":.., "name":.., "result":..}`, app/agent.py) that the
//     DomainEvent tool_result variant (domain.ts, frozen by Task 6) does
//     NOT carry — {id, result} only. web/app.js's updateToolResult()
//     keys off `data.name` to find the matching "Running..." block, so
//     dropping it silently breaks result rendering for every tool
//     (including this phase's one real tool, calculator). Rather than
//     reopening the frozen Task 4/6 DomainEvent/event-adapter contract for
//     a Task-5-scoped fix, this file tracks id->name locally from the
//     tool_use events it already sees and enriches the wire frame only.
import type { DbClient } from "../db/client.js";
import type { LlmMetricsRow } from "../db/storage.js";
import type { Settings } from "../config.js";
import type { RunTurnFn, RunTurnDeps } from "../engine/turn.js";
import type { ToolDef } from "../tools/registry.js";
import type { DomainBlock } from "../domain.js";
import { domainToLegacy } from "../codec-legacy.js";

// v1 app/main.py:75 — verbatim.
export const MAX_MESSAGE_LENGTH = 10000;

export type ChatRequestBody = {
  session_id?: string | null;
  message: string;
  // Accepted for wire-shape compatibility with the frontend's POST body
  // (web/app.js always sends these) but not yet acted on this phase:
  // skills/tools are calculator-only with no skill gating (GET /api/skills
  // returns [] — see app.ts), repo-scoped tool access is Phase 4, and
  // current-turn image blocks are a known pre-existing gap (codec-pi.ts's
  // domainToPi throws on image DomainBlocks; RunTurnRequest.userText is
  // plain string only — Task 4 never extended it). Silently ignored, not
  // rejected: v1's MAX_MESSAGE_LENGTH check is the only "reject" path this
  // phase ports.
  active_skills?: string[];
  repo_id?: number | null;
  images?: unknown[];
};

export type SseFrame = { event: string; data: string };

export type ChatStreamDeps = {
  db: DbClient;
  settings: Settings;
  engine: RunTurnFn;
  tools: ToolDef[];
};

export type CurrentUser = { id: number; username: string; role: string };

// Shared by chatEventStream and app.ts's GET/DELETE single-session routes —
// v1's `_user_owns_session` (app/main.py), one place for the admin-bypass
// rule instead of re-branching it per call site.
export function userOwnsSession(session: { owner_id: number | null }, user: CurrentUser): boolean {
  return user.role === "admin" || session.owner_id === user.id;
}

/** v1's `_sse_reject`: the standard "reject this request" sequence shared by
 * every early-exit validation — error -> done{session_id:null} -> end. */
async function* sseReject(message: string): AsyncGenerator<SseFrame> {
  yield { event: "error", data: JSON.stringify({ message }) };
  yield { event: "done", data: JSON.stringify({ session_id: null, text: "" }) };
  yield { event: "end", data: "" };
}

/** DomainBlock[] -> legacy (snake_case) shape for persistence, via the
 * codec-legacy.ts boundary — mirrors README.md's "Phase 3 消费点": tool_exchange
 * blocks get `domainToLegacy`'d before hitting SQLite. Role is irrelevant to
 * block conversion (domainToLegacy only transforms `content`), so a fixed
 * "assistant" wrapper role is fine for both call sites below. */
function legacyContent(blocks: DomainBlock[]): unknown[] {
  return domainToLegacy({ role: "assistant", content: blocks }).content as unknown[];
}

function onceAborted(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

/** Races the engine's next DomainEvent against client disconnect. Node async
 * generators have no automatic "cancellation thrown into a suspended await"
 * the way Python's asyncio tasks do — this polling race is the mechanism
 * that lets the abort branch below stand in for v1's
 * `except asyncio.CancelledError`. If `iter.next()` itself rejects (the
 * engine threw), that rejection wins the race and propagates out normally,
 * landing in this module's own try/catch — same as an abort that never fires. */
async function raceAbort<T>(
  iter: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<{ aborted: true } | { aborted: false; result: IteratorResult<T> }> {
  if (!signal) {
    return { aborted: false, result: await iter.next() };
  }
  return Promise.race([
    iter.next().then((result) => ({ aborted: false as const, result })),
    onceAborted(signal).then(() => ({ aborted: true as const })),
  ]);
}

function formatInternalError(err: unknown): string {
  if (err instanceof Error) {
    return `Internal error: ${err.constructor?.name ?? "Error"}: ${err.message}`;
  }
  return `Internal error: ${String(err)}`;
}

/**
 * Generates the SSE frame sequence for one chat turn, persisting alongside
 * as it streams. `opts.signal` (wired by src/server/app.ts to Hono's
 * `stream.onAbort()`) is how a real client disconnect reaches this
 * function — omit it (e.g. from a non-streaming test harness) and the
 * abort branch simply never races.
 */
export async function* chatEventStream(
  deps: ChatStreamDeps,
  req: ChatRequestBody,
  user: CurrentUser,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<SseFrame> {
  const { db, settings, engine, tools } = deps;

  if (req.message.length > MAX_MESSAGE_LENGTH) {
    yield* sseReject(`Message too long (${req.message.length} chars). Max ${MAX_MESSAGE_LENGTH}.`);
    return;
  }

  // Distinguishes, for the client, WHY session_id might differ from what it
  // sent — "new" (no id was sent), "not_found" (the id it sent no longer
  // exists), "resolved" (that thread's task is already done). null when the
  // returned id is exactly what was sent. Mirrors v1's switch_reason exactly.
  let sessionId = req.session_id || null;
  let switchReason: string | null = null;
  if (!sessionId) {
    sessionId = await db.createSession("New Chat", user.id);
    switchReason = "new";
  }

  const session = await db.getSession(sessionId);
  if (!session) {
    sessionId = await db.createSession("New Chat", user.id);
    switchReason = "not_found";
  } else if (!userOwnsSession(session, user)) {
    yield* sseReject("Access denied");
    return;
  } else if (session.resolved_at) {
    // Transparent new session — the client picks up the new id from the
    // "session" event below, same as when it sends session_id=null.
    sessionId = await db.createSession("New Chat", user.id);
    switchReason = "resolved";
  }

  // Tell the client the real session_id right away, not just at "done" — a
  // tool_result event can render UI the user acts on before "done" ever
  // fires (see v1's comment on this same yield in app/main.py).
  yield { event: "session", data: JSON.stringify({ session_id: sessionId, reason: switchReason }) };

  const history = await db.getMessages(sessionId);
  await db.addMessage(sessionId, "user", req.message);

  let fullText = "";
  // Text streamed since the last fully-persisted tool exchange — the
  // fallback saved if the connection drops or the turn errors before a
  // normal "done".
  let currentTextBuffer = "";
  // Accumulated in memory, flushed in one batch at turn end (v1's
  // record_llm_call_metrics) rather than a DB round-trip per LLM call.
  const pendingMetrics: LlmMetricsRow[] = [];
  // tool_use.id -> name, so the tool_result wire frame can carry `name`
  // even though the DomainEvent itself doesn't (see file header).
  const toolNameById = new Map<string, string>();

  const runTurnDeps: RunTurnDeps = { db, settings, tools };
  const engineIter = engine(runTurnDeps, { sessionId, history, userText: req.message })[Symbol.asyncIterator]();

  try {
    for (;;) {
      const step = await raceAbort(engineIter, opts.signal);
      if (step.aborted) {
        // Client disconnected mid-turn (closed tab, hit Stop, network drop)
        // — the Node analogue of v1's `except asyncio.CancelledError`.
        // Completed tool exchanges were already persisted below as they
        // happened; save whatever text had streamed for the turn in
        // progress too, so the session doesn't just silently end with
        // nothing. No further frames (no done/end) — the generator just
        // ends, mirroring v1's re-raise terminating the SSE response.
        if (currentTextBuffer) {
          await db.addMessage(sessionId, "assistant", currentTextBuffer + "\n\n_（回复未完成：连接已中断）_");
        }
        await db.recordLlmCallMetrics(pendingMetrics);
        try {
          await engineIter.return(undefined);
        } catch {
          // best-effort — the client is already gone
        }
        return;
      }

      const { value: event, done } = step.result;
      if (done) break;

      switch (event.type) {
        case "text_delta": {
          fullText += event.data.text;
          currentTextBuffer += event.data.text;
          yield { event: "text", data: JSON.stringify({ text: event.data.text }) };
          break;
        }
        case "tool_use": {
          toolNameById.set(event.data.id, event.data.name);
          yield {
            event: "tool_use",
            data: JSON.stringify({ id: event.data.id, name: event.data.name, input: event.data.input }),
          };
          break;
        }
        case "tool_result": {
          yield {
            event: "tool_result",
            data: JSON.stringify({
              id: event.data.id,
              name: toolNameById.get(event.data.id) ?? null,
              result: event.data.result,
            }),
          };
          break;
        }
        case "tool_exchange": {
          // Persist each completed exchange as soon as it happens (not
          // batched until "done") so it survives a later cancellation or
          // error in this same turn. Never forwarded to the browser.
          await db.addMessage(sessionId, "assistant", legacyContent(event.data.assistant));
          await db.addMessage(sessionId, "user", legacyContent(event.data.results));
          currentTextBuffer = "";
          break;
        }
        case "llm_metrics": {
          pendingMetrics.push({
            session_id: sessionId,
            user_id: user.id,
            model: event.data.model,
            iteration: event.data.iteration,
            input_tokens: event.data.inputTokens,
            output_tokens: event.data.outputTokens,
            ttft_ms: event.data.ttftMs,
            total_ms: event.data.totalMs,
          });
          break;
        }
        case "done": {
          let finalMessageId: number | null = null;
          if (event.data.success) {
            const finalText = event.data.text ?? "";
            if (finalText) {
              finalMessageId = await db.addMessage(sessionId, "assistant", finalText);
            }
            // v1 main.py's chat_event_stream: on a successful turn, a
            // session still titled "New Chat" gets its title derived from
            // this turn — first 50 chars of the user's message, falling
            // back to the model's own text (image-only turns, out of scope
            // here — codec-pi.ts's domainToPi still throws on image
            // blocks) and finally the image count. Re-fetches the session
            // HERE (not the `session` var captured earlier) because the
            // "not_found"/"resolved" transparent-new-session branches leave
            // that variable pointing at the OLD session, if anything.
            const s = await db.getSession(sessionId);
            if (s && s.title === "New Chat") {
              let title: string;
              if (req.message.trim()) {
                title = req.message.slice(0, 50);
              } else if (finalText.trim()) {
                title = finalText.trim().slice(0, 50);
              } else if (req.images && req.images.length > 0) {
                title = `${req.images.length} image(s)`;
              } else {
                title = "New Chat";
              }
              await db.updateSessionTitle(sessionId, title);
            }
          } else {
            // LLM error / max-iterations: save whatever text had already
            // streamed for this turn instead of losing it. event.data.text
            // is NOT the source of truth here — event-adapter.ts's fail()
            // always sends "" (it has no visibility into what streamed
            // before the failure) — currentTextBuffer is the buffer this
            // module has been accumulating from text_delta events all
            // along, same role as v1's current_text_buffer.
            const partialText = event.data.text || currentTextBuffer;
            if (partialText) {
              await db.addMessage(sessionId, "assistant", partialText + "\n\n_（回复未完成：发生错误）_");
            }
          }
          await db.recordLlmCallMetrics(pendingMetrics);
          pendingMetrics.length = 0;
          // message_id lets the client attach feedback to this answer;
          // budget_exhausted tells it this is a checkpoint, not a finished
          // answer (offers "继续调查").
          yield {
            event: "done",
            data: JSON.stringify({
              session_id: sessionId,
              text: fullText,
              message_id: finalMessageId,
              budget_exhausted: event.data.budgetExhausted ?? false,
            }),
          };
          break;
        }
        case "error": {
          yield { event: "error", data: JSON.stringify({ message: event.data.message }) };
          break;
        }
      }
    }
  } catch (err) {
    if (currentTextBuffer) {
      await db.addMessage(sessionId, "assistant", currentTextBuffer + "\n\n_（回复未完成：发生错误）_");
    }
    await db.recordLlmCallMetrics(pendingMetrics);
    yield { event: "error", data: JSON.stringify({ message: formatInternalError(err) }) };
    yield { event: "done", data: JSON.stringify({ session_id: sessionId, text: fullText }) };
  }
  yield { event: "end", data: "" };
}
