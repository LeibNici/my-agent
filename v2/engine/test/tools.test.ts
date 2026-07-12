// Task 3: tool registry + calculator.
//
// registry.ts stays in domain terms (no pi types — see README's layer
// table); pi-tools.ts is the one place in this task allowed to speak pi
// shapes, so its tests import pi types directly (permitted per the task
// brief — test files are exempt from the src/ boundary rule).
import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { registerTool, listTools, type ToolDef } from "../src/tools/registry.js";
import { calculatorTool } from "../src/tools/calculator.js";
import { toPiTools } from "../src/engine/pi-tools.js";

// A minimal hand-built ToolDef for exercising registry/toPiTools in
// isolation, without depending on calculator.ts's own registration side
// effect or its specific schema.
function makeDummyTool(name: string, execute: ToolDef["execute"] = async () => "ok"): ToolDef {
  return {
    name,
    description: `${name} description`,
    schema: Type.Object({ x: Type.String() }),
    execute,
  };
}

describe("registry — registerTool / listTools", () => {
  it("registerTool adds a tool that listTools then returns", () => {
    const def = makeDummyTool("__test_register_list__");
    registerTool(def);
    const found = listTools().find((t) => t.name === "__test_register_list__");
    expect(found).toBeDefined();
    expect(found?.description).toBe("__test_register_list__ description");
    expect(found?.schema).toBe(def.schema);
  });

  it("rejects registering a duplicate tool name", () => {
    const name = "__test_duplicate__";
    registerTool(makeDummyTool(name));
    expect(() => registerTool(makeDummyTool(name))).toThrow();
  });

  it("listTools returns ToolDef-shaped entries (name/description/schema/execute)", () => {
    registerTool(makeDummyTool("__test_shape__"));
    const found = listTools().find((t) => t.name === "__test_shape__");
    expect(found).toMatchObject({
      name: "__test_shape__",
      description: "__test_shape__ description",
    });
    expect(typeof found?.execute).toBe("function");
    expect(found?.schema).toBeDefined();
  });

  it("calculator self-registers on import (side-effecting registration, matching the v1 @tool decorator pattern)", () => {
    const found = listTools().find((t) => t.name === "calculator");
    expect(found).toBeDefined();
    expect(found).toBe(calculatorTool);
  });
});

describe("calculator — arithmetic (v1-parity: 1+1=2, 2*(3+4)=14, 10/4=2.5)", () => {
  const evalExpr = (expression: string) => calculatorTool.execute({ expression }, {});

  it("1+1 = 2", async () => {
    expect(await evalExpr("1+1")).toBe("2");
  });

  it("2*(3+4) = 14", async () => {
    expect(await evalExpr("2*(3+4)")).toBe("14");
  });

  it("10/4 = 2.5", async () => {
    expect(await evalExpr("10/4")).toBe("2.5");
  });

  it("supports modulo", async () => {
    expect(await evalExpr("10%3")).toBe("1");
  });

  it("supports unary minus", async () => {
    expect(await evalExpr("-5+3")).toBe("-2");
  });

  it("supports nested parentheses", async () => {
    expect(await evalExpr("((1+2)*3)")).toBe("9");
  });

  it("supports decimals", async () => {
    expect(await evalExpr("1.5+2.5")).toBe("4");
  });

  it("ignores surrounding/internal whitespace", async () => {
    expect(await evalExpr(" 1 + 1 ")).toBe("2");
  });

  it("respects operator precedence (mul before add)", async () => {
    expect(await evalExpr("2+3*4")).toBe("14");
  });
});

describe("calculator — errors are returned as text, never thrown (v1 registry fault-tolerance semantics)", () => {
  const evalExpr = (expression: string) => calculatorTool.execute({ expression }, {});

  it("division by zero returns v1's error text, does not throw", async () => {
    await expect(evalExpr("5/0")).resolves.toMatch(/^Error: division by zero$/);
  });

  it("modulo by zero returns error text, does not throw", async () => {
    await expect(evalExpr("5%0")).resolves.toMatch(/^Error: division by zero$/);
  });

  it("letters are rejected as illegal characters, returned as error text", async () => {
    const result = await evalExpr("2+abc");
    expect(result).toMatch(/^Error: /);
  });

  it("a `__import__` payload is rejected as text, never executed (no eval/Function — proves the whitelist, not a string-content check)", async () => {
    const result = await evalExpr("__import__('os').system('echo pwned')");
    expect(result).toMatch(/^Error: /);
    expect(result).not.toContain("pwned");
  });

  it("dangling operator (incomplete expression) is a syntax error, not a throw", async () => {
    const result = await evalExpr("1+");
    expect(result).toMatch(/^Error: /);
  });

  it("unbalanced parentheses is a syntax error, not a throw", async () => {
    const result = await evalExpr("(1+2");
    expect(result).toMatch(/^Error: /);
  });

  it("empty expression is a syntax error, not a throw", async () => {
    const result = await evalExpr("");
    expect(result).toMatch(/^Error: /);
  });

  it("never throws regardless of input — execute always resolves", async () => {
    const inputs = ["", "   ", "((((", "1/0", "1%0", "@#$", "1..2", "()"];
    for (const expression of inputs) {
      await expect(evalExpr(expression)).resolves.toEqual(expect.any(String));
    }
  });
});

describe("toPiTools — maps ToolDef[] to pi's AgentTool[] shape", () => {
  it("maps name/description/schema straight through (typebox schema fed directly to pi)", () => {
    const def = makeDummyTool("__pi_shape__");
    const [piTool] = toPiTools([def], {});
    expect(piTool.name).toBe("__pi_shape__");
    expect(piTool.description).toBe("__pi_shape__ description");
    expect(piTool.parameters).toBe(def.schema);
    expect(typeof piTool.label).toBe("string");
    expect(piTool.label.length).toBeGreaterThan(0);
    expect(piTool.executionMode).toBe("sequential");
    expect(typeof piTool.execute).toBe("function");
  });

  it("a successful execute resolves to pi's AgentToolResult shape: {content:[{type:'text',text}], details:{}}", async () => {
    const def = makeDummyTool("__pi_success__", async () => "the-result");
    const [piTool] = toPiTools([def], {});
    const result = await piTool.execute("tool_call_1", { x: "a" } as never);
    expect(result).toEqual({ content: [{ type: "text", text: "the-result" }], details: {} });
  });

  it("forwards ctx through to the underlying ToolDef.execute", async () => {
    const def = makeDummyTool("__pi_ctx__", async (_input, ctx) =>
      JSON.stringify(ctx),
    );
    const ctx = { marker: "phase3" };
    const [piTool] = toPiTools([def], ctx);
    const result = await piTool.execute("tool_call_1", { x: "a" } as never);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(ctx) }]);
  });

  it("wraps a thrown execute error as a text result instead of rejecting (v1 registry.execute_tool backstop)", async () => {
    const def = makeDummyTool("__pi_throws__", async () => {
      throw new Error("boom");
    });
    const [piTool] = toPiTools([def], {});
    const result = await piTool.execute("tool_call_1", { x: "a" } as never);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("boom");
  });

  it("does not throw/reject even when the underlying tool throws", async () => {
    const def = makeDummyTool("__pi_throws_2__", async () => {
      throw new Error("kaboom");
    });
    const [piTool] = toPiTools([def], {});
    await expect(piTool.execute("id", { x: "a" } as never)).resolves.toBeDefined();
  });

  it("end-to-end: the real calculator ToolDef through toPiTools behaves like a pi tool", async () => {
    const piTools: AgentTool[] = toPiTools([calculatorTool], {});
    const calc = piTools.find((t) => t.name === "calculator");
    expect(calc).toBeDefined();
    const result = await calc!.execute("id", { expression: "1+1" } as never);
    expect(result.content).toEqual([{ type: "text", text: "2" }]);
  });
});
