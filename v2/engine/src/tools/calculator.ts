// Calculator tool — safe arithmetic evaluation, ported from v1's
// app/tools/calculator.py with a deliberately narrowed grammar.
//
// v1 evaluated a full Python `ast.parse(...)` tree (functions like sqrt/
// sin/pow, constants pi/e, lists/tuples, resource-limit checks). This task
// intentionally supports a smaller whitelist instead — digits, `+ - * / % (
// ) . whitespace`, plus the two-character operators `**` and `//` (M1 fix:
// these round out v1's `_SAFE_BINOPS` exactly — Add/Sub/Mult/Div/Mod were
// there from the start, FloorDiv/Pow were added by the parity fix pass; no
// new characters needed since both reuse existing whitelisted chars). v1's
// `_SAFE_UNARYOPS` is just UAdd/USub (confirmed straight from the tagged
// source) — already exactly what this grammar supports, unchanged. NO
// eval/Function: input is tokenized and parsed by hand (recursive descent)
// over that fixed character whitelist, so there is no code path that could
// ever hand a model-controlled string to the JS interpreter (see the
// `__import__` test in test/tools.test.ts — it is rejected at the
// tokenizer, same as any other disallowed character, not "detected" as a
// suspicious pattern).
//
// Fault tolerance matches v1's calculator() exactly in shape: every
// expected failure (division by zero, syntax errors) is caught internally
// and returned as `"Error: <message>"` text — execute() never throws.
//
// Python-semantics parity fix pass (H1/H2/M1 — see Task 3 fix report for
// the full python3-verified transcript this is derived from): every
// numeric literal and result is tracked as a `PyNumber` (value + isFloat),
// threaded through evaluation exactly like CPython's int/float distinction,
// so that:
//   - result formatting matches Python's str() exactly: float results that
//     are integer-valued still render with a trailing ".0"
//     (str(4.0) === "4.0"), bare ints don't (H2, see formatResult).
//   - zero-division error text matches Python's ZeroDivisionError verbatim,
//     per operator AND per int-vs-float-involved (H1) — e.g. `5 % 0` ->
//     "integer modulo by zero" but `5.0 % 0` -> "float modulo" (no "by
//     zero" suffix on that one — verified against real Python, not
//     assumed; see the apply* functions below for the full table and
//     `**`'s "0.0 cannot be raised to a negative power" case).
//   - `%` uses Python's FLOORED modulo (result takes the divisor's sign),
//     not JS's native truncated-remainder `%` operator, which disagrees for
//     mixed-sign operands (-7 % 2 is 1 in Python, -1 under JS's `%`) — found
//     while verifying M1/H1 against v1's operator.mod, fixed alongside since
//     leaving it wrong would contradict this same commit's "python-semantics
//     parity" for the exact operator being touched.
// Every target string/value in the apply*/formatResult functions and in
// test/tools.test.ts's fix-pass describe blocks was verified by actually
// running the equivalent `python3 -c`, not recalled from memory (per the
// fix instructions) — see Task 3 fix report for the transcript.
import { Type, type Static } from "@sinclair/typebox";
import { registerTool, type ToolDef } from "./registry.js";

const CalculatorParams = Type.Object({ expression: Type.String() });

class CalcError extends Error {}

const ALLOWED_CHAR = /[0-9+\-*/%().\s]/;

type Token =
  | { kind: "num"; value: number; isFloat: boolean }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "%" | "**" | "//" }
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
    if ((c >= "0" && c <= "9") || c === ".") {
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
      // A literal with a '.' is a Python float (even "5." or ".5"); one
      // without is a Python int — this drives every downstream
      // int/float-result-typing rule below (H2), matching how CPython's own
      // tokenizer/ast.Constant distinguishes int vs float literals.
      tokens.push({ kind: "num", value, isFloat: sawDot });
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
    // '*' and '/' each optionally double up into a distinct two-character
    // operator ('**' pow, '//' floor-div — M1) — must be checked before
    // falling through to the generic single-character op case below.
    if (c === "*" || c === "/") {
      if (expression[i + 1] === c) {
        tokens.push({ kind: "op", value: (c + c) as "**" | "//" });
        i += 2;
      } else {
        tokens.push({ kind: "op", value: c });
        i++;
      }
      continue;
    }
    if (c === "+" || c === "-" || c === "%") {
      tokens.push({ kind: "op", value: c });
      i++;
      continue;
    }
    /* istanbul ignore next -- unreachable: every char already passed ALLOWED_CHAR above */
    throw new CalcError(`unexpected character '${c}'`);
  }
  return tokens;
}

// A Python-typed numeric value: `value` is the IEEE-754 double doing the
// actual math (JS has no separate int type), `isFloat` tracks which side of
// Python's int/float distinction this value is on — required because that
// distinction, not the numeric value itself, is what Python's str() and
// ZeroDivisionError wording key off of (H1/H2).
type PyNumber = { value: number; isFloat: boolean };

function checkFinite(n: PyNumber): PyNumber {
  if (!Number.isFinite(n.value)) {
    throw new CalcError("result is infinity or NaN");
  }
  return n;
}

const eitherFloat = (a: PyNumber, b: PyNumber): boolean => a.isFloat || b.isFloat;

function applyAdd(a: PyNumber, b: PyNumber): PyNumber {
  return checkFinite({ value: a.value + b.value, isFloat: eitherFloat(a, b) });
}

function applySub(a: PyNumber, b: PyNumber): PyNumber {
  return checkFinite({ value: a.value - b.value, isFloat: eitherFloat(a, b) });
}

function applyMul(a: PyNumber, b: PyNumber): PyNumber {
  return checkFinite({ value: a.value * b.value, isFloat: eitherFloat(a, b) });
}

// True division (Python's `/`, operator.truediv) ALWAYS returns a float,
// regardless of operand types (H2) — unlike + - * % //, there is no
// int-stays-int case. Zero-division wording is floatness-aware (H1) off the
// OPERANDS' floatness (the result is float either way): int/int -> plain
// "division by zero", either operand float -> "float division by zero".
function applyDiv(a: PyNumber, b: PyNumber): PyNumber {
  if (b.value === 0) {
    throw new CalcError(eitherFloat(a, b) ? "float division by zero" : "division by zero");
  }
  return checkFinite({ value: a.value / b.value, isFloat: true });
}

// Python's `%` (operator.mod) is FLOORED modulo: the result takes the
// divisor's sign, e.g. -7 % 2 === 1. JS's native `%` is truncated remainder
// (keeps the dividend's sign instead: -7 % 2 === -1) — a real semantic
// mismatch, not just a formatting one, found while verifying this
// operator's zero-division text against python3 and ported by hand via the
// floor-division identity `a == (a // b) * b + a % b` rather than JS's
// built-in operator. Zero-division wording: int/int -> "integer modulo by
// zero", either operand float -> "float modulo" (note: no "by zero" suffix
// on the float case — this asymmetry is really what CPython says, confirmed
// via `repr(str(e))`, not a typo).
function applyMod(a: PyNumber, b: PyNumber): PyNumber {
  if (b.value === 0) {
    throw new CalcError(eitherFloat(a, b) ? "float modulo" : "integer modulo by zero");
  }
  const value = a.value - Math.floor(a.value / b.value) * b.value;
  return checkFinite({ value, isFloat: eitherFloat(a, b) });
}

// Floor division (M1, Python's `//` / operator.floordiv): rounds toward
// negative infinity, not toward zero (-7 // 2 === -4, not -3 — Math.floor,
// not Math.trunc). Zero-division wording: int/int -> "integer division or
// modulo by zero", either operand float -> "float floor division by zero".
function applyFloorDiv(a: PyNumber, b: PyNumber): PyNumber {
  if (b.value === 0) {
    throw new CalcError(
      eitherFloat(a, b) ? "float floor division by zero" : "integer division or modulo by zero",
    );
  }
  return checkFinite({ value: Math.floor(a.value / b.value), isFloat: eitherFloat(a, b) });
}

// Power (M1, Python's `**` / operator.pow). Two rules beyond the usual
// float-contagion one, both confirmed via python3 rather than assumed:
//   - int ** int stays int ONLY when the exponent is >= 0; a negative
//     integer exponent still produces a float (2**-1 == 0.5) even though
//     neither operand is written as a float literal.
//   - 0 ** (negative exponent) is Python's ZeroDivisionError, not
//     Infinity/NaN — same wording ("0.0 cannot be raised to a negative
//     power") regardless of int/float typing on either operand.
function applyPow(a: PyNumber, b: PyNumber): PyNumber {
  if (a.value === 0 && b.value < 0) {
    throw new CalcError("0.0 cannot be raised to a negative power");
  }
  return checkFinite({ value: Math.pow(a.value, b.value), isFloat: eitherFloat(a, b) || b.value < 0 });
}

// Recursive-descent parser over the token stream. Grammar mirrors v1's
// actual Python operator precedence (CPython's own grammar terms: `term`,
// `factor`, `power`), not just its operator SET:
//   expression := term (('+' | '-') term)*
//   term       := factor (('*' | '/' | '%' | '//') factor)*
//   factor     := ('+' | '-') factor | power
//   power      := primary ('**' factor)?
//   primary    := NUMBER | '(' expression ')'
//
// The factor/power split (rather than a flat `unary := op unary | primary`)
// is what makes `-2**2 == -4` but `2**-2 == 0.25` both come out right from
// one grammar, matching CPython's own `factor: unary | power` / `power:
// primary ['**' factor]` split: `**`'s LEFT operand is a bare `primary` (a
// leading unary can never bind to it directly, so `-2**2` parses as
// `-(2**2)`), but its RIGHT operand is a `factor` (which allows ITS OWN
// leading unary, so `2**-2` parses as `2**(-2)`), and nesting `power` inside
// that `factor` is what makes `**` right-associative:
// `2**3**2 == 2**(3**2) == 512`. Every one of these was confirmed against a
// real `ast.dump()` / `python3 -c` round trip, not assumed from the
// operator table alone (see Task 3 fix report).
class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): PyNumber {
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

  private parseExpression(): PyNumber {
    let value = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && (t.value === "+" || t.value === "-")) {
        this.pos++;
        const rhs = this.parseTerm();
        value = t.value === "+" ? applyAdd(value, rhs) : applySub(value, rhs);
      } else {
        break;
      }
    }
    return value;
  }

  private parseTerm(): PyNumber {
    let value = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && (t.value === "*" || t.value === "/" || t.value === "%" || t.value === "//")) {
        this.pos++;
        const rhs = this.parseFactor();
        switch (t.value) {
          case "*":
            value = applyMul(value, rhs);
            break;
          case "/":
            value = applyDiv(value, rhs);
            break;
          case "%":
            value = applyMod(value, rhs);
            break;
          case "//":
            value = applyFloorDiv(value, rhs);
            break;
        }
      } else {
        break;
      }
    }
    return value;
  }

  private parseFactor(): PyNumber {
    const t = this.peek();
    if (t?.kind === "op" && (t.value === "+" || t.value === "-")) {
      this.pos++;
      const value = this.parseFactor();
      return t.value === "-" ? { value: -value.value, isFloat: value.isFloat } : value;
    }
    return this.parsePower();
  }

  private parsePower(): PyNumber {
    const base = this.parsePrimary();
    const t = this.peek();
    if (t?.kind === "op" && t.value === "**") {
      this.pos++;
      // Right-hand side is a `factor`, not another `power` — see the
      // grammar note above the class: this is both what allows a leading
      // unary directly after '**' (2**-2) and, by nesting power inside
      // factor, what makes '**' right-associative (2**3**2 == 2**(3**2)).
      const exponent = this.parseFactor();
      return applyPow(base, exponent);
    }
    return base;
  }

  private parsePrimary(): PyNumber {
    const t = this.peek();
    if (!t) {
      throw new CalcError("unexpected end of expression");
    }
    if (t.kind === "num") {
      this.pos++;
      return { value: t.value, isFloat: t.isFloat };
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

function evaluate(expression: string): PyNumber {
  const tokens = tokenize(expression);
  return new Parser(tokens).parse();
}

// Formats a PyNumber exactly like Python's str() would (H2).
function formatResult(n: PyNumber): string {
  if (!n.isFloat) {
    // Python int -> str is exact-precision base-10 digits (arbitrary-
    // precision bignum). JS numbers are IEEE-754 doubles: this matches for
    // every value reachable within double's safe range; a result whose true
    // (Python bignum) magnitude would need more precision than a double
    // carries, or exceeds ~1e21 (where JS's own Number#toString switches to
    // exponential notation while Python ints never do), is a residual
    // divergence accepted per the fix brief rather than reimplementing
    // bignum arithmetic — v1 itself only ever bounds *digit count* for
    // display (MAX_RESULT_DIGITS), it doesn't chase exact string fidelity
    // either, and that bound was already deliberately not ported (Task 3
    // report: not reachable from this narrowed grammar).
    return String(n.value);
  }
  if (Object.is(n.value, -0)) {
    // JS's String(-0) === "0" silently drops the sign; Python's
    // str(-0.0) === "-0.0" keeps it. Reachable directly from this grammar
    // (e.g. "0/-1"), and cheap to special-case exactly — unlike the
    // magnitude divergence below, this one IS fixed rather than just noted.
    return "-0.0";
  }
  const s = String(n.value);
  if (s.includes(".") || s.includes("e") || s.includes("E")) {
    // Non-integer-valued floats: both V8 and CPython implement the same
    // shortest-round-trip decimal algorithm for doubles, so this already
    // matches Python's repr for values in the "normal" magnitude range
    // (confirmed for every value this task's goldens produce, e.g.
    // 2**0.5 -> "1.4142135623730951", byte-identical in both). Known,
    // deliberately-unchased divergence at the extremes (per the fix brief:
    // note, don't chase): Python's float repr switches to scientific
    // notation around 1e16/1e-5 (str(1e16) === "1e+16") while JS's
    // Number#toString only does so around 1e21/1e-7
    // (String(1e16) === "10000000000000000"), and even when both use
    // scientific notation the exponent text itself differs (Python
    // zero-pads to >=2 digits and always signs it, "1e-07"; JS prints
    // "1e-7"). Verified via `python3 -c` + `node -e` side-by-side, not
    // assumed — see Task 3 fix report.
    return s;
  }
  return `${s}.0`;
}

async function execute(input: Static<typeof CalculatorParams>): Promise<string> {
  try {
    const result = evaluate(input.expression);
    return formatResult(result);
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
  description:
    "Evaluate a basic arithmetic expression (numbers, +, -, *, /, %, **, //, parentheses) and return the result.",
  schema: CalculatorParams,
  execute,
};

registerTool(calculatorTool);
