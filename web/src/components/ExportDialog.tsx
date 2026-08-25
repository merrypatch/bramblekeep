import { useState } from "react";
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
import { exportDbBundle } from "@/lib/bundle";
import { exportCsv, exportMarkdown } from "@/lib/export";
import { cn } from "@/lib/utils";

type Format = "markdown" | "pdf" | "csv" | "bundle";

type Props = {
  itemId: string;
  /** Databases can also be exported as rows, and with their relations. */
  isDatabase: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** One export, with the format asked for rather than assumed.
 *
 * This replaces four menu entries that each fired on click. Four verbs in a
 * menu is not a choice offered, it is a choice imposed on the reader — and
 * "Export with relations (ZIP)" is not something anyone decides while scanning
 * a dropdown. The formats are the same; they are now read side by side, with
 * a line saying what each one is for, and nothing happens until Export. */
export function ExportDialog({ itemId, isDatabase, open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<Format>("markdown");
  const [busy, setBusy] = useState(false);

  const formats: { id: Format; title: string; body: string }[] = [
    { id: "markdown", title: t("exportDialog.md"), body: t("exportDialog.mdBody") },
    { id: "pdf", title: t("exportDialog.pdf"), body: t("exportDialog.pdfBody") },
    ...(isDatabase
      ? ([
          { id: "csv", title: t("exportDialog.csv"), body: t("exportDialog.csvBody") },
          { id: "bundle", title: t("exportDialog.bundle"), body: t("exportDialog.bundleBody") },
        ] as const)
      : []),
  ];

  const run = async () => {
    setBusy(true);
    try {
      if (format === "markdown") await exportMarkdown(itemId);
      else if (format === "csv") await exportCsv(itemId);
      else if (format === "bundle") await exportDbBundle(itemId);
      else {
        // Printing has to happen after the dialog is gone, or the dialog is what
        // gets printed.
        onOpenChange(false);
        setTimeout(() => window.print(), 0);
        return;
      }
      onOpenChange(false);
    } catch {
      toast.error(t("exportDialog.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("exportDialog.title")}</DialogTitle>
          <DialogDescription>{t("exportDialog.intro")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {formats.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFormat(f.id)}
              className={cn(
                "flex w-full flex-col items-start rounded-md border p-3 text-left transition-colors",
                format === f.id ? "border-primary bg-accent" : "hover:bg-accent/50",
              )}
            >
              <span className="text-sm font-medium">{f.title}</span>
              <span className="text-xs text-muted-foreground">{f.body}</span>
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void run()} disabled={busy}>
            {t("exportDialog.action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
