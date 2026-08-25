import { describe, expect, it } from "vitest";

import {
  cleanTitle,
  hasMarkdown,
  liftTasksOutOfQuotes,
  linksIn,
  resolveLink,
  planMdImport,
  stripLeadingTitle,
} from "./mdImport";
import { unzipAll } from "./zip";
import { MARKDOWN_VAULT_B64 } from "./__fixtures__/markdownVault.b64";

const enc = new TextEncoder();

/** An archive, as `unzipAll` hands it over. */
function archive(entries: Record<string, string>): Map<string, Uint8Array> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, enc.encode(v)]));
}

describe("cleanTitle", () => {
  it("drops a trailing machine identifier and keeps the rest of the name", () => {
    expect(cleanTitle("Trip planning 1a2b3c4d5e6f7890abcdef1234567890.md")).toBe("Trip planning");
    expect(cleanTitle("Notes a1b2c3d4")).toBe("Notes");
  });

  it("decodes percent-escapes in names", () => {
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

describe("planMdImport", () => {
  it("nests children under the page whose folder they live in", () => {
    const plan = planMdImport(
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
    const plan = planMdImport(
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

  it("looks through a single wrapper folder the archive is packed in", () => {
    const plan = planMdImport(
      archive({ "My export/Home.md": "home", "My export/Home/Sub.md": "sub" }),
    );
    expect(plan.roots.map((p) => p.title)).toEqual(["Home"]);
    expect(plan.roots[0].children.map((p) => p.title)).toEqual(["Sub"]);
  });

  it("keeps a top-level folder that is NOT a wrapper", () => {
    // `Notes.md` sits beside `Work/`, so `Work` is real structure, not packaging.
    const plan = planMdImport(archive({ "Notes.md": "a", "Work/Report.md": "b" }));
    expect(plan.pageCount).toBe(2);
    expect(plan.roots.map((p) => p.title)).toContain("Notes");
  });

  it("imports a plain vault whose files carry no identifier at all", () => {
    const plan = planMdImport(
      archive({ "Daily.md": "today", "Daily/2026-01-01.md": "entry" }),
    );
    expect(plan.roots.map((p) => p.title)).toEqual(["Daily"]);
    expect(plan.roots[0].children.map((p) => p.title)).toEqual(["2026-01-01"]);
  });

  it("counts what it is not importing yet instead of dropping it quietly", () => {
    const plan = planMdImport(
      archive({
        "Page 1a2b3c4d5e6f.md": "text",
        "Page 1a2b3c4d5e6f/Budget 9f8e7d6c5b4a.csv": "a,b\n1,2",
        "Page 1a2b3c4d5e6f/photo.png": "\x89PNG",
        "Page 1a2b3c4d5e6f/scan.pdf": "%PDF",
      }),
    );
    expect(plan.pageCount).toBe(1);
    expect(plan.attachments).toBe(2);
    expect(plan.skipped).toEqual({ databases: 1 });
  });

  /// A page whose parent `.md` is missing would otherwise vanish with its folder.
  it("rescues a page whose parent file is absent rather than losing it", () => {
    const plan = planMdImport(
      archive({
        "Orphaned parent 1a2b3c4d5e6f/Child 9f8e7d6c5b4a.md": "still mine",
      }),
    );
    expect(plan.pageCount).toBe(1);
    expect(plan.roots[0].title).toBe("Child");
    expect(plan.roots[0].markdown).toBe("still mine");
  });

  it("has nothing to say about an empty archive", () => {
    const plan = planMdImport(archive({}));
    expect(plan).toEqual({ roots: [], pageCount: 0, attachments: 0, skipped: { databases: 0 } });
  });
});

describe("hasMarkdown", () => {
  it("accepts a plain folder of notes, with no decoration at all", () => {
    expect(hasMarkdown(archive({ "notes.md": "x", "readme.md": "y" }))).toBe(true);
  });

  it("says no to an archive with nothing to import", () => {
    expect(hasMarkdown(archive({ "photo.png": "x", "data.csv": "a,b" }))).toBe(false);
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

describe("a real archive, read end to end", () => {
  it("turns a zipped folder of notes into the tree it looks like", async () => {
    const bytes = Uint8Array.from(atob(MARKDOWN_VAULT_B64), (c) => c.charCodeAt(0));
    const plan = planMdImport(await unzipAll(bytes));

    // Two pages at the root, one nested twice, and the image counted not lost.
    expect(plan.pageCount).toBe(4);
    expect(plan.roots.map((p) => p.title).sort()).toEqual(["Journal", "Projets"]);
    const projets = plan.roots.find((p) => p.title === "Projets")!;
    expect(projets.children.map((c) => c.title)).toEqual(["Serveur"]);
    expect(projets.children[0].children.map((c) => c.title)).toEqual(["Notes 2026"]);
    expect(plan.attachments).toBe(1);

    // The body is the file's, minus the title heading the page already carries.
    expect(stripLeadingTitle(projets.children[0].markdown, "Serveur")).toContain("monter le Pi");
  });
});

describe("titles come from the heading, not the filename", () => {
  /// The bug this exists for: exporters cut filenames at ~50 characters, so the
  /// name on disk is a prefix of the real title.
  it("recovers a title the filename had truncated", () => {
    const full = "Procès-verbal de remise de documents (À faire signer en double exemplaire)";
    const plan = planMdImport(
      archive({ "Procès-verbal de remise de documents (À faire sign.md": `# ${full}\n\nbody` }),
    );
    expect(plan.roots[0].title).toBe(full);
  });

  it("falls back to the filename when there is no heading", () => {
    const plan = planMdImport(archive({ "Shopping list.md": "- milk\n- bread" }));
    expect(plan.roots[0].title).toBe("Shopping list");
  });

  it("does not mistake a lower heading for the title", () => {
    const plan = planMdImport(archive({ "Notes.md": "## A section\n\nbody" }));
    expect(plan.roots[0].title).toBe("Notes");
  });

  it("ignores a heading that is not the first thing in the file", () => {
    const plan = planMdImport(archive({ "Notes.md": "intro line\n\n# Later heading" }));
    expect(plan.roots[0].title).toBe("Notes");
  });

  /// With the title now taken from the heading, the two match and the duplicate
  /// goes away — which is what `stripLeadingTitle` is for.
  it("removes the heading it took the title from", () => {
    const plan = planMdImport(archive({ "Trip 1a2b3c4d5e6f.md": "# Trip planning\n\nplans" }));
    const page = plan.roots[0];
    expect(page.title).toBe("Trip planning");
    expect(stripLeadingTitle(page.markdown, page.title)).toBe("plans");
  });
});

describe("liftTasksOutOfQuotes", () => {
  /// The editor's quote block is inline-only, so a quoted checkbox can only ever
  /// be text. Lifted out, it is a checkbox again.
  it("takes checkboxes out of a quote, splitting it where they were", () => {
    const md = [
      "> **Heading**",
      ">",
      "> Intro line",
      ">",
      "> - [ ]  First",
      "> - [x]  Second",
      ">",
      "> Closing line",
    ].join("\n");
    expect(liftTasksOutOfQuotes(md).split("\n")).toEqual([
      "> **Heading**",
      ">",
      "> Intro line",
      ">",
      "- [ ]  First",
      "- [x]  Second",
      ">",
      "> Closing line",
    ]);
  });

  it("leaves ordinary quoted lists alone", () => {
    const md = "> - a bullet\n> 1. a number";
    expect(liftTasksOutOfQuotes(md)).toBe(md);
  });

  it("leaves checkboxes that were never in a quote", () => {
    const md = "- [ ] already free\n- [x] and this one";
    expect(liftTasksOutOfQuotes(md)).toBe(md);
  });

  it("leaves prose that merely mentions brackets", () => {
    const md = "> see [the link](http://x) and [ ] brackets";
    expect(liftTasksOutOfQuotes(md)).toBe(md);
  });
});

describe("resolveLink", () => {
  const files = new Map<string, Uint8Array>([
    ["Page/Sans titre/shot.jpg", new Uint8Array()],
    ["Other/photo.png", new Uint8Array()],
  ]);

  it("resolves a percent-encoded path relative to the page", () => {
    expect(resolveLink(files, "Page/Note.md", "Sans%20titre/shot.jpg")).toBe(
      "Page/Sans titre/shot.jpg",
    );
  });

  it("falls back to a basename match when the folder does not line up", () => {
    expect(resolveLink(files, "Page/Note.md", "elsewhere/photo.png")).toBe("Other/photo.png");
  });

  it("leaves external and absolute targets alone", () => {
    expect(resolveLink(files, "Page/Note.md", "https://example.test/x.png")).toBeNull();
    expect(resolveLink(files, "Page/Note.md", "/already/served.png")).toBeNull();
    expect(resolveLink(files, "Page/Note.md", "data:image/png;base64,AAAA")).toBeNull();
  });

  it("says so when nothing matches", () => {
    expect(resolveLink(files, "Page/Note.md", "missing.gif")).toBeNull();
  });
});

describe("linksIn", () => {
  it("finds image and link targets, without repeating one", () => {
    const md = '![a](one.png)\n\n[text](two.pdf)\n\n![b](one.png "title")';
    expect(linksIn(md)).toEqual(["one.png", "two.pdf"]);
  });

  it("has nothing to say about prose", () => {
    expect(linksIn("just words, and a [bracket] alone")).toEqual([]);
  });
});
