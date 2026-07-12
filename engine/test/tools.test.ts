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
import { startMock, toolTurn, textTurn } from "./mock-anthropic.js";
import { runTurnThroughAdapter } from "./agent-harness.js";

// A minimal hand-built ToolDef for exercising registry/toPiTools in
// isolation, without depending on calculator.ts's own registration side
// effect or its specific schema.
const defaultContext = {
  allowedRepoPaths: [],
  unsyncedRepoNames: [],
  userId: null,
};

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
  const evalExpr = (expression: string) => calculatorTool.execute({ expression }, defaultContext);

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

  it("supports decimals — float result formatting matches Python str() (1.5+2.5 is two float literals, str(4.0) === \"4.0\", not bare \"4\") (H2)", async () => {
    expect(await evalExpr("1.5+2.5")).toBe("4.0");
  });

  it("ignores surrounding/internal whitespace", async () => {
    expect(await evalExpr(" 1 + 1 ")).toBe("2");
  });

  it("respects operator precedence (mul before add)", async () => {
    expect(await evalExpr("2+3*4")).toBe("14");
  });
});

describe("calculator — errors are returned as text, never thrown (v1 registry fault-tolerance semantics)", () => {
  const evalExpr = (expression: string) => calculatorTool.execute({ expression }, defaultContext);

  it("division by zero returns v1's error text, does not throw", async () => {
    await expect(evalExpr("5/0")).resolves.toMatch(/^Error: division by zero$/);
  });

  it("modulo by zero returns v1's exact ZeroDivisionError text for int%int ('integer modulo by zero'), not the generic /-by-zero message (H1)", async () => {
    await expect(evalExpr("5%0")).resolves.toBe("Error: integer modulo by zero");
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
    const inputs = ["", "   ", "((((", "1/0", "1%0", "@#$", "1..2", "()", "1//0", "2**", "0**-1"];
    for (const expression of inputs) {
      await expect(evalExpr(expression)).resolves.toEqual(expect.any(String));
    }
  });
});

describe("toPiTools — maps ToolDef[] to pi's AgentTool[] shape", () => {
  it("maps name/description/schema straight through (typebox schema fed directly to pi)", () => {
    const def = makeDummyTool("__pi_shape__");
    const [piTool] = toPiTools([def], defaultContext);
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
    const [piTool] = toPiTools([def], defaultContext);
    const result = await piTool.execute("tool_call_1", { x: "a" } as never);
    expect(result).toEqual({ content: [{ type: "text", text: "the-result" }], details: {} });
  });

  it("forwards ctx through to the underlying ToolDef.execute", async () => {
    const def = makeDummyTool("__pi_ctx__", async (_input, ctx) =>
      JSON.stringify(ctx),
    );
    const ctx = {
      allowedRepoPaths: ["/repos/test"],
      unsyncedRepoNames: [],
      userId: 123,
    };
    const [piTool] = toPiTools([def], ctx);
    const result = await piTool.execute("tool_call_1", { x: "a" } as never);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(ctx) }]);
  });

  it("wraps a thrown execute error as a text result instead of rejecting (v1 registry.execute_tool backstop)", async () => {
    const def = makeDummyTool("__pi_throws__", async () => {
      throw new Error("boom");
    });
    const [piTool] = toPiTools([def], defaultContext);
    const result = await piTool.execute("tool_call_1", { x: "a" } as never);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("boom");
  });

  it("does not throw/reject even when the underlying tool throws", async () => {
    const def = makeDummyTool("__pi_throws_2__", async () => {
      throw new Error("kaboom");
    });
    const [piTool] = toPiTools([def], defaultContext);
    await expect(piTool.execute("id", { x: "a" } as never)).resolves.toBeDefined();
  });

  it("end-to-end: the real calculator ToolDef through toPiTools behaves like a pi tool", async () => {
    const piTools: AgentTool[] = toPiTools([calculatorTool], defaultContext);
    const calc = piTools.find((t) => t.name === "calculator");
    expect(calc).toBeDefined();
    const result = await calc!.execute("id", { expression: "1+1" } as never);
    expect(result.content).toEqual([{ type: "text", text: "2" }]);
  });
});

// Fix-pass tests below (review findings H1/H2/M1/M2 — see Task 3 fix
// report). Every target string/value was verified by actually running
// `python3 -c` (or `python3 -c` + `ast.dump`/`repr(str(e))` for precision),
// not recalled from memory, per the fix instructions.
describe("calculator — float result formatting matches Python str() (H2)", () => {
  const evalExpr = (expression: string) => calculatorTool.execute({ expression }, defaultContext);

  it("4/2 = 2.0, not 2 — true division (/) always yields float, even for an exact int/int result", async () => {
    expect(await evalExpr("4/2")).toBe("2.0");
  });

  it("float contagion from either operand: int + float and float + int both render with a trailing .0", async () => {
    expect(await evalExpr("2.0+3")).toBe("5.0");
    expect(await evalExpr("2+3.0")).toBe("5.0");
  });

  it("int op int (no '.' literal anywhere) stays a bare int, no trailing .0", async () => {
    expect(await evalExpr("7+2")).toBe("9");
    expect(await evalExpr("7*2")).toBe("14");
  });

  it("negative-zero float keeps Python's sign in str() — str(-0.0) === \"-0.0\"; plain JS String(-0) silently drops it to \"0\"", async () => {
    expect(await evalExpr("0/-1")).toBe("-0.0");
  });
});

describe("calculator — per-operator, floatness-aware zero-division error text, verbatim from Python's ZeroDivisionError (H1)", () => {
  const evalExpr = (expression: string) => calculatorTool.execute({ expression }, defaultContext);

  it("/ by zero: int/int -> 'division by zero', float-involved -> 'float division by zero'", async () => {
    expect(await evalExpr("5/0")).toBe("Error: division by zero");
    expect(await evalExpr("5.0/0")).toBe("Error: float division by zero");
    expect(await evalExpr("5/0.0")).toBe("Error: float division by zero");
  });

  it("% by zero: int/int -> 'integer modulo by zero', float-involved -> 'float modulo' (no 'by zero' suffix on the float case — verified against real Python, not assumed)", async () => {
    expect(await evalExpr("5%0")).toBe("Error: integer modulo by zero");
    expect(await evalExpr("5.0%0")).toBe("Error: float modulo");
    expect(await evalExpr("5%0.0")).toBe("Error: float modulo");
  });

  it("// by zero: int/int -> 'integer division or modulo by zero', float-involved -> 'float floor division by zero'", async () => {
    expect(await evalExpr("5//0")).toBe("Error: integer division or modulo by zero");
    expect(await evalExpr("5.0//0")).toBe("Error: float floor division by zero");
    expect(await evalExpr("5//0.0")).toBe("Error: float floor division by zero");
  });

  it("0 ** negative exponent: Python raises ZeroDivisionError (not Infinity), same wording regardless of int/float typing", async () => {
    expect(await evalExpr("0**-1")).toBe("Error: 0.0 cannot be raised to a negative power");
    expect(await evalExpr("0.0**-1")).toBe("Error: 0.0 cannot be raised to a negative power");
  });
});

describe("calculator — ** and // added to match v1's _SAFE_BINOPS exactly (M1)", () => {
  const evalExpr = (expression: string) => calculatorTool.execute({ expression }, defaultContext);

  it("2**3 = 8 (int ** non-negative int -> int)", async () => {
    expect(await evalExpr("2**3")).toBe("8");
  });

  it("2**0.5 matches Python's str(2**0.5) exactly (shortest-roundtrip float repr)", async () => {
    expect(await evalExpr("2**0.5")).toBe("1.4142135623730951");
  });

  it("2**-1 = 0.5 — a negative int exponent still produces a float result even though neither operand is written as a float literal", async () => {
    expect(await evalExpr("2**-1")).toBe("0.5");
  });

  it("10//3 = 3 (positive operands, floor === truncate here)", async () => {
    expect(await evalExpr("10//3")).toBe("3");
  });

  it("-7//2 = -4 — Python floor division rounds toward negative infinity, not toward zero (truncation would give -3)", async () => {
    expect(await evalExpr("-7//2")).toBe("-4");
  });

  it("7.0//2 = 3.0 — float-involved floor division still floors, but stays a float", async () => {
    expect(await evalExpr("7.0//2")).toBe("3.0");
  });

  it("-2**2 = -4 — ** binds tighter than a LEADING unary minus (Python: factor := unary factor | power, power := primary ['**' factor]), so this is -(2**2), not (-2)**2", async () => {
    expect(await evalExpr("-2**2")).toBe("-4");
  });

  it("2**3**2 = 512 — ** is right-associative (2**(3**2) = 512), not left-associative ((2**3)**2 would be 64)", async () => {
    expect(await evalExpr("2**3**2")).toBe("512");
  });
});

describe("calculator — % follows Python's floored-division sign (result takes the divisor's sign), not JS's native truncated-remainder %", () => {
  const evalExpr = (expression: string) => calculatorTool.execute({ expression }, defaultContext);

  it("-7%2 = 1 in Python; JS's native -7 % 2 is -1 — ported by hand via the floor-division identity, not JS's % operator", async () => {
    expect(await evalExpr("-7%2")).toBe("1");
  });

  it("7%-2 = -1 in Python; JS's native 7 % -2 is +1", async () => {
    expect(await evalExpr("7%-2")).toBe("-1");
  });
});

describe("calculator — v1 Pow bounds: exponent checked FIRST, then base, both max ±10000 (M3)", () => {
  // Every expected string below is the byte-exact output of the REAL v1
  // calculator() (tagged source executed via python3 with the registry
  // import stubbed), not derived from reading its f-strings — see Task 3
  // fix report (M3/M4 pass) for the oracle transcript.
  const evalExpr = (expression: string) => calculatorTool.execute({ expression }, defaultContext);

  it("|base| > 10000 -> Base error, v1 template verbatim (value rendered int-style)", async () => {
    expect(await evalExpr("20000**2")).toBe("Error: Base too large (20000, max ±10000)");
  });

  it("|exponent| > 10000 -> Exponent error, v1 template verbatim", async () => {
    expect(await evalExpr("2**10001")).toBe("Error: Exponent too large (10001, max ±10000)");
  });

  it("both out of bounds -> Exponent wins (v1 checks exponent before base — order proof)", async () => {
    expect(await evalExpr("20000**20000")).toBe("Error: Exponent too large (20000, max ±10000)");
  });

  it("bounds fire before the 0**negative ZeroDivisionError check (v1 order: bounds, then operator.pow)", async () => {
    expect(await evalExpr("0**-20000")).toBe("Error: Exponent too large (-20000, max ±10000)");
  });

  it("rendered value is int/float-aware like the rest of the calculator: float base shows trailing .0", async () => {
    expect(await evalExpr("20000.0**2")).toBe("Error: Base too large (20000.0, max ±10000)");
    expect(await evalExpr("2**10000.5")).toBe("Error: Exponent too large (10000.5, max ±10000)");
  });

  it("negative out-of-bounds exponent renders with its sign", async () => {
    expect(await evalExpr("2**-10001")).toBe("Error: Exponent too large (-10001, max ±10000)");
  });

  it("bound is strict (>): exactly ±10000 is still allowed on both sides", async () => {
    expect(await evalExpr("9999**2")).toBe("99980001");
    expect(await evalExpr("10000**2")).toBe("100000000");
  });
});

describe("calculator — int results with |value| > 1e15 render as Python f'{:.6e}' (M4)", () => {
  const evalExpr = (expression: string) => calculatorTool.execute({ expression }, defaultContext);

  it("1000000000*10000000 = 1e16 -> '1.000000e+16' (JS toExponential(6) byte-matches Python :.6e here)", async () => {
    expect(await evalExpr("1000000000*10000000")).toBe("1.000000e+16");
  });

  it("2**100 -> '1.267651e+30' (rounding at the 7th significant digit matches CPython's bignum :.6e)", async () => {
    expect(await evalExpr("2**100")).toBe("1.267651e+30");
  });

  it("negative big int keeps its sign: -2**100 -> '-1.267651e+30'", async () => {
    expect(await evalExpr("-2**100")).toBe("-1.267651e+30");
  });

  it("threshold is strict (>): exactly 1e15 stays plain digits; 1e15+1 reformats", async () => {
    expect(await evalExpr("1000000000000000")).toBe("1000000000000000");
    expect(await evalExpr("1000000000000001")).toBe("1.000000e+15");
  });

  it("float results are exempt — v1 gates on isinstance(result, int): 2.0**53 stays str()-rendered, 2**53 (int) reformats", async () => {
    expect(await evalExpr("2.0**53")).toBe("9007199254740992.0");
    expect(await evalExpr("2**53")).toBe("9.007199e+15");
  });
});

describe("calculator through the real pi pipeline — typebox↔pi regression guard (M2)", () => {
  // registry.ts/calculator.ts build CalculatorParams from @sinclair/typebox
  // @0.34.13 (engine's own declared dependency), but
  // @earendil-works/pi-agent-core / pi-ai depend on a *different*, unscoped
  // typebox@1.1.38 package for their own TSchema/argument validation (see
  // Task 3 report's "typebox vs pi's typebox" section — verified there with
  // a throwaway probe that was never committed as a real test). `tsc
  // --noEmit` alone only proves the two packages' *types* line up
  // structurally; it can't prove pi's REAL runtime argument validator,
  // built against ITS OWN typebox instance, actually accepts and correctly
  // parses a schema object built from the OTHER package. This drives a real
  // pi Agent (the Task 6/7 offline mock-Anthropic rig) through a scripted
  // tool_use turn using the real calculatorTool mapped through the real
  // toPiTools, proving the whole path end to end rather than only the
  // type-level compatibility tsc already checks.
  it("a scripted tool_use turn round-trips through toPiTools([calculatorTool]) with pi's own argument validation delivering correctly-typed args", async () => {
    const mock = startMock([
      toolTurn("calculator", { expression: "6*7" }, "tu_regress"),
      textTurn("答案是 42"),
    ]);
    try {
      const events = await runTurnThroughAdapter(mock, "6*7 是多少?", {
        tools: toPiTools([calculatorTool], defaultContext),
      });

      const toolUse = events.find((e) => e.type === "tool_use")?.data as
        | { id: string; name: string; input: Record<string, unknown> }
        | undefined;
      expect(toolUse).toEqual({ id: "tu_regress", name: "calculator", input: { expression: "6*7" } });

      const toolResult = events.find((e) => e.type === "tool_result")?.data as
        | { id: string; result: string }
        | undefined;
      expect(toolResult).toEqual({ id: "tu_regress", result: "42" });
    } finally {
      // A failed assertion above must not leak the listening mock server.
      await mock.close();
    }
  });
});
