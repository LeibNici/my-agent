// Tool registry — domain-terms tool definitions + registration/lookup.
//
// No pi types here (see engine/README.md's layer-boundary table): a
// ToolDef speaks only typebox + plain strings/promises. The mapping to
// pi's AgentTool shape lives in src/engine/pi-tools.ts, which is the file
// allowed to import pi types for this task.
//
// Mirrors v1's app/tools/registry.py shape (`@tool` decorator -> global
// `_TOOLS`/`_HANDLERS` dicts, `list_tools()`, `execute_tool()`'s catch-all
// fault tolerance) with one deliberate tightening: v1's decorator silently
// overwrites on re-registration (Python dict assignment), v2 rejects a
// duplicate name outright so an accidental double-registration is caught
// at startup instead of silently shadowing the first tool.
//
// `execute` uses method-shorthand syntax (`execute(input, ctx): Promise<string>`,
// not an arrow-typed property) deliberately — TypeScript checks method-shorthand
// members bivariantly, which is what lets a registry holding many ToolDef<T>
// with DIFFERENT concrete parameter schemas collapse into one `ToolDef[]`
// (see registerTool/listTools below) without every call site fighting
// strictFunctionTypes contravariance.
import type { TSchema, Static } from "@sinclair/typebox";
import type { DbClient } from "../db/client.js";

/** Per-call tool context with repo-scoped access permissions (Phase 4).
 * Values arrive from the per-turn turn.ts caller (Task 8 wires real values;
 * until then, call sites use empty-safe defaults). */
export type ToolContext = {
  allowedRepoPaths: string[]; // already realpath'd repo root directories
  unsyncedRepoNames: string[]; // permitted but never synced (local_path empty)
  userId: number | null; // current turn's user id, or null if unauthed
  /** Optional DB handle for tools that log their own activity (Phase 4b:
   * semantic_search's best-effort recall-quality log). Optional so every
   * existing tool/call site that never passes it keeps compiling and
   * behaving exactly as before — only a tool that explicitly checks
   * `ctx.db` needs it, and it must degrade silently (no log, no error)
   * when absent, matching v1's "logging is best-effort" design. */
  db?: DbClient;
};

export type ToolDef<T extends TSchema = TSchema> = {
  name: string;
  description: string;
  schema: T;
  /** Executes the tool. Must resolve to a string result and must never
   * throw for expected/user-input errors — return `"Error: ..."` text
   * instead (see calculator.ts). toPiTools (src/engine/pi-tools.ts) also
   * catches anything that slips through as a backstop, matching v1
   * registry.execute_tool's outer try/except. */
  execute(input: Static<T>, ctx: ToolContext): Promise<string>;
};

const registry = new Map<string, ToolDef>();

/** Registers a tool. Throws if a tool with the same name is already
 * registered — v1's Python decorator silently overwrites; v2 fails loud
 * instead so a duplicate name is caught at startup, not at call time. */
export function registerTool<T extends TSchema>(def: ToolDef<T>): void {
  if (registry.has(def.name)) {
    throw new Error(`Tool already registered: ${def.name}`);
  }
  registry.set(def.name, def);
}

/** Returns every registered tool, in registration order. */
export function listTools(): ToolDef[] {
  return Array.from(registry.values());
}
