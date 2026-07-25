import { Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ItemIcon } from "@/components/ItemIcon";
import { getBacklinks, type Backlink } from "@/lib/api";

/**
 * "Linked references": the accessible pages that reference this item (incoming
 * links, from `page`/`dbview` blocks). Rendered below a page's content. Hidden
 * when there are none. `refreshKey` lets the parent force a re-fetch.
 */
export function BacklinksPanel({
  itemId,
  onOpen,
  refreshKey,
}: {
  itemId: string;
  onOpen: (id: string) => void;
  refreshKey?: number;
}) {
  const { t } = useTranslation();
  const [links, setLinks] = useState<Backlink[]>([]);

  useEffect(() => {
    let alive = true;
    setLinks([]);
    getBacklinks(itemId)
      .then((l) => alive && setLinks(l))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [itemId, refreshKey]);

  if (links.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-8 pb-16">
      <div className="mb-2 flex items-center gap-1.5 border-t pt-4 text-sm font-medium text-muted-foreground">
        <Link2 className="size-3.5" />
        {t("backlinks.title", { count: links.length })}
      </div>
      <ul className="space-y-0.5">
        {links.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              onClick={() => onOpen(l.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
            >
              <ItemIcon icon={l.icon} kind="page" size={16} className="shrink-0" />
              <span className="truncate">{l.title || t("common.untitled")}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
