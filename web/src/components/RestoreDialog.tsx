import { useEffect, useRef, useState } from "react";
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
import { ApiError, applyRestore, cancelRestore, getVersion, type BackupManifest } from "@/lib/api";

type Phase = "confirm" | "restarting" | "done" | "error";

/** Confirms and applies a restore that has already been staged and vetted by the
 * server.
 *
 * Two things make this different from every other dialog here. It replaces the
 * database that holds the session running it, so the instance restarts and the
 * swap happens on the way back up — waiting for the server to answer again is
 * part of the flow, not an error. And it is destructive, so the summary of what
 * the archive holds is shown BEFORE the button that applies it, not after. */
export function RestoreDialog({
  manifest,
  open,
  onCancelled,
}: {
  manifest: BackupManifest;
  open: boolean;
  onCancelled: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<Phase>("confirm");
  const timer = useRef<number | null>(null);

  const clear = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  // The instance is restarting: /version failing IS the expected middle of this,
  // so only a long silence counts as a failure.
  useEffect(() => {
    if (phase !== "restarting") return;
    let alive = true;
    let waited = 0;
    timer.current = window.setInterval(() => {
      waited += 1500;
      getVersion()
        .then(() => {
          if (alive) setPhase("done");
        })
        .catch(() => {
          if (alive && waited > 90_000) setPhase("error");
        });
    }, 1500);
    return () => {
      alive = false;
      clear();
    };
  }, [phase]);

  const confirm = async () => {
    try {
      await applyRestore();
      setPhase("restarting");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("restore.applyFailed"));
      setPhase("error");
    }
  };

  const discard = async () => {
    try {
      await cancelRestore();
    } catch {
      // Staged file already gone, or the server is unreachable: either way the
      // owner asked to back out, so let them.
    }
    onCancelled();
  };

  const taken = new Date(manifest.created_ts).toLocaleString(i18n.language);
  const size = `${(manifest.db_bytes / 1024 / 1024).toFixed(1)} MB`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && phase === "confirm" && void discard()}>
      <DialogContent
        // No stray dismissal once the instance is on its way down: there is
        // nothing to go back to until it answers again.
        onInteractOutside={(e) => phase !== "confirm" && e.preventDefault()}
        onEscapeKeyDown={(e) => phase !== "confirm" && e.preventDefault()}
      >
        {phase === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("restore.confirmTitle")}</DialogTitle>
              <DialogDescription>{t("restore.confirmBody")}</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
              <dt className="text-muted-foreground">{t("restore.taken")}</dt>
              <dd>{taken}</dd>
              <dt className="text-muted-foreground">{t("restore.version")}</dt>
              <dd>{manifest.app_version}</dd>
              <dt className="text-muted-foreground">{t("restore.contents")}</dt>
              <dd>{t("restore.contentsValue", { size, count: manifest.file_count })}</dd>
            </dl>
            <p className="text-xs text-muted-foreground">{t("restore.keptNote")}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => void discard()}>
                {t("restore.cancel")}
              </Button>
              <Button variant="destructive" onClick={() => void confirm()}>
                {t("restore.apply")}
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === "restarting" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("restore.restarting")}</DialogTitle>
              <DialogDescription>{t("restore.restartingBody")}</DialogDescription>
            </DialogHeader>
          </>
        )}

        {phase === "done" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("restore.done")}</DialogTitle>
              <DialogDescription>{t("restore.doneBody")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => window.location.reload()}>{t("restore.reload")}</Button>
            </DialogFooter>
          </>
        )}

        {phase === "error" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("restore.stuck")}</DialogTitle>
              <DialogDescription>{t("restore.stuckBody")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => window.location.reload()}>
                {t("restore.reload")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
