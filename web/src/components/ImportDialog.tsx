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
import { applyMdImport, type ImportProgress } from "@/lib/mdApply";
import { hasMarkdown, planMdImport, type MdPlan } from "@/lib/mdImport";
import { cn } from "@/lib/utils";
import { unzipAll } from "@/lib/zip";

type Source = "markdown" | "csv" | "bundle";

type Props = {
  /** Page the import lands under. Markdown pages are created below it. */
  itemId: string;
  isDatabase: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hands off to the existing single-table CSV flow. */
  onPickCsv: () => void;
  /** Hands off to the existing relation-preserving bundle flow. */
  onPickBundle: () => void;
  onImported: () => void;
};

/** One import, with the source asked for rather than guessed from which menu
 * entry was clicked.
 *
 * The Markdown source is handled here, start to finish: an archive is read, a
 * plan is shown — how many pages, what is being left behind — and only then are
 * pages created. CSV and relation bundles hand off to the flows that already
 * exist, which have their own column mapping and remapping to do. */
export function ImportDialog({
  itemId,
  isDatabase,
  open,
  onOpenChange,
  onPickCsv,
  onPickBundle,
  onImported,
}: Props) {
  const { t } = useTranslation();
  const [source, setSource] = useState<Source>("markdown");
  const [plan, setPlan] = useState<MdPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const sources: { id: Source; title: string; body: string }[] = [
    { id: "markdown", title: t("importDialog.md"), body: t("importDialog.mdBody") },
    ...(isDatabase
      ? ([
          { id: "csv", title: t("importDialog.csv"), body: t("importDialog.csvBody") },
          { id: "bundle", title: t("importDialog.bundle"), body: t("importDialog.bundleBody") },
        ] as const)
      : []),
  ];

  const reset = () => {
    setPlan(null);
    setProgress(null);
    if (picker.current) picker.current.value = "";
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const readArchive = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const files = await unzipAll(new Uint8Array(await file.arrayBuffer()));
      if (!hasMarkdown(files)) {
        toast.error(t("importDialog.noMarkdown"));
        return;
      }
      const p = planMdImport(files);
      if (p.pageCount === 0) {
        toast.error(t("importDialog.noMarkdown"));
        return;
      }
      setPlan(p);
    } catch {
      toast.error(t("importDialog.unreadable"));
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  };

  const runMarkdown = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const result = await applyMdImport(plan.roots, itemId, setProgress);
      if (result.failed.length > 0) {
        toast.warning(
          t("importDialog.donePartial", { count: result.created, failed: result.failed.length }),
        );
      } else {
        toast.success(t("importDialog.done", { count: result.created }));
      }
      onImported();
      close();
    } catch {
      toast.error(t("importDialog.failed"));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const proceed = () => {
    if (source === "csv") {
      onOpenChange(false);
      onPickCsv();
    } else if (source === "bundle") {
      onOpenChange(false);
      onPickBundle();
    } else {
      picker.current?.click();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Pages are being created; there is nothing useful to go back to.
        if (progress) return;
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("importDialog.title")}</DialogTitle>
          <DialogDescription>{t("importDialog.intro")}</DialogDescription>
        </DialogHeader>

        <input
          ref={picker}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => void readArchive(e.target.files?.[0])}
        />

        {!plan && !progress && (
          <>
            <div className="space-y-2">
              {sources.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSource(s.id)}
                  className={cn(
                    "flex w-full flex-col items-start rounded-md border p-3 text-left transition-colors",
                    source === s.id ? "border-primary bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <span className="text-sm font-medium">{s.title}</span>
                  <span className="text-xs text-muted-foreground">{s.body}</span>
                </button>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button onClick={proceed} disabled={busy}>
                {busy ? t("importDialog.reading") : t("importDialog.choose")}
              </Button>
            </DialogFooter>
          </>
        )}

        {plan && !progress && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
              <dt className="text-muted-foreground">{t("importDialog.pages")}</dt>
              <dd>{plan.pageCount}</dd>
              <dt className="text-muted-foreground">{t("importDialog.topLevel")}</dt>
              <dd className="truncate">
                {plan.roots.slice(0, 3).map((r) => r.title).join(", ")}
                {plan.roots.length > 3 && ` +${plan.roots.length - 3}`}
              </dd>
            </dl>
            {(plan.skipped.databases > 0 || plan.skipped.attachments > 0) && (
              <p className="text-xs text-muted-foreground">
                {t("importDialog.skipped", {
                  databases: plan.skipped.databases,
                  attachments: plan.skipped.attachments,
                })}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={reset} disabled={busy}>
                {t("importDialog.back")}
              </Button>
              <Button onClick={() => void runMarkdown()} disabled={busy}>
                {t("importDialog.import", { count: plan.pageCount })}
              </Button>
            </DialogFooter>
          </>
        )}

        {progress && (
          <div className="space-y-2">
            <p className="text-sm">
              {t("importDialog.progress", { done: progress.done, total: progress.total })}
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
