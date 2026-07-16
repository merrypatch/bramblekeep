import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ItemIcon } from "@/components/ItemIcon";
import { Input } from "@/components/ui/input";
import type { ItemMeta } from "@/lib/api";

/**
 * Dedicated page: free browsing of everything the user has access to (the same
 * set as the sidebar, without the cap). Reuses `items` (listItems), no dedicated
 * request. Search by title + parent context to find your way around the tree.
 */
export function AllPages({
  items,
  onSelect,
}: {
  items: ItemMeta[];
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const sorted = useMemo(
    () =>
      [...items].sort((a, b) =>
        (a.title || "￿").localeCompare(b.title || "￿", undefined, { sensitivity: "base" }),
      ),
    [items],
  );

  const query = q.trim().toLowerCase();
  const shown = query
    ? sorted.filter((it) => (it.title ?? "").toLowerCase().includes(query))
    : sorted;

  const parentTitle = (it: ItemMeta): string | null => {
    if (!it.parent_item_id) return null;
    const p = byId.get(it.parent_item_id);
    return p ? p.title || t("common.untitled") : null;
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t("allPages.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("allPages.count", { count: items.length })}
        </p>
      </div>

      <div className="relative mb-6">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("allPages.search")}
          className="pl-9"
          autoFocus
        />
      </div>

      {items.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("allPages.empty")}</p>
      ) : shown.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("allPages.noMatch")}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((it) => {
            const parent = parentTitle(it);
            return (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => onSelect(it.id)}
                  className="flex h-full w-full items-start gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent"
                >
                  <ItemIcon
                    icon={it.icon}
                    kind={it.db_schema ? "database" : "page"}
                    size={20}
                    className="mt-0.5 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {it.title || t("common.untitled")}
                    </span>
                    {/* Parent line always rendered (placeholder if root) to keep
                        an identical card height for parent/child. */}
                    <span className="block truncate text-xs text-muted-foreground">
                      {parent ?? " "}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
