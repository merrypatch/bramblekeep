//! Reading a Notion export.
//!
//! Notion's "Markdown & CSV" export is a ZIP whose structure is carried entirely
//! by file names. A page is `Title <32 hex>.md`; its children live in a sibling
//! folder of the same name, `Title <32 hex>/`; that folder holds their own `.md`
//! files, their attachments, and the CSVs of any database on the page.
//!
//! ```text
//! Trip planning 1a2b….md
//! Trip planning 1a2b…/
//!   ├── Packing list 3c4d….md
//!   ├── photo.png
//!   └── Budget 5e6f….csv
//! ```
//!
//! Two things about that id suffix matter. It is how Notion disambiguates two
//! pages with the same title, so it cannot simply be ignored while matching a
//! page to its folder; and it is meaningless to a human, so it must not survive
//! into the imported title.
//!
//! This module only reads and plans. Nothing here creates anything — the plan is
//! shown before a single page is written, because an import that turns out wrong
//! is a workspace someone has to clean up by hand.

/** A page found in the export, with its children. */
export type NotionPage = {
  /** Title with Notion's id suffix removed. */
  title: string;
  /** Path of the `.md` file inside the archive (empty for a folder with no page). */
  path: string;
  markdown: string;
  children: NotionPage[];
};

/** What an archive turned out to hold, and what will be skipped. */
export type NotionPlan = {
  roots: NotionPage[];
  /** Total pages, at every depth. */
  pageCount: number;
  /** Entries this slice does not import yet, by kind — reported rather than
   * dropped in silence, so nobody discovers the gap after the fact. */
  skipped: { databases: number; attachments: number };
};

/** Notion appends a 32-hex id (sometimes with a leading space or dash) to every
 * exported name. Newer exports use a shorter hash; both are hex runs of 8+. */
const ID_SUFFIX = /[ _-][0-9a-f]{8,}$/i;

/** Strips Notion's id suffix and decodes the percent-escapes it puts in paths. */
export function cleanTitle(name: string): string {
  let base = name.replace(/\.md$/i, "");
  try {
    base = decodeURIComponent(base);
  } catch {
    // A stray `%` that is not an escape: keep the name as it came.
  }
  return base.replace(ID_SUFFIX, "").trim();
}

/** Splits a zip path, tolerating the leading `Export-<uuid>/` folder that
 * Notion wraps everything in when you export a whole workspace. */
function segments(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 1 && /^export-/i.test(parts[0])) parts.shift();
  return parts;
}

/**
 * Builds the page tree from the archive's entries.
 *
 * `files` maps zip path → bytes, as `unzipAll` returns. Only `.md` entries
 * become pages; everything else is counted so the plan can say what it is
 * leaving behind.
 */
export function planNotionImport(files: Map<string, Uint8Array>): NotionPlan {
  const dec = new TextDecoder();
  const skipped = { databases: 0, attachments: 0 };

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
  const build = (prefix: string[]): NotionPage[] => {
    const here: NotionPage[] = [];
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
    // Notion orders by name in the archive; keep that rather than invent one.
    here.sort((a, b) => a.path.localeCompare(b.path));
    return here;
  };

  const roots = build([]);

  // A folder whose `.md` sibling is missing would orphan its children. Notion
  // does this for a database's row folder, and for pages exported alone.
  const claimed = new Set<string>();
  const mark = (pages: NotionPage[], prefix: string[]) => {
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

  const count = (pages: NotionPage[]): number =>
    pages.reduce((n, p) => n + 1 + count(p.children), 0);

  return { roots, pageCount: count(roots), skipped };
}

/** Does this archive look like a Notion export at all? Used to say so plainly
 * instead of importing nothing and calling it a success. */
export function looksLikeNotionExport(files: Map<string, Uint8Array>): boolean {
  for (const name of files.keys()) {
    const segs = segments(name);
    const leaf = segs[segs.length - 1] ?? "";
    if (/\.md$/i.test(leaf) && ID_SUFFIX.test(leaf.replace(/\.md$/i, ""))) return true;
  }
  return false;
}

/** Notion's markdown starts with the page title as an `# H1`, which would
 * duplicate the title the page already carries. Drops it, and only it. */
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
