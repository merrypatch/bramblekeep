import { describe, expect, it } from "vitest";

import { buildGraphModel } from "./graph";
import type { DbColumn } from "./db";

const cols: DbColumn[] = [
  { id: "c1", name: "Name", type: "text" },
  { id: "rel", name: "Project", type: "relation", relationDb: "db-proj" },
  { id: "self", name: "Blocks", type: "relation", relationDb: "db-self" },
];

const labelOf = (id: string): string =>
  ({ r1: "Task A", r2: "Task B", p1: "Proj X" })[id] ?? id;

describe("buildGraphModel", () => {
  it("emits a node per row and per linked target, edges from relation cells", () => {
    const rows = [
      { id: "r1", title: "Task A", props: { rel: ["p1"] } },
      { id: "r2", title: "Task B", props: { rel: ["p1"] } },
    ];
    const g = buildGraphModel(rows, cols, labelOf);
    expect(g.nodes).toContainEqual({ id: "r1", label: "Task A", group: "row" });
    expect(g.nodes).toContainEqual({ id: "p1", label: "Proj X", group: "linked" });
    expect(g.nodes).toHaveLength(3); // r1, r2, p1
    expect(g.edges).toHaveLength(2); // r1-p1, r2-p1
  });

  it("dedupes reciprocal edges (A→B and B→A count once)", () => {
    const rows = [
      { id: "r1", title: "A", props: { self: ["r2"] } },
      { id: "r2", title: "B", props: { self: ["r1"] } },
    ];
    const g = buildGraphModel(rows, cols, labelOf);
    expect(g.edges).toHaveLength(1);
  });

  it("skips self-links and empty cells", () => {
    const rows = [{ id: "r1", title: "A", props: { self: ["r1"], rel: [] } }];
    const g = buildGraphModel(rows, cols, labelOf);
    expect(g.edges).toHaveLength(0);
    expect(g.nodes).toHaveLength(1);
  });

  it("marks a target that is itself a row as a row node, not linked", () => {
    const rows = [
      { id: "r1", title: "A", props: { self: ["r2"] } },
      { id: "r2", title: "B", props: {} },
    ];
    const g = buildGraphModel(rows, cols, labelOf);
    expect(g.nodes.find((n) => n.id === "r2")?.group).toBe("row");
  });

  it("ignores non-array relation values defensively", () => {
    const rows = [{ id: "r1", title: "A", props: { rel: "oops" } }];
    const g = buildGraphModel(rows, cols, labelOf);
    expect(g.edges).toHaveLength(0);
    expect(g.nodes).toHaveLength(1);
  });
});
