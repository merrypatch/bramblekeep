import { describe, expect, it } from "vitest";

import { type FormulaValue, FormulaError, formatFormulaValue, runFormula } from "./formula";

/** Test context: a few fixed columns. */
const ctx = (vals: Record<string, FormulaValue> = {}) => ({
  resolve: (name: string) => (name in vals ? vals[name] : null),
});

describe("formula — arithmetic & precedence", () => {
  it("respects precedence", () => {
    expect(runFormula("2 + 3 * 4", ctx())).toBe(14);
    expect(runFormula("(2 + 3) * 4", ctx())).toBe(20);
    expect(runFormula("2 ^ 3 ^ 2", ctx())).toBe(512); // ^ right-associative
    expect(runFormula("-2 + 3", ctx())).toBe(1);
    expect(runFormula("10 % 3", ctx())).toBe(1);
  });
  it("division by zero → error", () => {
    expect(() => runFormula("1 / 0", ctx())).toThrow(FormulaError);
  });
});

describe("formula — prop & types", () => {
  it("resolves prop() and computes", () => {
    expect(runFormula('prop("Nombre") * 2', ctx({ Nombre: 5 }))).toBe(10);
  });
  it("missing prop → null → 0 in arithmetic", () => {
    expect(runFormula('prop("X") + 1', ctx())).toBe(1);
  });
  it("comparisons and booleans", () => {
    expect(runFormula('prop("n") >= 10', ctx({ n: 10 }))).toBe(true);
    expect(runFormula('prop("s") == "ok"', ctx({ s: "ok" }))).toBe(true);
  });
});

describe("formula — functions", () => {
  it("if / and / or / not", () => {
    expect(runFormula('if(prop("done"), "OK", "KO")', ctx({ done: true }))).toBe("OK");
    expect(runFormula("and(true, false)", ctx())).toBe(false);
    expect(runFormula("or(false, 1)", ctx())).toBe(true);
    expect(runFormula("not(false)", ctx())).toBe(true);
  });
  it("math", () => {
    expect(runFormula("round(3.14159, 2)", ctx())).toBe(3.14);
    expect(runFormula("min(3, 1, 2)", ctx())).toBe(1);
    expect(runFormula("max(3, 1, 2)", ctx())).toBe(3);
    expect(runFormula("abs(-5)", ctx())).toBe(5);
    expect(runFormula("sum(1, 2, 3)", ctx())).toBe(6);
  });
  it("strings", () => {
    expect(runFormula('concat(prop("a"), " ", prop("b"))', ctx({ a: "x", b: "y" }))).toBe("x y");
    expect(runFormula('upper("abc")', ctx())).toBe("ABC");
    expect(runFormula('contains("hello", "ell")', ctx())).toBe(true);
    expect(runFormula('replace("a-b-c", "-", "+")', ctx())).toBe("a+b+c");
  });
});

describe("formula — syntax errors", () => {
  it("bare identifier → prop() help message", () => {
    expect(() => runFormula("Nombre * 2", ctx())).toThrow(/prop\("Nombre"\)/);
  });
  it("missing parenthesis", () => {
    expect(() => runFormula("(1 + 2", ctx())).toThrow(FormulaError);
  });
  it("unknown function", () => {
    expect(() => runFormula("foo(1)", ctx())).toThrow(/foo/);
  });
});

describe("formatFormulaValue", () => {
  it("formats according to type", () => {
    expect(formatFormulaValue(3)).toBe("3");
    expect(formatFormulaValue(3.14159)).toBe("3.1416");
    expect(formatFormulaValue(true)).toBe("Yes");
    expect(formatFormulaValue(null)).toBe("");
    expect(formatFormulaValue("x")).toBe("x");
  });
});
