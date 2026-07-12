// Domain ToolDef[] -> pi's AgentTool[] shape.
//
// pi-type-bearing by design (see v2/engine/README.md's layer-boundary
// table, which names codec-pi.ts and event-adapter.ts as the only files
// allowed to import @earendil-works/pi-agent-core/pi-ai types) — Task 3
// adds this file as a third, explicitly carved out for the same reason:
// registry.ts/calculator.ts must stay in domain terms, but *something* has
// to speak pi's AgentTool shape, and that mapping is small enough to keep
// isolated here in its own "engine" namespace file rather than folding it
// into registry.ts.
//
// typebox schemas are fed straight to pi's `parameters` field — verified
// empirically for this task (both `tsc --noEmit` and a real offline
// Agent/mock round trip) that a schema built with this repo's pinned
// `@sinclair/typebox@0.34.13` is accepted and correctly validated/parsed
// by pi at runtime, even though pi-agent-core/pi-ai themselves depend on a
// *different*, unscoped `typebox@1.1.38` package for their own TSchema —
// see Task 3 report for the probe. This lines up with 0A S2
// (spikes/pi-provider/REPORT.md), which already established that pi
// validates tool-call arguments against the declared typebox schema.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDef, ToolContext } from "../tools/registry.js";

const label = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * Maps registered ToolDef[] to pi AgentTool[], binding every tool's
 * execute() to the same per-turn `ctx` (a placeholder object for now —
 * repo-scoped access arrives in Phase 4).
 *
 * Errors thrown by a tool's own execute() are caught HERE and turned into
 * a normal (non-throwing) text result — this is the registry-level
 * fault-tolerance backstop from v1's `execute_tool()`
 * (`except Exception as e: return json.dumps({"error": ...})`), ported as
 * "catch, then return error text" rather than "let it throw and rely on
 * pi's own catch". pi's own AgentTool.execute contract documents throwing
 * as its native error-signaling path (a thrown error becomes an
 * `isError:true` tool result upstream in agent-loop.js) — but
 * `AgentToolResult` itself carries no `isError` field, so matching v1's
 * uniform "errors are just text" semantics here (never throwing to pi at
 * all) is the faithful port, not a partial one.
 */
export function toPiTools(defs: ToolDef[], ctx: ToolContext): AgentTool[] {
  return defs.map((def) => ({
    name: def.name,
    label: label(def.name),
    description: def.description,
    parameters: def.schema,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      try {
        const text = await def.execute(params, ctx);
        return { content: [{ type: "text", text }], details: {} };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], details: {} };
      }
    },
  }));
}
