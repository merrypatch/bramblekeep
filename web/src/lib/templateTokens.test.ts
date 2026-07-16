import { describe, expect, it } from "vitest";

import { isoDay, resolveTokens, type TokenCtx } from "./templateTokens";
import { formatDate } from "./locale";

const ctx: TokenCtx = { now: new Date(2026, 6, 10, 14, 30), seq: 42, user: "Robin" };

describe("resolveTokens", () => {
  it("date / time", () => {
    // Date/time tokens are locale-formatted; assert delegation to the shared
    // formatter (locale-independent of CI) rather than a hardcoded format.
    expect(resolveTokens("le {{date}}", ctx)).toBe(`le ${formatDate(ctx.now)}`);
    expect(resolveTokens("{{year}}-{{month}}-{{day}}", ctx)).toBe("2026-07-10");
    expect(resolveTokens("{{time}}", ctx)).toBe(
      formatDate(ctx.now, { hour: "2-digit", minute: "2-digit" }),
    );
  });
  it("sequence number and padding", () => {
    expect(resolveTokens("#{{n}}", ctx)).toBe("#42");
    expect(resolveTokens("{{n:5}}", ctx)).toBe("00042");
    expect(resolveTokens("{{id:3}}", ctx)).toBe("042");
  });
  it("user", () => {
    expect(resolveTokens("par {{user}}", ctx)).toBe("par Robin");
  });
  it("unknown token left as-is", () => {
    expect(resolveTokens("{{wat}}", ctx)).toBe("{{wat}}");
  });
  it("combination", () => {
    expect(resolveTokens("{{date}} - {{id:3}}", ctx)).toBe(`${formatDate(ctx.now)} - 042`);
  });
  it("isoDay", () => {
    expect(isoDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
