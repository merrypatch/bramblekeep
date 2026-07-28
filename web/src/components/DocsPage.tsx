import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { BookOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

import { PageSkeleton } from "@/components/ui/skeletons";
import i18n, { isLanguage, DEFAULT_LANGUAGE } from "@/i18n";
import { type DocPage, loadDocs } from "@/lib/docs";
import { editorSchema } from "@/lib/editorSchema";
import { useIsDark } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Built-in documentation reader. Content ships with the binary (cf. `lib/docs`),
 * so it always matches the running version and every member can read it without
 * anything being shared with them.
 *
 * Rendering reuses the editor we already have, in read-only mode: BlockNote
 * parses the markdown itself, so no markdown renderer is added to the bundle and
 * a doc page looks exactly like a real page.
 */
export function DocsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { slug } = useParams();
  const [pages, setPages] = useState<DocPage[] | null>(null);

  // Docs follow the UI language, with an English fallback per chapter.
  const lang = isLanguage(i18n.language) ? i18n.language : DEFAULT_LANGUAGE;
  useEffect(() => {
    let alive = true;
    loadDocs(lang)
      .then((p) => alive && setPages(p))
      .catch(() => alive && setPages([]));
    return () => {
      alive = false;
    };
  }, [lang]);

  if (!pages) return <PageSkeleton />;
  if (pages.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">{t("docs.empty")}</p>;
  }

  const current = pages.find((p) => p.slug === slug) ?? pages[0];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:flex-row sm:p-6">
      {/* Table of contents. Above the content on mobile (mobile-first), a column
          on the side from `sm` up. */}
      <nav className="shrink-0 sm:w-56">
        <h2 className="mb-2 flex items-center gap-1.5 px-2 text-sm font-semibold">
          <BookOpen className="size-4" /> {t("docs.title")}
        </h2>
        <ul className="space-y-0.5">
          {pages.map((p) => (
            <li key={p.slug}>
              <button
                type="button"
                onClick={() => navigate(`/docs/${p.slug}`)}
                className={cn(
                  "w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                  p.slug === current.slug && "bg-accent font-medium",
                )}
              >
                {p.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <article className="min-w-0 flex-1">
        <h1 className="mb-4 text-3xl font-bold tracking-tight">{current.title}</h1>
        {/* `key`: a fresh editor per chapter — a BlockNote instance is not meant
            to swap its whole document on navigation. */}
        <DocBody key={current.slug} markdown={current.markdown} />
      </article>
    </div>
  );
}

/** One chapter, parsed from markdown into the read-only editor. */
function DocBody({ markdown }: { markdown: string }) {
  const dark = useIsDark();
  const editor = useCreateBlockNote({ schema: editorSchema });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Synchronous in BlockNote 0.51; a malformed chapter must show the reader
    // rather than a blank pane, hence the guard.
    try {
      const blocks = editor.tryParseMarkdownToBlocks(markdown);
      if (blocks.length > 0) editor.replaceBlocks(editor.document, blocks);
    } catch {
      /* keep whatever parsed, reveal the pane below */
    }
    setReady(true);
  }, [editor, markdown]);

  return (
    <div className={cn("transition-opacity", ready ? "opacity-100" : "opacity-0")}>
      <BlockNoteView
        editor={editor}
        editable={false}
        theme={dark ? "dark" : "light"}
        className="bk-editor bk-docs"
        // Read-only: none of the editing affordances make sense here.
        slashMenu={false}
        sideMenu={false}
        formattingToolbar={false}
        filePanel={false}
        linkToolbar={false}
      />
    </div>
  );
}
