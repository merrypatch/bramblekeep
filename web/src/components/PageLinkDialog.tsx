import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ItemIcon } from "@/components/ItemIcon";
import { Input } from "@/components/ui/input";
import { listItems, type ItemMeta } from "@/lib/api";

/** Picker of an existing page to insert a link (`page` block). Creates nothing
 * and doesn't modify the tree — it's just a reference. */
export function PageLinkDialog({
  open,
  onOpenChange,
  excludeId,
  dbOnly,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excludeId: string;
  /** List only databases (to insert an existing inline database). */
  dbOnly?: boolean;
  onPick: (page: ItemMeta) => void;
}) {
  const { t } = useTranslation();
  const [pages, setPages] = useState<ItemMeta[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    setQ("");
    listItems()
      .then(setPages)
      .catch(() => setPages([]));
  }, [open]);

  const needle = q.trim().toLowerCase();
  const filtered = pages.filter(
    (p) =>
      p.id !== excludeId &&
      (!dbOnly || p.db_schema != null) &&
      (p.title || t("common.untitled")).toLowerCase().includes(needle),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dbOnly ? t("pageLinkDialog.titleDb") : t("pageLinkDialog.titlePage")}</DialogTitle>
          <DialogDescription>
            {dbOnly ? t("pageLinkDialog.descDb") : t("pageLinkDialog.descPage")}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={dbOnly ? t("pageLinkDialog.searchDb") : t("pageLinkDialog.searchPage")}
        />
        <ul className="max-h-72 space-y-0.5 overflow-auto">
          {filtered.length === 0 ? (
            <li className="px-2 py-1 text-sm text-muted-foreground">{dbOnly ? t("pageLinkDialog.emptyDb") : t("pageLinkDialog.emptyPage")}</li>
          ) : (
            filtered.map((p) => (
              <li key={p.id}>
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => onPick(p)}
                >
                  <ItemIcon
                    icon={p.icon}
                    kind={p.db_schema ? "database" : "page"}
                    size={16}
                    className="shrink-0"
                  />
                  <span className="truncate">{p.title || t("common.untitled")}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
