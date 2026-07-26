import { describe, expect, it } from "vitest";

import {
  countTaskRun,
  countTasks,
  countTasksInPage,
  type TaskTreeNode,
  taskPercent,
} from "./taskProgress";

/** Checklist item. `children` allows nesting sub-tasks. */
function task(id: string, checked: boolean, children: TaskTreeNode[] = []): TaskTreeNode {
  return { id, type: "checkListItem", props: { checked }, children };
}

function block(id: string, type: string, children: TaskTreeNode[] = []): TaskTreeNode {
  return { id, type, props: {}, children };
}

describe("countTaskRun", () => {
  const doc: TaskTreeNode[] = [
    block("h", "heading"),
    block("p1", "taskProgress"),
    task("a", true),
    task("b", false),
    task("c", true),
    block("para", "paragraph"), // cuts the run
    block("p2", "taskProgress"),
    task("d", false),
  ];

  it("counts the run that follows the block", () => {
    expect(countTaskRun(doc, "p1")).toEqual({ done: 2, total: 3 });
  });

  it("stops at the first non-checklist block", () => {
    expect(countTaskRun(doc, "p2")).toEqual({ done: 0, total: 1 });
  });

  it("counts nested sub-tasks", () => {
    const nested: TaskTreeNode[] = [
      block("p", "taskProgress"),
      task("a", true, [task("a1", true), task("a2", false)]),
      task("b", false, [block("note", "paragraph", [task("b1", true)])]),
    ];
    expect(countTaskRun(nested, "p")).toEqual({ done: 3, total: 5 });
  });

  it("finds the block even when it is nested", () => {
    const nested: TaskTreeNode[] = [
      block("outer", "bulletListItem", [block("p", "taskProgress"), task("a", true), task("b", false)]),
      task("elsewhere", true),
    ];
    expect(countTaskRun(nested, "p")).toEqual({ done: 1, total: 2 });
  });

  it("returns zero if nothing follows or the block is unknown", () => {
    expect(countTaskRun(doc, "d")).toEqual({ done: 0, total: 0 });
    expect(countTaskRun(doc, "ghost")).toEqual({ done: 0, total: 0 });
  });

  it("ignores a checkbox that is not directly after the block", () => {
    const doc2: TaskTreeNode[] = [block("p", "taskProgress"), block("para", "paragraph"), task("a", true)];
    expect(countTaskRun(doc2, "p")).toEqual({ done: 0, total: 0 });
  });
});

describe("countTasksInPage", () => {
  it("counts every checklist item wherever it is", () => {
    const doc: TaskTreeNode[] = [
      block("p", "taskProgress"),
      task("a", true),
      block("para", "paragraph"),
      block("quote", "quote", [task("b", false), task("c", true)]),
    ];
    expect(countTasksInPage(doc)).toEqual({ done: 2, total: 3 });
  });

  it("tolerates missing props / children", () => {
    const doc: TaskTreeNode[] = [{ id: "a", type: "checkListItem" }, { id: "b", type: "paragraph" }];
    expect(countTasksInPage(doc)).toEqual({ done: 0, total: 1 });
  });
});

describe("countTasks", () => {
  const doc: TaskTreeNode[] = [task("before", true), block("p", "taskProgress"), task("a", false)];

  it("dispatches on the scope", () => {
    expect(countTasks(doc, "p", "next")).toEqual({ done: 0, total: 1 });
    expect(countTasks(doc, "p", "page")).toEqual({ done: 1, total: 2 });
  });
});

describe("taskPercent", () => {
  it("handles the boundaries", () => {
    expect(taskPercent({ done: 0, total: 0 })).toBe(0);
    expect(taskPercent({ done: 0, total: 4 })).toBe(0);
    expect(taskPercent({ done: 4, total: 4 })).toBe(100);
    expect(taskPercent({ done: 5, total: 4 })).toBe(100);
    expect(taskPercent({ done: 1, total: 3 })).toBe(33);
    expect(taskPercent({ done: 5, total: 15 })).toBe(33);
  });

  it("never rounds to 0 or 100 while the list is in progress", () => {
    expect(taskPercent({ done: 1, total: 500 })).toBe(1);
    expect(taskPercent({ done: 499, total: 500 })).toBe(99);
  });
});
