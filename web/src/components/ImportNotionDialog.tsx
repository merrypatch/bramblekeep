import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { applyNotionImport, type ImportProgress } from "@/lib/notionApply";
import { looksLikeNotionExport, planNotionImport, type NotionPlan } from "@/lib/notionImport";
import { unzipAll } from "@/lib/zip";

type Props = {
  /** Page the import lands under; omitted = at the root of the tree. */
  parentId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
};

/** Imports a Notion export (Markdown & CSV) as pages.
 *
 * Plan first, apply second — the same shape as the database bundle import, and
 * for the same reason: an import that turns out to be the wrong archive is a
 * workspace someone has to clean up by hand, so the count of pages and what is
 * being left behind are shown before anything is created. */
export function ImportNotionDialog({ parentId, open, onOpenChange, onImported }: Props) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<NotionPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const reset = () => {
    setPlan(null);
    setProgress(null);
    if (picker.current) picker.current.value = "";
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const files = await unzipAll(new Uint8Array(await file.arrayBuffer()));
      if (!looksLikeNotionExport(files)) {
        toast.error(t("notion.notAnExport"));
        return;
      }
      const p = planNotionImport(files);
      if (p.pageCount === 0) {
        toast.error(t("notion.noPages"));
        return;
      }
      setPlan(p);
    } catch {
      toast.error(t("notion.unreadable"));
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  };

  const run = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const result = await applyNotionImport(plan.roots, parentId, setProgress);
      if (result.failed.length > 0) {
        toast.warning(
          t("notion.donePartial", { count: result.created, failed: result.failed.length }),
        );
      } else {
        toast.success(t("notion.done", { count: result.created }));
      }
      onImported();
      onOpenChange(false);
      reset();
    } catch {
      toast.error(t("notion.failed"));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // No dismissing mid-import: pages are being created as we speak.
        if (busy && progress) return;
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("notion.title")}</DialogTitle>
          <DialogDescription>{t("notion.intro")}</DialogDescription>
        </DialogHeader>

        {!plan && (
          <>
            <input
              ref={picker}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            <Button variant="outline" disabled={busy} onClick={() => picker.current?.click()}>
              {busy ? t("notion.reading") : t("notion.choose")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("notion.howTo")}</p>
          </>
        )}

        {plan && !progress && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
              <dt className="text-muted-foreground">{t("notion.pages")}</dt>
              <dd>{plan.pageCount}</dd>
              <dt className="text-muted-foreground">{t("notion.topLevel")}</dt>
              <dd className="truncate">
                {plan.roots.map((r) => r.title).slice(0, 3).join(", ")}
                {plan.roots.length > 3 && ` +${plan.roots.length - 3}`}
              </dd>
            </dl>
            {(plan.skipped.databases > 0 || plan.skipped.attachments > 0) && (
              <p className="text-xs text-muted-foreground">
                {t("notion.skipped", {
                  databases: plan.skipped.databases,
                  attachments: plan.skipped.attachments,
                })}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={reset} disabled={busy}>
                {t("notion.back")}
              </Button>
              <Button onClick={() => void run()} disabled={busy}>
                {t("notion.import", { count: plan.pageCount })}
              </Button>
            </DialogFooter>
          </>
        )}

        {progress && (
          <div className="space-y-2">
            <p className="text-sm">
              {t("notion.progress", { done: progress.done, total: progress.total })}
            </p>
            <p className="truncate text-xs text-muted-foreground">{progress.title}</p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
