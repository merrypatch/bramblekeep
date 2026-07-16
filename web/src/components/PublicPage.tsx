import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  getPublicDoc,
  getPublicItem,
  getPublicPage,
  publicFileUrl,
  type PublicItemMeta,
  type PublicNavItem,
} from "@/lib/api";
import { publicSchema } from "@/lib/publicSchema";
import { PageSkeleton } from "@/components/ui/skeletons";
import { FRAGMENT } from "@/lib/sync";
import { useIsDark } from "@/lib/theme";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Path root → current page, rebuilt from the published set (walks up
 * `parent_item_id` as long as we stay within scope). Empty/single element if we
 * are on the root. */
function buildTrail(pages: PublicNavItem[], currentId: string): PublicNavItem[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const trail: PublicNavItem[] = [];
  const seen = new Set<string>();
  let cur = byId.get(currentId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    trail.unshift(cur);
    cur = cur.parent_item_id ? byId.get(cur.parent_item_id) : undefined;
  }
  return trail;
}

/** Breadcrumb: each ancestor is a link to its public URL; the current
 * page (last) is inert. The root points to `/public/{token}`. */
function Breadcrumb({
  token,
  trail,
}: {
  token: string;
  trail: PublicNavItem[];
}) {
  if (trail.length < 2) return null;
  return (
    <nav className="mb-4 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      {trail.map((p, i) => {
        const last = i === trail.length - 1;
        const label = `${p.icon ? `${p.icon} ` : ""}${p.title || "Sans titre"}`;
        const href = i === 0 ? `/public/${token}` : `/public/${token}/${p.id}`;
        return (
          <span key={p.id} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 shrink-0" />}
            {last ? (
              <span className="font-medium text-foreground">{label}</span>
            ) : (
              <a href={href} className="hover:text-foreground hover:underline">
                {label}
              </a>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** Read-only rendering of a public page. The Yjs doc is created and hydrated PER
 * INSTANCE (`useState`), never shared: two mounts (e.g. StrictMode in dev)
 * each get their own doc → no y-prosemirror double-binding on the same
 * fragment (source of a sync loop). Local awareness, no WebSocket. */
function PublicRender({
  token,
  meta,
  bytes,
  pages,
}: {
  token: string;
  meta: PublicItemMeta;
  bytes: Uint8Array;
  pages: PublicNavItem[];
}) {
  const [doc] = useState(() => {
    const d = new Y.Doc();
    Y.applyUpdate(d, bytes);
    return d;
  });
  const [awareness] = useState(() => new Awareness(doc));
  const dark = useIsDark();
  useEffect(
    () => () => {
      awareness.destroy();
      doc.destroy();
    },
    [awareness, doc],
  );

  const editor = useCreateBlockNote(
    {
      schema: publicSchema,
      collaboration: {
        fragment: doc.getXmlFragment(FRAGMENT),
        user: { name: "", color: "#888888" },
        provider: { awareness },
      },
    },
    [doc],
  );

  return (
    <div className="mx-auto min-h-dvh w-full max-w-4xl px-4 py-10 sm:px-8">
      <Breadcrumb token={token} trail={buildTrail(pages, meta.id)} />
      {meta.cover && (
        <img
          src={publicFileUrl(token, meta.cover)}
          alt=""
          className="mb-6 h-48 w-full rounded-lg object-cover"
        />
      )}
      <h1 className="mb-6 flex items-center gap-2 text-3xl font-bold tracking-tight">
        {meta.icon && <span>{meta.icon}</span>}
        <span>{meta.title || "Sans titre"}</span>
      </h1>
      <BlockNoteView
        editor={editor}
        editable={false}
        theme={dark ? "dark" : "light"}
        className="bk-editor"
      />
    </div>
  );
}

/** Public page: read without login via `/public/{token}` (root) or
 * `/public/{token}/{itemId}` (sub-page within scope). NEVER mounts the Shell
 * nor the WebSocket sync: meta + Yjs doc state, read-only rendering, breadcrumb
 * to navigate within the published set. */
export function PublicPage() {
  const { t } = useTranslation();
  const parts = window.location.pathname.split("/").filter(Boolean); // ["public", token, itemId?]
  const token = parts[1] ?? "";
  const itemId = parts[2];

  const [status, setStatus] = useState<"loading" | "error" | "ok">("loading");
  const [meta, setMeta] = useState<PublicItemMeta | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [pages, setPages] = useState<PublicNavItem[]>([]);

  useEffect(() => {
    let alive = true;
    setStatus("loading");
    setMeta(null);
    setBytes(null);
    (async () => {
      try {
        // Always the root (navigation set) + the requested page.
        const page = await getPublicPage(token);
        const m = itemId ? (await getPublicItem(token, itemId)).item : page.item;
        const b = await getPublicDoc(token, itemId ?? page.root_id);
        if (!alive) return;
        setPages(page.pages);
        setMeta(m);
        setBytes(b);
        setStatus("ok");
      } catch {
        if (alive) setStatus("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, itemId]);

  if (status === "loading")
    return (
      <div className="min-h-dvh bg-background">
        <PageSkeleton />
      </div>
    );
  if (status === "error" || !meta || !bytes) {
    return <Centered>{t("page.publicNotFound")}</Centered>;
  }
  return <PublicRender key={meta.id} token={token} meta={meta} bytes={bytes} pages={pages} />;
}
