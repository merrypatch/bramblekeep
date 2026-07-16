//! Formula engine (`formula` column): lexer → parser → evaluator, pure and
//! dependency-free. Column refs via `prop("Name")`. Dynamic types
//! (number | string | boolean | Date | null). Client-side, evaluated per row.

import i18n from "@/i18n";
import { formatDate } from "@/lib/locale";

export type FormulaValue = number | string | boolean | Date | null;

export class FormulaError extends Error {}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Tok =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "ident"; v: string }
  | { k: "op"; v: string }
  | { k: "punct"; v: string }
  | { k: "eof" };

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "^", "<", ">", "!"];

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let s = "";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < n) {
          i++;
          s += src[i];
        } else s += src[i];
        i++;
      }
      if (i >= n) throw new FormulaError(i18n.t("formula.err.unterminatedString"));
      i++; // closes the quote
      toks.push({ k: "str", v: s });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let num = "";
      while (i < n && /[0-9.]/.test(src[i])) num += src[i++];
      const v = Number(num);
      if (Number.isNaN(v)) throw new FormulaError(i18n.t("formula.err.invalidNumber", { value: num }));
      toks.push({ k: "num", v });
      continue;
    }
    if (/[A-Za-zÀ-ÿ_]/.test(c)) {
      let id = "";
      while (i < n && /[A-Za-zÀ-ÿ0-9_]/.test(src[i])) id += src[i++];
      toks.push({ k: "ident", v: id });
      continue;
    }
    if (c === "(" || c === ")" || c === ",") {
      toks.push({ k: "punct", v: c });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      toks.push({ k: "op", v: op });
      i += op.length;
      continue;
    }
    throw new FormulaError(i18n.t("formula.err.unexpectedChar", { char: c }));
  }
  toks.push({ k: "eof" });
  return toks;
}

// ---------------------------------------------------------------------------
// AST + Parser (recursive descent by precedence)
// ---------------------------------------------------------------------------

type Node =
  | { t: "lit"; v: FormulaValue }
  | { t: "un"; op: string; e: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "call"; name: string; args: Node[] };

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}
  private peek(): Tok {
    return this.toks[this.p];
  }
  private next(): Tok {
    return this.toks[this.p++];
  }
  private eatOp(v: string): boolean {
    const t = this.peek();
    if (t.k === "op" && t.v === v) {
      this.p++;
      return true;
    }
    return false;
  }
  private eatIdent(v: string): boolean {
    const t = this.peek();
    if (t.k === "ident" && t.v.toLowerCase() === v) {
      this.p++;
      return true;
    }
    return false;
  }

  parse(): Node {
    const e = this.expr();
    if (this.peek().k !== "eof") throw new FormulaError(i18n.t("formula.err.malformed"));
    return e;
  }
  private expr(): Node {
    return this.or();
  }
  private or(): Node {
    let a = this.and();
    while (this.eatOp("||") || this.eatIdent("or")) a = { t: "bin", op: "or", a, b: this.and() };
    return a;
  }
  private and(): Node {
    let a = this.cmp();
    while (this.eatOp("&&") || this.eatIdent("and")) a = { t: "bin", op: "and", a, b: this.cmp() };
    return a;
  }
  private cmp(): Node {
    let a = this.add();
    for (;;) {
      const op = ["==", "!=", "<=", ">=", "<", ">"].find((o) => this.eatOp(o));
      if (!op) break;
      a = { t: "bin", op, a, b: this.add() };
    }
    return a;
  }
  private add(): Node {
    let a = this.mul();
    for (;;) {
      if (this.eatOp("+")) a = { t: "bin", op: "+", a, b: this.mul() };
      else if (this.eatOp("-")) a = { t: "bin", op: "-", a, b: this.mul() };
      else break;
    }
    return a;
  }
  private mul(): Node {
    let a = this.unary();
    for (;;) {
      const op = ["*", "/", "%"].find((o) => this.eatOp(o));
      if (!op) break;
      a = { t: "bin", op, a, b: this.unary() };
    }
    return a;
  }
  private unary(): Node {
    if (this.eatOp("-")) return { t: "un", op: "-", e: this.unary() };
    if (this.eatOp("!") || this.eatIdent("not")) return { t: "un", op: "not", e: this.unary() };
    return this.pow();
  }
  private pow(): Node {
    const a = this.primary();
    if (this.eatOp("^")) return { t: "bin", op: "^", a, b: this.unary() }; // ^ right-associative
    return a;
  }
  private primary(): Node {
    const t = this.next();
    if (t.k === "num") return { t: "lit", v: t.v };
    if (t.k === "str") return { t: "lit", v: t.v };
    if (t.k === "punct" && t.v === "(") {
      const e = this.expr();
      const close = this.next();
      if (!(close.k === "punct" && close.v === ")")) throw new FormulaError(i18n.t("formula.err.missingCloseParen"));
      return e;
    }
    if (t.k === "ident") {
      const low = t.v.toLowerCase();
      if (low === "true") return { t: "lit", v: true };
      if (low === "false") return { t: "lit", v: false };
      if (low === "null" || low === "empty") return { t: "lit", v: null };
      // Function call: ident followed by "(".
      const nx = this.peek();
      if (nx.k === "punct" && nx.v === "(") {
        this.p++;
        const args: Node[] = [];
        if (!(this.peek().k === "punct" && (this.peek() as { v: string }).v === ")")) {
          args.push(this.expr());
          while (this.peek().k === "punct" && (this.peek() as { v: string }).v === ",") {
            this.p++;
            args.push(this.expr());
          }
        }
        const close = this.next();
        if (!(close.k === "punct" && close.v === ")")) throw new FormulaError(i18n.t("formula.err.missingCloseParen"));
        return { t: "call", name: low, args };
      }
      throw new FormulaError(i18n.t("formula.err.bareIdentifier", { name: t.v }));
    }
    throw new FormulaError(i18n.t("formula.err.expected"));
  }
}

/** Parses a formula → AST. Throws `FormulaError` on invalid syntax. */
export function parseFormula(src: string): Node {
  return new Parser(lex(src)).parse();
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/** Evaluation context: resolves `prop("Name")` to the row's typed value. */
export type FormulaCtx = { resolve: (name: string) => FormulaValue };

const isDate = (v: FormulaValue): v is Date => v instanceof Date;

function toNum(v: FormulaValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isDate(v)) return v.getTime();
  if (v == null || v === "") return 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new FormulaError(i18n.t("formula.err.notANumber", { value: String(v) }));
  return n;
}
function toStr(v: FormulaValue): string {
  if (v == null) return "";
  if (isDate(v)) return v.toISOString().slice(0, 10);
  return String(v);
}
function truthy(v: FormulaValue): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  if (isDate(v)) return true;
  return false;
}
function eq(a: FormulaValue, b: FormulaValue): boolean {
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  if (typeof a === "number" || typeof b === "number") return toNum(a) === toNum(b);
  if (typeof a === "boolean" || typeof b === "boolean") return truthy(a) === truthy(b);
  return toStr(a) === toStr(b);
}
function cmp(a: FormulaValue, b: FormulaValue): number {
  if (isDate(a) && isDate(b)) return a.getTime() - b.getTime();
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  return toNum(a) - toNum(b);
}
const round = (n: number, d = 0) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

type Fn = (args: FormulaValue[]) => FormulaValue;
const FUNCS: Record<string, Fn> = {
  if: (a) => (truthy(a[0]) ? (a[1] ?? null) : (a[2] ?? null)),
  and: (a) => a.every(truthy),
  or: (a) => a.some(truthy),
  not: (a) => !truthy(a[0]),
  abs: (a) => Math.abs(toNum(a[0])),
  round: (a) => round(toNum(a[0]), a[1] == null ? 0 : toNum(a[1])),
  floor: (a) => Math.floor(toNum(a[0])),
  ceil: (a) => Math.ceil(toNum(a[0])),
  sqrt: (a) => Math.sqrt(toNum(a[0])),
  pow: (a) => toNum(a[0]) ** toNum(a[1]),
  min: (a) => Math.min(...a.map(toNum)),
  max: (a) => Math.max(...a.map(toNum)),
  sum: (a) => a.reduce((s: number, v) => s + toNum(v), 0),
  concat: (a) => a.map(toStr).join(""),
  len: (a) => toStr(a[0]).length,
  upper: (a) => toStr(a[0]).toUpperCase(),
  lower: (a) => toStr(a[0]).toLowerCase(),
  trim: (a) => toStr(a[0]).trim(),
  contains: (a) => toStr(a[0]).includes(toStr(a[1])),
  replace: (a) => toStr(a[0]).split(toStr(a[1])).join(toStr(a[2])),
  substring: (a) => toStr(a[0]).substring(toNum(a[1]), a[2] == null ? undefined : toNum(a[1]) + toNum(a[2])),
  number: (a) => toNum(a[0]),
  text: (a) => toStr(a[0]),
  empty: (a) => a[0] == null || a[0] === "",
  now: () => new Date(),
  year: (a) => asDate(a[0]).getFullYear(),
  month: (a) => asDate(a[0]).getMonth() + 1,
  day: (a) => asDate(a[0]).getDate(),
  datebetween: (a) => {
    const ms = asDate(a[1]).getTime() - asDate(a[0]).getTime();
    const unit = toStr(a[2] ?? "days").toLowerCase();
    const div = unit.startsWith("hour") ? 3_600_000 : unit.startsWith("min") ? 60_000 : 86_400_000;
    return Math.round(ms / div);
  },
};

function asDate(v: FormulaValue): Date {
  if (isDate(v)) return v;
  if (typeof v === "string" && v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new FormulaError(i18n.t("formula.err.dateExpected"));
}

function evalNode(node: Node, ctx: FormulaCtx): FormulaValue {
  switch (node.t) {
    case "lit":
      return node.v;
    case "un":
      return node.op === "-" ? -toNum(evalNode(node.e, ctx)) : !truthy(evalNode(node.e, ctx));
    case "bin": {
      const { op } = node;
      if (op === "and") return truthy(evalNode(node.a, ctx)) && truthy(evalNode(node.b, ctx));
      if (op === "or") return truthy(evalNode(node.a, ctx)) || truthy(evalNode(node.b, ctx));
      const a = evalNode(node.a, ctx);
      const b = evalNode(node.b, ctx);
      switch (op) {
        case "+":
          return toNum(a) + toNum(b);
        case "-":
          return toNum(a) - toNum(b);
        case "*":
          return toNum(a) * toNum(b);
        case "/": {
          const d = toNum(b);
          if (d === 0) throw new FormulaError(i18n.t("formula.err.divByZero"));
          return toNum(a) / d;
        }
        case "%":
          return toNum(a) % toNum(b);
        case "^":
          return toNum(a) ** toNum(b);
        case "==":
          return eq(a, b);
        case "!=":
          return !eq(a, b);
        case "<":
          return cmp(a, b) < 0;
        case "<=":
          return cmp(a, b) <= 0;
        case ">":
          return cmp(a, b) > 0;
        case ">=":
          return cmp(a, b) >= 0;
      }
      throw new FormulaError(i18n.t("formula.err.unknownOperator", { op }));
    }
    case "call": {
      if (node.name === "prop") {
        const arg = evalNode(node.args[0], ctx);
        return ctx.resolve(toStr(arg));
      }
      const fn = FUNCS[node.name];
      if (!fn) throw new FormulaError(i18n.t("formula.err.unknownFunction", { name: node.name }));
      return fn(node.args.map((a) => evalNode(a, ctx)));
    }
  }
}

/** Evaluates an already-parsed AST. Throws `FormulaError` on runtime error. */
export function evalFormula(ast: Node, ctx: FormulaCtx): FormulaValue {
  return evalNode(ast, ctx);
}

/** Parse + evaluate (handy for tests / one-off use). */
export function runFormula(src: string, ctx: FormulaCtx): FormulaValue {
  return evalNode(parseFormula(src), ctx);
}

/** Function catalog (input help). Descriptions and group labels are localized at
 * display via `formula.fn.<name>` / `formula.group.<group>`. `sig` is a canonical
 * English signature hint; `example`/`snippet` are literal code inserted as-is. */
export type FormulaGroup = "logic" | "numbers" | "text" | "dates";
export type FormulaFn = {
  name: string;
  sig: string;
  example: string;
  snippet: string;
  group: FormulaGroup;
};

export const FORMULA_FUNCS: FormulaFn[] = [
  { name: "if", sig: "if(condition, if_true, if_false)", example: 'if(prop("Score") >= 10, "Pass", "Fail")', snippet: "if(, , )", group: "logic" },
  { name: "and", sig: "and(a, b, …)", example: 'and(prop("Paid"), prop("Shipped"))', snippet: "and(, )", group: "logic" },
  { name: "or", sig: "or(a, b, …)", example: 'or(prop("Urgent"), prop("Important"))', snippet: "or(, )", group: "logic" },
  { name: "not", sig: "not(x)", example: 'not(prop("Done"))', snippet: "not()", group: "logic" },
  { name: "empty", sig: "empty(x)", example: 'empty(prop("Notes"))', snippet: "empty()", group: "logic" },
  { name: "round", sig: "round(number, [decimals])", example: 'round(prop("Price") * 1.2, 2)', snippet: "round(, 2)", group: "numbers" },
  { name: "abs", sig: "abs(number)", example: 'abs(prop("Delta"))', snippet: "abs()", group: "numbers" },
  { name: "floor", sig: "floor(number)", example: "floor(3.9)", snippet: "floor()", group: "numbers" },
  { name: "ceil", sig: "ceil(number)", example: "ceil(3.1)", snippet: "ceil()", group: "numbers" },
  { name: "sqrt", sig: "sqrt(number)", example: "sqrt(16)", snippet: "sqrt()", group: "numbers" },
  { name: "pow", sig: "pow(base, exponent)", example: "pow(2, 10)", snippet: "pow(, )", group: "numbers" },
  { name: "min", sig: "min(a, b, …)", example: 'min(prop("A"), prop("B"))', snippet: "min(, )", group: "numbers" },
  { name: "max", sig: "max(a, b, …)", example: 'max(prop("A"), prop("B"))', snippet: "max(, )", group: "numbers" },
  { name: "sum", sig: "sum(a, b, …)", example: 'sum(prop("T1"), prop("T2"))', snippet: "sum(, )", group: "numbers" },
  { name: "number", sig: "number(x)", example: 'number(prop("Text"))', snippet: "number()", group: "numbers" },
  { name: "concat", sig: "concat(a, b, …)", example: 'concat(prop("First"), " ", prop("Last"))', snippet: "concat(, )", group: "text" },
  { name: "text", sig: "text(x)", example: 'text(prop("Number"))', snippet: "text()", group: "text" },
  { name: "len", sig: "len(text)", example: 'len(prop("Title"))', snippet: "len()", group: "text" },
  { name: "upper", sig: "upper(text)", example: 'upper(prop("Code"))', snippet: "upper()", group: "text" },
  { name: "lower", sig: "lower(text)", example: 'lower(prop("Email"))', snippet: "lower()", group: "text" },
  { name: "trim", sig: "trim(text)", example: 'trim(prop("Input"))', snippet: "trim()", group: "text" },
  { name: "contains", sig: "contains(text, substring)", example: 'contains(prop("Tags"), "urgent")', snippet: "contains(, )", group: "text" },
  { name: "replace", sig: "replace(text, search, replacement)", example: 'replace(prop("Phone"), " ", "")', snippet: "replace(, , )", group: "text" },
  { name: "substring", sig: "substring(text, start, [length])", example: 'substring(prop("Code"), 0, 3)', snippet: "substring(, 0, 3)", group: "text" },
  { name: "now", sig: "now()", example: "now()", snippet: "now()", group: "dates" },
  { name: "year", sig: "year(date)", example: 'year(prop("Due"))', snippet: "year()", group: "dates" },
  { name: "month", sig: "month(date)", example: 'month(prop("Due"))', snippet: "month()", group: "dates" },
  { name: "day", sig: "day(date)", example: 'day(prop("Due"))', snippet: "day()", group: "dates" },
  { name: "dateBetween", sig: 'dateBetween(a, b, "days"|"hours"|"minutes")', example: 'dateBetween(prop("Start"), now(), "days")', snippet: 'dateBetween(, now(), "days")', group: "dates" },
];

/** Display rendering of a formula value. */
export function formatFormulaValue(v: FormulaValue): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? i18n.t("formula.value.yes") : i18n.t("formula.value.no");
  if (isDate(v)) return formatDate(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(round(v, 4));
  return v;
}
