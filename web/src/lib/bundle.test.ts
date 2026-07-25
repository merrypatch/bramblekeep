import { describe, expect, it } from "vitest";

import { planBundleImport, readBundle, type ParsedBundle } from "./bundle";
import { zipStore, type ZipEntry } from "./zip";
import type { DbSchema } from "./db";

/** Zips entries and re-parses them through the real bundle reader. */
async function parse(entries: ZipEntry[]): Promise<ParsedBundle> {
  const bytes = new Uint8Array(await zipStore(entries).arrayBuffer());
  return readBundle(bytes);
}

/** Builds a parsed two-database bundle: a root "Tasks" table with a relation to
 * a linked "Projects" table. */
function makeBundle(): Promise<ParsedBundle> {
  const manifest = {
    version: 1,
    app: "bramblekeep",
    root: "db-root",
    dbs: [
      {
        id: "db-root",
        title: "Tasks",
        schema: {
          columns: [
            { id: "c1", name: "Name", type: "text" },
            { id: "c2", name: "Status", type: "select" },
            { id: "c3", name: "Project", type: "relation", relationDb: "db-proj" },
            { id: "c4", name: "Computed", type: "formula" },
          ],
          views: [],
        },
        csv: "root.csv",
      },
      {
        id: "db-proj",
        title: "Projects",
        schema: { columns: [{ id: "p1", name: "Name", type: "text" }], views: [] },
        csv: "proj.csv",
      },
    ],
  };
  return parse([
    { name: "manifest.json", text: JSON.stringify(manifest) },
    { name: "root.csv", text: "Name,Status,Project\nTask A,Todo,Proj X\nTask B,Done,Proj Y\n" },
    { name: "proj.csv", text: "Name\nProj X\nProj Y\nProj Z\n" },
  ]);
}

describe("planBundleImport", () => {
  const current: DbSchema = {
    columns: [
      { id: "x1", name: "Name", type: "text" },
      { id: "x2", name: "Status", type: "status" },
    ],
    views: [],
  };

  it("reuses columns matched by name, adds the rest", async () => {
    const plan = planBundleImport(current, await makeBundle());
    // Name + Status match the current db (case/space-insensitive); Project does not.
    expect(plan.reusedColumnNames.sort()).toEqual(["Name", "Status"]);
    expect(plan.addedColumns).toEqual([{ name: "Project", type: "relation" }]);
  });

  it("excludes computed/meta columns from the merge", async () => {
    const plan = planBundleImport(current, await makeBundle());
    const names = [...plan.reusedColumnNames, ...plan.addedColumns.map((c) => c.name)];
    expect(names).not.toContain("Computed");
  });

  it("counts root rows merged into the current db", async () => {
    const plan = planBundleImport(current, await makeBundle());
    expect(plan.rootTitle).toBe("Tasks");
    expect(plan.rootRowCount).toBe(2);
  });

  it("lists linked databases created fresh, with their row counts", async () => {
    const plan = planBundleImport(current, await makeBundle());
    expect(plan.linkedDbs).toEqual([{ title: "Projects", rowCount: 3 }]);
  });

  it("matches column names case- and whitespace-insensitively", async () => {
    const messy: DbSchema = { columns: [{ id: "x1", name: "  name ", type: "text" }], views: [] };
    const plan = planBundleImport(messy, await makeBundle());
    expect(plan.reusedColumnNames).toEqual(["Name"]);
    expect(plan.addedColumns.map((c) => c.name)).toEqual(["Status", "Project"]);
  });

  it("throws when the manifest has no root database", async () => {
    const bundle = await parse([
      {
        name: "manifest.json",
        text: JSON.stringify({ version: 1, app: "bramblekeep", root: "missing", dbs: [] }),
      },
    ]);
    expect(() => planBundleImport(current, bundle)).toThrow();
  });
});
