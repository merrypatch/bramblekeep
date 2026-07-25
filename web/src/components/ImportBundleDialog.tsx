import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import { toast } from "sonner";

import { getItem } from "@/lib/api";
import { parseSchema } from "@/lib/db";
import { applyBundleImport, planBundleImport, readBundle, type BundleImportPlan } from "@/lib/bundle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful import (parent refreshes the view + sidebar). */
  onImported: () => void;
};

/** Merge import into an existing database: pick a bundle (ZIP), review what will
 * happen (root table merged into this db, related tables created fresh), then
 * confirm. Nothing is written before confirmation. */
export function ImportBundleDialog({ itemId, open, onOpenChange, onImported }: Props) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<BundleImportPlan | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setPlan(null);
    setBusy(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function onPick(file: File) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = readBundle(bytes);
      const meta = await getItem(itemId);
      setPlan(planBundleImport(parseSchema(meta.db_schema), parsed));
    } catch {
      toast.error(t("importBundle.readFailed"));
    }
  }

  async function onImport() {
    if (!plan) return;
    setBusy(true);
    try {
      const { dbs, rows } = await applyBundleImport(itemId, {
        manifest: plan.manifest,
        csvByName: plan.csvByName,
      });
      toast.success(t("importBundle.done", { rows, dbs }));
      onImported();
      onOpenChange(false);
      reset();
    } catch {
      toast.error(t("importBundle.failed"));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("importBundle.title")}</DialogTitle>
          <DialogDescription>{t("importBundle.description")}</DialogDescription>
        </DialogHeader>

        {!plan ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPick(f);
              }}
            />
            <Button variant="outline" onClick={() => fileInput.current?.click()}>
              <Upload className="size-4" /> {t("importBundle.pick")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            {/* Root → current database. */}
            <div className="rounded-md border p-3">
              <p className="font-medium">
                {t("importBundle.intoLabel")} — {plan.rootTitle}
              </p>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                <li>{t("importBundle.rootSummary", { count: plan.rootRowCount })}</li>
                {plan.addedColumns.length > 0 && (
                  <li>
                    {t("importBundle.addedColumns", { count: plan.addedColumns.length })}
                    {": "}
                    {plan.addedColumns.map((c) => c.name).join(", ")}
                  </li>
                )}
                {plan.reusedColumnNames.length > 0 && (
                  <li>{t("importBundle.reusedColumns", { count: plan.reusedColumnNames.length })}</li>
                )}
              </ul>
            </div>

            {/* Related tables → fresh databases. */}
            <div className="rounded-md border p-3">
              {plan.linkedDbs.length === 0 ? (
                <p className="text-muted-foreground">{t("importBundle.noLinked")}</p>
              ) : (
                <>
                  <p className="font-medium">
                    {t("importBundle.linkedTitle", { count: plan.linkedDbs.length })}
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                    {plan.linkedDbs.map((d, i) => (
                      <li key={i}>
                        {d.title || t("common.untitled")} —{" "}
                        {t("importBundle.linkedRows", { count: d.rowCount })}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void onImport()} disabled={!plan || busy}>
            {busy ? t("importBundle.importing") : t("importBundle.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
