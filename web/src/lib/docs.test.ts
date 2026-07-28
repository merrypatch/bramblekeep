import { describe, expect, it } from "vitest";

import { DOC_SLUGS, loadDocs } from "./docs";
import { LANGUAGES } from "@/i18n";

describe("built-in documentation", () => {
  it("serves the chapters in table-of-contents order", async () => {
    const pages = await loadDocs("en");
    expect(pages.length).toBeGreaterThan(0);
    const positions = pages.map((p) => DOC_SLUGS.indexOf(p.slug as (typeof DOC_SLUGS)[number]));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions).not.toContain(-1); // no chapter outside the declared list
  });

  it("reads the title from the leading heading and strips it from the body", async () => {
    const [first] = await loadDocs("en");
    expect(first.slug).toBe("getting-started");
    expect(first.title).toBe("Getting started");
    // The reader renders the title itself: it must not appear twice.
    expect(first.markdown.startsWith("#")).toBe(false);
    expect(first.markdown).not.toContain("# Getting started");
  });

  it("every chapter of every language has a title", async () => {
    // Guards the next chapters: a file added without a leading `# ` would fall
    // back to its slug in the sidebar, which nobody would notice in review.
    for (const lang of LANGUAGES) {
      for (const page of await loadDocs(lang)) {
        expect(page.title, `${lang}/${page.slug}`).not.toBe(page.slug);
        expect(page.title.length, `${lang}/${page.slug}`).toBeGreaterThan(2);
        expect(page.markdown.length, `${lang}/${page.slug}`).toBeGreaterThan(200);
      }
    }
  });

  it("falls back to English for a chapter that is not translated yet", async () => {
    // Same chapter list in every language: a missing translation is served in
    // English rather than hidden, so no content disappears.
    const en = (await loadDocs("en")).map((p) => p.slug);
    for (const lang of LANGUAGES) {
      expect((await loadDocs(lang)).map((p) => p.slug), lang).toEqual(en);
    }
  });
});
