import { describe, expect, it } from "vitest";

import {
  cleanTitle,
  looksLikeNotionExport,
  planNotionImport,
  stripLeadingTitle,
} from "./notionImport";

const enc = new TextEncoder();

/** An archive, as `unzipAll` hands it over. */
function archive(entries: Record<string, string>): Map<string, Uint8Array> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, enc.encode(v)]));
}

describe("cleanTitle", () => {
  it("drops the id Notion appends and keeps the rest of the name", () => {
    expect(cleanTitle("Trip planning 1a2b3c4d5e6f7890abcdef1234567890.md")).toBe("Trip planning");
    expect(cleanTitle("Notes a1b2c3d4")).toBe("Notes");
  });

  it("decodes the escapes Notion puts in paths", () => {
    expect(cleanTitle("Caf%C3%A9%20du%20matin 1a2b3c4d5e6f.md")).toBe("Café du matin");
  });

  it("leaves a title that has no id alone", () => {
    expect(cleanTitle("Just a page.md")).toBe("Just a page");
    // A word that is hex but far too short to be an id must survive.
    expect(cleanTitle("Recipe abc.md")).toBe("Recipe abc");
  });

  it("survives a stray percent that is not an escape", () => {
    expect(cleanTitle("100% done 1a2b3c4d5e6f.md")).toBe("100% done");
  });
});

describe("planNotionImport", () => {
  it("nests children under the page whose folder they live in", () => {
    const plan = planNotionImport(
      archive({
        "Trip 1a2b3c4d5e6f.md": "# Trip\n\nplans",
        "Trip 1a2b3c4d5e6f/Packing 9f8e7d6c5b4a.md": "# Packing\n\nsocks",
        "Trip 1a2b3c4d5e6f/Packing 9f8e7d6c5b4a/Shoes 112233445566.md": "# Shoes\n\nboots",
      }),
    );
    expect(plan.pageCount).toBe(3);
    expect(plan.roots).toHaveLength(1);
    const trip = plan.roots[0];
    expect(trip.title).toBe("Trip");
    expect(trip.children.map((c) => c.title)).toEqual(["Packing"]);
    expect(trip.children[0].children.map((c) => c.title)).toEqual(["Shoes"]);
  });

  it("tells two pages of the same title apart by their ids", () => {
    // Both are called "Notes"; only the id says which folder belongs to which.
    const plan = planNotionImport(
      archive({
        "Notes aaaaaaaaaaaa.md": "first",
        "Notes bbbbbbbbbbbb.md": "second",
        "Notes aaaaaaaaaaaa/Child 111111111111.md": "child of the first",
      }),
    );
    expect(plan.roots).toHaveLength(2);
    const withChild = plan.roots.find((p) => p.children.length > 0);
    expect(withChild?.markdown).toBe("first");
    expect(withChild?.children[0].title).toBe("Child");
    expect(plan.roots.find((p) => p.markdown === "second")?.children).toEqual([]);
  });

  it("looks through the Export-<uuid> wrapper of a full-workspace export", () => {
    const plan = planNotionImport(
      archive({
        "Export-1234abcd-5678/Home 1a2b3c4d5e6f.md": "home",
        "Export-1234abcd-5678/Home 1a2b3c4d5e6f/Sub 9f8e7d6c5b4a.md": "sub",
      }),
    );
    expect(plan.roots.map((p) => p.title)).toEqual(["Home"]);
    expect(plan.roots[0].children.map((p) => p.title)).toEqual(["Sub"]);
  });

  it("counts what it is not importing yet instead of dropping it quietly", () => {
    const plan = planNotionImport(
      archive({
        "Page 1a2b3c4d5e6f.md": "text",
        "Page 1a2b3c4d5e6f/Budget 9f8e7d6c5b4a.csv": "a,b\n1,2",
        "Page 1a2b3c4d5e6f/photo.png": "\x89PNG",
        "Page 1a2b3c4d5e6f/scan.pdf": "%PDF",
      }),
    );
    expect(plan.pageCount).toBe(1);
    expect(plan.skipped).toEqual({ databases: 1, attachments: 2 });
  });

  /// A page whose parent `.md` is missing would otherwise vanish with its folder.
  it("rescues a page whose parent file is absent rather than losing it", () => {
    const plan = planNotionImport(
      archive({
        "Orphaned parent 1a2b3c4d5e6f/Child 9f8e7d6c5b4a.md": "still mine",
      }),
    );
    expect(plan.pageCount).toBe(1);
    expect(plan.roots[0].title).toBe("Child");
    expect(plan.roots[0].markdown).toBe("still mine");
  });

  it("has nothing to say about an empty archive", () => {
    const plan = planNotionImport(archive({}));
    expect(plan).toEqual({ roots: [], pageCount: 0, skipped: { databases: 0, attachments: 0 } });
  });
});

describe("looksLikeNotionExport", () => {
  it("recognises the id suffix Notion puts on every page", () => {
    expect(looksLikeNotionExport(archive({ "Page 1a2b3c4d5e6f.md": "x" }))).toBe(true);
  });

  it("says no to a zip of plain markdown, which this importer cannot place", () => {
    expect(looksLikeNotionExport(archive({ "notes.md": "x", "readme.md": "y" }))).toBe(false);
  });
});

describe("stripLeadingTitle", () => {
  it("removes the H1 that repeats the page title", () => {
    expect(stripLeadingTitle("# Trip\n\nplans here", "Trip")).toBe("plans here");
  });

  it("keeps an H1 that says something else", () => {
    const md = "# Actually a section\n\nbody";
    expect(stripLeadingTitle(md, "Trip")).toBe(md);
  });

  it("keeps a body that starts with prose", () => {
    expect(stripLeadingTitle("plans here", "Trip")).toBe("plans here");
  });
});
