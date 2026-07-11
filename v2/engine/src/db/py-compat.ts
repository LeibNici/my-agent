// 字符串转义：JSON.stringify 对控制字符/引号/反斜杠的转义与 Python json 一致，
// 非 ASCII 两边都原样保留（ensure_ascii=False ↔ JS 默认），可直接委托。
function pyStr(s: string): string { return JSON.stringify(s); }

export function pythonJsonDumps(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return pyStr(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number cannot be stored");
    return String(value);
  }
  if (Array.isArray(value)) return "[" + value.map(pythonJsonDumps).join(", ") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => pyStr(k) + ": " + pythonJsonDumps(v));
    return "{" + entries.join(", ") + "}";
  }
  throw new Error(`unserializable value of type ${typeof value}`);
}

export function pyLocalIsoNow(now: Date = new Date()): string {
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1, 2)}-${p(now.getDate(), 2)}` +
    `T${p(now.getHours(), 2)}:${p(now.getMinutes(), 2)}:${p(now.getSeconds(), 2)}` +
    `.${p(now.getMilliseconds(), 3)}000`;
}
