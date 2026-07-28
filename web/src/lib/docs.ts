/**
 * Built-in documentation: markdown files shipped INSIDE the binary, rendered
 * read-only in the app.
 *
 * Why not a seeded database of pages: docs written into the user's database at
 * install time freeze at that version, and an upgrade cannot rewrite pages the
 * user may have edited — every instance would end up carrying documentation for
 * a different release. Bundled docs follow the installed version by
 * construction, are readable by every member with no sharing at all, and never
 * touch the database. The tutorial content that IS seeded stays small and
 * disposable, on purpose.
 *
 * The same markdown can feed the project's public website later: one source.
 */

import { DEFAULT_LANGUAGE, type Language } from "@/i18n";

/** Chapter order of the table of contents. A slug with no `.md` file yet is
 * simply absent from the reader — the docs can land chapter by chapter. */
export const DOC_SLUGS = [
  "getting-started",
  "pages-and-tree",
  "databases",
  "relations-and-rollups",
  "formulas",
  "charts",
  "graph-view",
  "sharing-and-permissions",
  "accounts-and-sign-in",
  "install-and-updates",
] as const;

export type DocSlug = (typeof DOC_SLUGS)[number];

export type DocPage = {
  slug: string;
  /** Title read from the leading `# ` of the file: one source, no drift with a
   * separate registry. */
  title: string;
  /** Body WITHOUT that leading heading (the reader renders the title itself). */
  markdown: string;
};

/** Per-language chunks: only the requested language is downloaded. */
const LOADERS: Record<Language, () => Promise<{ default: Record<string, string> }>> = {
  en: () => import("@/docs/en"),
  fr: () => import("@/docs/fr"),
  es: () => import("@/docs/es"),
};

/** Splits "# Title\n\nbody" into its title and the rest. A file without a
 * leading heading keeps its whole content and falls back to its slug. */
function splitTitle(raw: string, slug: string): { title: string; markdown: string } {
  const match = /^\s*#\s+(.+?)\s*\n/.exec(raw);
  if (!match) return { title: slug, markdown: raw.trim() };
  return { title: match[1], markdown: raw.slice(match[0].length).trim() };
}

/**
 * Loads the documentation of a language, in chapter order. Falls back to
 * English per chapter: a page not translated yet is served in English rather
 * than hidden — an incomplete translation must not remove content.
 */
export async function loadDocs(lang: Language): Promise<DocPage[]> {
  const [localized, fallback] = await Promise.all([
    LOADERS[lang]().then((m) => m.default),
    lang === DEFAULT_LANGUAGE
      ? Promise.resolve<Record<string, string>>({})
      : LOADERS[DEFAULT_LANGUAGE]().then((m) => m.default),
  ]);
  const pick = (slug: string): string | undefined =>
    localized[`./${slug}.md`] ?? fallback[`./${slug}.md`];

  return DOC_SLUGS.flatMap((slug) => {
    const raw = pick(slug);
    if (!raw) return [];
    const { title, markdown } = splitTitle(raw, slug);
    return [{ slug, title, markdown }];
  });
}
