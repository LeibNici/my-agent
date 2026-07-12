// Calculator tool — safe arithmetic evaluation, ported from v1's
// app/tools/calculator.py with a deliberately narrowed grammar.
//
// v1 evaluated a full Python `ast.parse(...)` tree (functions like sqrt/
// sin/pow, constants pi/e, lists/tuples, resource-limit checks). This task
// intentionally supports a smaller whitelist instead — digits, `+ - * / % ( )
// .` and whitespace — per the Task 3 brief. NO eval/Function: input is
// tokenized and parsed by hand (recursive descent) over that fixed
// character whitelist, so there is no code path that could ever hand a
// model-controlled string to the JS interpreter (see the `__import__` test
// in test/tools.test.ts — it is rejected at the tokenizer, same as any
// other disallowed character, not "detected" as a suspicious pattern).
//
// Fault tolerance matches v1's calculator() exactly in shape: every
// expected failure (division by zero, syntax errors) is caught internally
// and returned as `"Error: <message>"` text — execute() never throws. The
// one piece of v1's exact wording that survives the narrowed grammar is
// division-by-zero: Python's `ZeroDivisionError` stringifies to literally
// "division by zero", so `str(e)` in v1's `except Exception as e: return
// f"Error: {e}"` produces exactly "Error: division by zero" — ported
// verbatim below. (v1's tool *description* claims support for "powers, and
// common math functions" it shares with this narrower grammar's ancestor;
// that claim is intentionally NOT ported since it would be false for what
// this tool actually accepts — see Task 3 report.)
import { Type, type Static } from "@sinclair/typebox";
import { registerTool, type ToolDef } from "./registry.js";

const CalculatorParams = Type.Object({ expression: Type.String() });

class CalcError extends Error {}

const ALLOWED_CHAR = /[0-9+\-*/%().\s]/;

type Token =
  | { kind: "num"; value: number }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "%" }
  | { kind: "lparen" }
  | { kind: "rparen" };

function tokenize(expression: string): Token[] {
  for (const ch of expression) {
    if (!ALLOWED_CHAR.test(ch)) {
      throw new CalcError(`unexpected character '${ch}'`);
    }
  }

  const tokens: Token[] = [];
  let i = 0;
  while (i < expression.length) {
    const c = expression[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c >= "0" && c <= "9" || c === ".") {
      const start = i;
      let sawDigit = false;
      let sawDot = false;
      while (i < expression.length) {
        const cc = expression[i];
        if (cc >= "0" && cc <= "9") {
          sawDigit = true;
          i++;
        } else if (cc === "." && !sawDot) {
          sawDot = true;
          i++;
        } else {
          break;
        }
      }
      const text = expression.slice(start, i);
      if (!sawDigit) {
        throw new CalcError(`invalid number '${text}'`);
      }
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new CalcError(`number too large '${text}'`);
      }
      tokens.push({ kind: "num", value });
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "%") {
      tokens.push({ kind: "op", value: c });
      i++;
      continue;
    }
    /* istanbul ignore next -- unreachable: every char already passed ALLOWED_CHAR above */
    throw new CalcError(`unexpected character '${c}'`);
  }
  return tokens;
}

// Recursive-descent parser over the token stream. Grammar:
//   expression := term (('+' | '-') term)*
//   term       := unary (('*' | '/' | '%') unary)*
//   unary      := ('+' | '-') unary | primary
//   primary    := NUMBER | '(' expression ')'
class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    if (this.tokens.length === 0) {
      throw new CalcError("empty expression");
    }
    const value = this.parseExpression();
    if (this.pos < this.tokens.length) {
      throw new CalcError("unexpected token after expression");
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && (t.value === "+" || t.value === "-")) {
        this.pos++;
        const rhs = this.parseTerm();
        value = t.value === "+" ? value + rhs : value - rhs;
      } else {
        break;
      }
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && (t.value === "*" || t.value === "/" || t.value === "%")) {
        this.pos++;
        const rhs = this.parseUnary();
        if ((t.value === "/" || t.value === "%") && rhs === 0) {
          throw new CalcError("division by zero");
        }
        value = t.value === "*" ? value * rhs : t.value === "/" ? value / rhs : value % rhs;
        if (!Number.isFinite(value)) {
          throw new CalcError("result is infinity or NaN");
        }
      } else {
        break;
      }
    }
    return value;
  }

  private parseUnary(): number {
    const t = this.peek();
    if (t?.kind === "op" && (t.value === "+" || t.value === "-")) {
      this.pos++;
      const value = this.parseUnary();
      return t.value === "-" ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const t = this.peek();
    if (!t) {
      throw new CalcError("unexpected end of expression");
    }
    if (t.kind === "num") {
      this.pos++;
      return t.value;
    }
    if (t.kind === "lparen") {
      this.pos++;
      const value = this.parseExpression();
      const close = this.peek();
      if (close?.kind !== "rparen") {
        throw new CalcError("missing closing parenthesis");
      }
      this.pos++;
      return value;
    }
    throw new CalcError("expected a number or '('");
  }
}

function evaluate(expression: string): number {
  const tokens = tokenize(expression);
  return new Parser(tokens).parse();
}

async function execute(input: Static<typeof CalculatorParams>): Promise<string> {
  try {
    const result = evaluate(input.expression);
    return String(result);
  } catch (err) {
    // Catches CalcError from tokenize/parse/evaluate AND anything
    // unforeseen (e.g. a pathological input deep enough to overflow the
    // call stack) — calculator.execute must never throw, matching v1's
    // `except Exception as e: return f"Error: {e}"` backstop.
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

export const calculatorTool: ToolDef<typeof CalculatorParams> = {
  name: "calculator",
  description: "Evaluate a basic arithmetic expression (numbers, +, -, *, /, %, parentheses) and return the result.",
  schema: CalculatorParams,
  execute,
};

registerTool(calculatorTool);
