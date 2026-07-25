import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv";
import { buildPreview, coerceCell, importableColumns, inferType } from "./csvImport";
import type { DbSchema } from "./db";

describe("parseCsv — RFC 4180", () => {
  it("parses a simple grid", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with commas, quotes and newlines", () => {
    const text = 'name,note\n"Doe, John","a ""quoted"" line\nsecond"';
    expect(parseCsv(text)).toEqual([
      ["name", "note"],
      ["Doe, John", 'a "quoted" line\nsecond'],
    ]);
  });

  it("accepts CRLF and a trailing newline, strips a BOM", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty cells", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });
});

describe("inferType", () => {
  it("detects numbers, dates, booleans", () => {
    expect(inferType(["1", "2", "3.5"])).toBe("number");
    expect(inferType(["2026-01-01", "2026-07-19"])).toBe("date");
    expect(inferType(["oui", "non", "oui"])).toBe("checkbox");
  });

  it("detects email and url", () => {
    expect(inferType(["a@b.com", "c@d.org"])).toBe("email");
    expect(inferType(["https://a.com", "https://b.io/x"])).toBe("url");
  });

  it("detects categorical select and multiselect", () => {
    expect(inferType(["A", "B", "A", "B", "A", "B"])).toBe("select");
    expect(inferType(["x, y", "y, z", "x"])).toBe("multiselect");
  });

  it("falls back to text and empty → text", () => {
    expect(inferType(["free form", "another sentence entirely", "third"])).toBe("text");
    expect(inferType(["", "", ""])).toBe("text");
  });
});

describe("coerceCell", () => {
  it("coerces numbers (comma decimal) and empties", () => {
    expect(coerceCell("number", "3,5")).toBe(3.5);
    expect(coerceCell("number", "")).toBeUndefined();
    expect(coerceCell("number", "n/a")).toBeUndefined();
  });

  it("coerces checkbox tokens", () => {
    expect(coerceCell("checkbox", "oui")).toBe(true);
    expect(coerceCell("checkbox", "non")).toBe(false);
    expect(coerceCell("checkbox", "")).toBeUndefined();
  });

  it("coerces a date range into {start,end}, bare start otherwise", () => {
    expect(coerceCell("date", "2026-01-01 → 2026-01-05")).toEqual({
      start: "2026-01-01",
      end: "2026-01-05",
    });
    expect(coerceCell("date", "2026-01-01")).toBe("2026-01-01");
  });

  it("coerces multiselect into a trimmed array", () => {
    expect(coerceCell("multiselect", "a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("returns undefined for non-importable types", () => {
    expect(coerceCell("relation", "x")).toBeUndefined();
    expect(coerceCell("formula", "1+1")).toBeUndefined();
  });
});

describe("buildPreview — auto mapping", () => {
  const schema: DbSchema = {
    columns: [
      { id: "c1", name: "Priorité", type: "select" },
      { id: "c2", name: "Fait", type: "checkbox" },
    ],
    views: [{ id: "table", name: "Table", type: "table" }],
  };

  it("maps the first column to the title, matches existing by name, infers the rest", () => {
    const csv = "Nom,Priorité,Fait,Score\nTask A,High,oui,5\nTask B,Low,non,3";
    const p = buildPreview(csv, schema);
    expect(p.headers).toEqual(["Nom", "Priorité", "Fait", "Score"]);
    expect(p.rows).toHaveLength(2);
    expect(p.mappings[0]).toEqual({ kind: "title" });
    expect(p.mappings[1]).toEqual({ kind: "existing", columnId: "c1" });
    expect(p.mappings[2]).toEqual({ kind: "existing", columnId: "c2" });
    expect(p.mappings[3]).toEqual({ kind: "new", name: "Score", type: "number" });
  });

  it("maps a header to an existing relation column (re-linked on apply)", () => {
    const s: DbSchema = {
      columns: [{ id: "rel", name: "Personne", type: "relation", relationDb: "db2" }],
      views: [{ id: "table", name: "Table", type: "table" }],
    };
    const p = buildPreview("Nom,Personne\nA,Neo\nB,Trinity", s);
    expect(p.mappings[0]).toEqual({ kind: "title" });
    expect(p.mappings[1]).toEqual({ kind: "existing", columnId: "rel" });
  });

  it("ignores headers matching a non-importable existing column (formula/files)", () => {
    const s: DbSchema = {
      columns: [{ id: "f", name: "Calc", type: "formula" }],
      views: [{ id: "table", name: "Table", type: "table" }],
    };
    const p = buildPreview("Nom,Calc\nA,3\nB,5", s);
    expect(p.mappings[1]).toEqual({ kind: "ignore" });
  });

  it("drops blank data rows", () => {
    const p = buildPreview("Nom\nA\n\nB\n", schema);
    expect(p.rows).toEqual([["A"], ["B"]]);
  });

  it("importableColumns excludes computed/meta/files but keeps relation", () => {
    const s: DbSchema = {
      columns: [
        { id: "a", name: "T", type: "text" },
        { id: "b", name: "F", type: "formula" },
        { id: "c", name: "R", type: "relation" },
        { id: "d", name: "When", type: "created_time" },
        { id: "e", name: "Docs", type: "files" },
      ],
      views: [],
    };
    expect(importableColumns(s).map((c) => c.id)).toEqual(["a", "c"]);
  });
});
