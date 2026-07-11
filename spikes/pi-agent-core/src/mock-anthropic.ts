// A scripted Anthropic-messages-compatible SSE server. Lets Phase 0B run
// fully offline AND assert on the exact request bodies pi sends — the only
// reliable way to answer "can we inject a reminder before call N+1" (Task 10).
//
// Event framing verified directly against the parser this feeds:
// node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js
// (`iterateAnthropicEvents` / `decodeSseLine` / `ANTHROPIC_MESSAGE_EVENTS`).
// Two things the brief's sketch already had right, confirmed by reading that
// parser rather than guessing:
//   - Each frame needs both an `event: <type>` line AND a JSON `data:` line
//     whose own `type` field matches — the parser gates on `sse.event`
//     (the SSE frame's event name) against a fixed set of six message/
//     content-block event types, then separately parses `data` and reads
//     `.type` off the parsed JSON. Get either one wrong and the frame is
//     silently dropped (unknown `sse.event`) or throws (JSON `type`
//     mismatch causes ambiguity downstream in the block-type switch).
//   - `message_delta`'s `usage` field is accessed directly
//     (`event.usage.input_tokens != null`), never through optional
//     chaining — omitting `usage` entirely (not just its sub-fields) throws
//     "Cannot read properties of undefined" and aborts the stream.
import http from "node:http";
import type { AddressInfo } from "node:net";

export type SseEvent = { type: string; [k: string]: unknown };

export type RecordedRequest = { at: number; body: unknown };

export type MockServer = {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
};

/** A single-content-block assistant turn that ends in plain text. */
export function textTurn(text: string): SseEvent[] {
  return [
    {
      type: "message_start",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        content: [],
        model: "mock",
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

/** A single-content-block assistant turn that ends in a tool call. */
export function toolTurn(name: string, input: object, id: string): SseEvent[] {
  return [
    {
      type: "message_start",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        content: [],
        model: "mock",
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

/**
 * Starts a scripted mock Anthropic Messages server: request N gets
 * `turns[N]`'s SSE events (0-indexed); once the script is exhausted it keeps
 * replying with a text turn so a run doesn't hang mid-loop. Every request
 * body is recorded with a wall-clock timestamp in `requests`, in arrival
 * order — the primary artifact this spike exists to produce.
 */
export function startMock(turns: SseEvent[][]): MockServer {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = { __parseError: true, raw };
      }
      const requestIndex = requests.length;
      requests.push({ at: Date.now(), body });

      const turn = turns[requestIndex] ?? textTurn("(script exhausted)");
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const ev of turn) {
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      res.end();
    });
  });
  server.listen(0);
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    requests,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
