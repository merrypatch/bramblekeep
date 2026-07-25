import { describe, expect, it } from "vitest";

import type { FilterGroup, Row } from "./db";
import { migrateFilters } from "./db";
import {
  compileFilters,
  defaultOperator,
  filterRows,
  type HostContext,
  operatorHasValue,
  operatorsForType,
  resolveFilters,
} from "./filter";

function row(id: string, title: string | null, props: Record<string, unknown> = {}): Row {
  return { id, title, icon: null, cover: null, props };
}

const rows: Row[] = [
  row("1", "Alice", { age: 30, tags: ["a", "b"], status: "open", done: true, due: "2026-01-10" }),
  row("2", "Bob", { age: 40, tags: ["b"], status: "closed", done: false, due: "2026-03-20" }),
  row("3", "Carol", { age: 20, tags: [], status: "open", done: false, due: null }),
  row("4", "dave", { age: null, tags: ["c"], status: "open", done: true }),
];

/** Runs a single view-level group against the fixture rows, returns matched titles. */
function run(group: FilterGroup): (string | null)[] {
  return filterRows(rows, undefined, group).map((r) => r.title);
}

function g(op: "and" | "or", conditions: FilterGroup["conditions"]): FilterGroup {
  return { id: "g", op, conditions };
}

describe("filter — text operators", () => {
  it("contains (substring, case-insensitive)", () => {
    expect(run(g("and", [{ id: "c", columnId: "__title", operator: "contains", value: "a" }]))).toEqual([
      "Alice",
      "Carol",
      "dave",
    ]);
  });
  it("is / is_not (exact, case-insensitive)", () => {
    expect(run(g("and", [{ id: "c", columnId: "__title", operator: "is", value: "bob" }]))).toEqual(["Bob"]);
    expect(run(g("and", [{ id: "c", columnId: "__title", operator: "is_not", value: "bob" }]))).toEqual([
      "Alice",
      "Carol",
      "dave",
    ]);
  });
  it("starts_with / ends_with", () => {
    expect(run(g("and", [{ id: "c", columnId: "__title", operator: "starts_with", value: "da" }]))).toEqual(["dave"]);
    expect(run(g("and", [{ id: "c", columnId: "__title", operator: "ends_with", value: "e" }]))).toEqual([
      "Alice",
      "dave",
    ]);
  });
});

describe("filter — number operators", () => {
  it("gt / lt / gte / lte / eq / neq", () => {
    expect(run(g("and", [{ id: "c", columnId: "age", operator: "gt", value: 25 }]))).toEqual(["Alice", "Bob"]);
    expect(run(g("and", [{ id: "c", columnId: "age", operator: "lte", value: 20 }]))).toEqual(["Carol"]);
    expect(run(g("and", [{ id: "c", columnId: "age", operator: "eq", value: 40 }]))).toEqual(["Bob"]);
    // neq matches empty too (null age → not equal to 40)
    expect(run(g("and", [{ id: "c", columnId: "age", operator: "neq", value: 40 }]))).toEqual([
      "Alice",
      "Carol",
      "dave",
    ]);
  });
});

describe("filter — select / multiselect membership", () => {
  it("select is", () => {
    expect(run(g("and", [{ id: "c", columnId: "status", operator: "is", value: "open" }]))).toEqual([
      "Alice",
      "Carol",
      "dave",
    ]);
  });
  it("multiselect contains (exact membership)", () => {
    expect(run(g("and", [{ id: "c", columnId: "tags", operator: "contains", value: "b" }]))).toEqual(["Alice", "Bob"]);
  });
  it("any_of (set intersection)", () => {
    expect(run(g("and", [{ id: "c", columnId: "tags", operator: "any_of", value: ["a", "c"] }]))).toEqual([
      "Alice",
      "dave",
    ]);
  });
});

describe("filter — checkbox / empty / date", () => {
  it("checkbox checked / unchecked", () => {
    expect(run(g("and", [{ id: "c", columnId: "done", operator: "is_checked" }]))).toEqual(["Alice", "dave"]);
    expect(run(g("and", [{ id: "c", columnId: "done", operator: "is_unchecked" }]))).toEqual(["Bob", "Carol"]);
  });
  it("is_empty / is_not_empty (arrays + dates)", () => {
    expect(run(g("and", [{ id: "c", columnId: "tags", operator: "is_empty" }]))).toEqual(["Carol"]);
    expect(run(g("and", [{ id: "c", columnId: "due", operator: "is_empty" }]))).toEqual(["Carol", "dave"]);
    expect(run(g("and", [{ id: "c", columnId: "due", operator: "is_not_empty" }]))).toEqual(["Alice", "Bob"]);
  });
  it("date before / after / on_or", () => {
    expect(run(g("and", [{ id: "c", columnId: "due", operator: "date_before", value: "2026-02-01" }]))).toEqual([
      "Alice",
    ]);
    expect(run(g("and", [{ id: "c", columnId: "due", operator: "date_on_after", value: "2026-01-10" }]))).toEqual([
      "Alice",
      "Bob",
    ]);
  });
});

describe("filter — boolean composition", () => {
  it("AND of two conditions", () => {
    expect(
      run(
        g("and", [
          { id: "c1", columnId: "status", operator: "is", value: "open" },
          { id: "c2", columnId: "age", operator: "gt", value: 25 },
        ]),
      ),
    ).toEqual(["Alice"]);
  });
  it("OR of two conditions", () => {
    expect(
      run(
        g("or", [
          { id: "c1", columnId: "age", operator: "eq", value: 40 },
          { id: "c2", columnId: "__title", operator: "is", value: "carol" },
        ]),
      ),
    ).toEqual(["Bob", "Carol"]);
  });
  it("nested group: A AND (B OR C)", () => {
    expect(
      run(
        g("and", [
          { id: "c1", columnId: "status", operator: "is", value: "open" },
          g("or", [
            { id: "c2", columnId: "age", operator: "lt", value: 25 },
            { id: "c3", columnId: "done", operator: "is_checked" },
          ]),
        ]),
      ),
    ).toEqual(["Alice", "Carol", "dave"]);
  });
  it("empty group matches all", () => {
    expect(run(g("and", []))).toEqual(["Alice", "Bob", "Carol", "dave"]);
  });
});

describe("filter — db-level + view-level combine with AND", () => {
  it("intersects both filters", () => {
    const dbFilter = g("and", [{ id: "d", columnId: "status", operator: "is", value: "open" }]);
    const viewFilter = g("and", [{ id: "v", columnId: "done", operator: "is_checked" }]);
    const pred = compileFilters(dbFilter, viewFilter);
    expect(rows.filter((r) => pred(r, (row, c) => (c === "__title" ? row.title : row.props[c]))).map((r) => r.title)).toEqual([
      "Alice",
      "dave",
    ]);
  });
});

describe("filter — migration from legacy flat array", () => {
  it("converts [{key,query}] to an AND group of contains rules", () => {
    const migrated = migrateFilters([
      { id: "x", key: "status", query: "open" },
      { id: "y", key: "__title", query: "a" },
    ]);
    expect(migrated?.op).toBe("and");
    expect(migrated?.conditions.length).toBe(2);
    expect(run(migrated as FilterGroup)).toEqual(["Alice", "Carol", "dave"]);
  });
  it("drops empty queries (old no-op filters)", () => {
    expect(migrateFilters([{ id: "x", key: "status", query: "" }])).toBeUndefined();
  });
  it("passes a tree object through, backfilling ids", () => {
    const migrated = migrateFilters({
      op: "or",
      conditions: [{ columnId: "age", operator: "eq", value: 40 }],
    });
    expect(migrated?.op).toBe("or");
    expect(migrated?.conditions[0].id).toBeTruthy();
    expect(run(migrated as FilterGroup)).toEqual(["Bob"]);
  });
  it("returns undefined for nullish / empty", () => {
    expect(migrateFilters(undefined)).toBeUndefined();
    expect(migrateFilters([])).toBeUndefined();
  });
});

describe("filter — dynamic host references", () => {
  const host: HostContext = {
    props: { p1: "open" },
    columns: [{ id: "p1", name: "State", type: "select" }],
    title: "Bob",
  };
  const dynGroup = (value: unknown): FilterGroup =>
    g("and", [{ id: "c", columnId: "status", operator: "is", value }]);

  it("resolves a prop reference to the host page value", () => {
    const resolved = resolveFilters(dynGroup({ ref: "prop", columnId: "p1" }), host);
    expect(run(resolved as FilterGroup)).toEqual(["Alice", "Carol", "dave"]);
  });
  it("resolves a title reference to the host page title", () => {
    const resolved = resolveFilters(
      g("and", [{ id: "c", columnId: "__title", operator: "is", value: { ref: "title" } }]),
      host,
    );
    expect(run(resolved as FilterGroup)).toEqual(["Bob"]);
  });
  it("drops dynamic conditions when there is no host (viewing source db)", () => {
    const resolved = resolveFilters(dynGroup({ ref: "prop", columnId: "p1" }), undefined);
    // condition dropped → empty group → matches all
    expect(run(resolved as FilterGroup)).toEqual(["Alice", "Bob", "Carol", "dave"]);
  });
  it("leaves static values untouched", () => {
    const resolved = resolveFilters(dynGroup("closed"), host);
    expect(run(resolved as FilterGroup)).toEqual(["Bob"]);
  });
});

describe("filter — operator catalog", () => {
  it("number type offers arithmetic ops", () => {
    expect(operatorsForType("number")).toContain("gt");
    expect(operatorsForType("number")).not.toContain("contains");
  });
  it("checkbox default op has no value input", () => {
    expect(operatorHasValue(defaultOperator("checkbox"))).toBe(false);
  });
  it("text default op takes a value", () => {
    expect(operatorHasValue(defaultOperator("text"))).toBe(true);
  });
});
