//! Reading a folder of Markdown files — a zip, a vault, an export.
//!
//! The shape is the one every note-taking tool converges on, because it is the
//! one a filesystem gives you: a page is a `.md` file, and its children live in a
//! folder beside it bearing the same name.
//!
//! ```text
//! Trip planning.md
//! Trip planning/
//!   ├── Packing list.md
//!   ├── photo.png
//!   └── Budget.csv
//! ```
//!
//! Two tolerances make that work on archives written by tools that decorate
//! their filenames, without this module knowing or caring which tool:
//!
//! - a trailing run of hex characters is treated as a machine identifier and
//!   dropped from the title — but kept when matching a page to its folder,
//!   since it may be the only thing telling two same-named pages apart;
//! - a single wrapper folder at the root is looked through, since archives are
//!   commonly packed inside one.
//!
//! This module only reads and plans. Nothing here creates anything — the plan is
//! shown before a single page is written, because an import that turns out wrong
//! is a workspace someone has to clean up by hand.

/** A page found in the archive, with its children. */
export type MdPage = {
  /** Title, with any machine identifier suffix removed. */
  title: string;
  /** Path of the `.md` file inside the archive (empty for a folder with no page). */
  path: string;
  markdown: string;
  children: MdPage[];
};

/** What an archive turned out to hold, and what will be skipped. */
export type MdPlan = {
  roots: MdPage[];
  /** Total pages, at every depth. */
  pageCount: number;
  /** Entries this import does not handle, by kind — reported rather than
   * dropped in silence, so nobody discovers the gap after the fact. */
  skipped: { databases: number; attachments: number };
};

/** A trailing run of hex, after a space, underscore or dash: how tools tag an
 * exported file with the identifier it had inside them. Eight characters is the
 * floor, so an ordinary word that happens to be hex ("abc", "cafe") survives. */
const ID_SUFFIX = /[ _-][0-9a-f]{8,}$/i;

/** The title a file should give its page: identifier suffix dropped, and
 * percent-escapes decoded — archives commonly URL-encode their names. */
export function cleanTitle(name: string): string {
  let base = name.replace(/\.md$/i, "");
  try {
    base = decodeURIComponent(base);
  } catch {
    // A stray `%` that is not an escape: keep the name as it came.
  }
  return base.replace(ID_SUFFIX, "").trim();
}

/** Every path's segments, minus a wrapper folder shared by all of them.
 *
 * Archives are usually packed inside a single top folder, which would otherwise
 * become a page containing everything. Computed over the whole file list rather
 * than guessed from one name: a folder is only a wrapper if nothing sits beside
 * it. */
function splitter(paths: string[]): (path: string) => string[] {
  const first = paths.map((p) => p.split("/").filter(Boolean)[0]);
  const shared = first.length > 1 && first.every((f) => f === first[0]);
  // A shared first segment is only a wrapper if it is a folder for everyone,
  // i.e. no path IS that segment.
  const wrapper = shared && !paths.some((p) => p.split("/").filter(Boolean).length === 1);
  return (path: string) => {
    const parts = path.split("/").filter(Boolean);
    if (wrapper) parts.shift();
    return parts;
  };
}

/**
 * Builds the page tree from the archive's entries.
 *
 * `files` maps zip path → bytes, as `unzipAll` returns. Only `.md` entries
 * become pages; everything else is counted so the plan can say what it is
 * leaving behind.
 */
export function planMdImport(files: Map<string, Uint8Array>): MdPlan {
  const dec = new TextDecoder();
  const skipped = { databases: 0, attachments: 0 };
  const segments = splitter([...files.keys()]);

  // Group every markdown file by its folder path, so a page can find the
  // children living in the folder named after it.
  const mdPaths: string[] = [];
  for (const name of files.keys()) {
    const segs = segments(name);
    if (segs.length === 0) continue;
    const leaf = segs[segs.length - 1];
    if (/\.md$/i.test(leaf)) mdPaths.push(name);
    else if (/\.csv$/i.test(leaf)) skipped.databases += 1;
    else skipped.attachments += 1;
  }

  /** Pages directly inside `prefix` (a list of segments, [] = archive root). */
  const build = (prefix: string[]): MdPage[] => {
    const here: MdPage[] = [];
    for (const path of mdPaths) {
      const segs = segments(path);
      if (segs.length !== prefix.length + 1) continue;
      if (!prefix.every((p, i) => segs[i] === p)) continue;

      const leaf = segs[segs.length - 1];
      here.push({
        title: cleanTitle(leaf) || "Untitled",
        path,
        markdown: dec.decode(files.get(path) ?? new Uint8Array()),
        children: build([...prefix, leaf.replace(/\.md$/i, "")]),
      });
    }
    // Archive order is the author's order often enough; keep it rather than
    // invent one.
    here.sort((a, b) => a.path.localeCompare(b.path));
    return here;
  };

  const roots = build([]);

  // A folder whose `.md` sibling is missing would orphan its children — common
  // for a folder of attachments, or for pages exported on their own.
  const claimed = new Set<string>();
  const mark = (pages: MdPage[], prefix: string[]) => {
    for (const p of pages) {
      const segs = segments(p.path);
      claimed.add(segs.join("/"));
      mark(p.children, [...prefix, segs[segs.length - 1].replace(/\.md$/i, "")]);
    }
  };
  mark(roots, []);
  const orphans = mdPaths.filter((p) => !claimed.has(segments(p).join("/")));
  for (const path of orphans) {
    const segs = segments(path);
    const leaf = segs[segs.length - 1];
    // Attach at the root rather than lose it: a page in the wrong place can be
    // moved, a page that never arrived cannot.
    roots.push({
      title: cleanTitle(leaf) || "Untitled",
      path,
      markdown: dec.decode(files.get(path) ?? new Uint8Array()),
      children: [],
    });
  }

  const count = (pages: MdPage[]): number =>
    pages.reduce((n, p) => n + 1 + count(p.children), 0);

  return { roots, pageCount: count(roots), skipped };
}

/** Does this archive hold any Markdown at all? Used to say so plainly instead of
 * importing nothing and calling it a success. */
export function hasMarkdown(files: Map<string, Uint8Array>): boolean {
  for (const name of files.keys()) {
    if (/\.md$/i.test(name)) return true;
  }
  return false;
}

/** Exported markdown usually opens with the page title as an `# H1`, which would
 * duplicate the title the page already carries. Drops it, and only it — a
 * heading saying anything else is content. */
export function stripLeadingTitle(markdown: string, title: string): string {
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  if (i < lines.length && /^#\s+/.test(lines[i])) {
    const heading = lines[i].replace(/^#\s+/, "").trim();
    if (heading === title.trim()) {
      lines.splice(0, i + 1);
      while (lines.length && lines[0].trim() === "") lines.shift();
      return lines.join("\n");
    }
  }
  return markdown;
}
