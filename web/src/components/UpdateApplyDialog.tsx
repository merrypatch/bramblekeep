import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { applyUpdate, getApplyStatus, getVersion } from "@/lib/api";

type Phase = "confirm" | "running" | "restarting" | "done" | "error";

/** Server steps → i18n label key. */
const STEP_KEYS = {
  downloading: "updateApply.step.downloading",
  verifying: "updateApply.step.verifying",
  backing_up: "updateApply.step.backingUp",
  pulling: "updateApply.step.pulling",
  swapping: "updateApply.step.swapping",
  restarting: "updateApply.step.restarting",
} as const;
function stepKey(step: string): (typeof STEP_KEYS)[keyof typeof STEP_KEYS] {
  return STEP_KEYS[step as keyof typeof STEP_KEYS] ?? STEP_KEYS.downloading;
}

/**
 * Applies an update: confirmation + disclaimer, then live tracking (poll status),
 * then restart detection (poll /version until the target version). Replacing the
 * binary is irreversible and interrupts the service → active confirmation
 * required (cf. the auto-update design notes, D6).
 */
export function UpdateApplyDialog({
  open,
  onOpenChange,
  targetVersion,
  container = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  targetVersion: string;
  /** Managed container path (Watchtower pulls the image) vs. binary self-replace. */
  container?: boolean;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("confirm");
  const [step, setStep] = useState<string>("downloading");
  const [error, setError] = useState<string>("");
  const timer = useRef<number | null>(null);

  const clear = () => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };

  // Resets on every open.
  useEffect(() => {
    if (open) {
      setPhase("confirm");
      setStep("downloading");
      setError("");
    } else {
      clear();
    }
  }, [open]);

  // Tracks the apply: poll status; a status failure = server restarting.
  useEffect(() => {
    if (phase !== "running") return;
    let alive = true;
    timer.current = window.setInterval(() => {
      getApplyStatus()
        .then((s) => {
          if (!alive) return;
          if (s.step === "failed") {
            setError(s.error ?? "failed");
            setPhase("error");
          } else if (s.step === "restarting") {
            setPhase("restarting");
          } else {
            setStep(s.step);
          }
        })
        .catch(() => {
          // Status no longer responds → the binary was replaced and is restarting.
          if (alive) setPhase("restarting");
        });
    }, 1000);
    return () => {
      alive = false;
      clear();
    };
  }, [phase]);

  // Detects the end of the restart: /version returns the target version.
  useEffect(() => {
    if (phase !== "restarting") return;
    let alive = true;
    let waited = 0;
    timer.current = window.setInterval(() => {
      waited += 1500;
      getVersion()
        .then((v) => {
          if (alive && v === targetVersion) setPhase("done");
        })
        .catch(() => {
          // server still down during the restart → keep waiting
          if (alive && waited > 90_000) {
            setError("restart-timeout");
            setPhase("error");
          }
        });
    }, 1500);
    return () => {
      alive = false;
      clear();
    };
  }, [phase, targetVersion]);

  const confirm = async () => {
    setPhase("running");
    try {
      const r = await applyUpdate();
      if (!r.started) {
        setError(r.error ?? "refused");
        setPhase("error");
      }
    } catch {
      setError("network");
      setPhase("error");
    }
  };

  // Prevents closing during the operation (irreversible in progress).
  const locked = phase === "running" || phase === "restarting";

  return (
    <Dialog open={open} onOpenChange={(o) => !locked && onOpenChange(o)}>
      <DialogContent>
        {phase === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("updateApply.confirmTitle", { version: targetVersion })}</DialogTitle>
              <DialogDescription>
                {t(container ? "updateApply.disclaimerContainer" : "updateApply.disclaimer")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void confirm()}>{t("updateApply.confirm")}</Button>
            </DialogFooter>
          </>
        )}

        {(phase === "running" || phase === "restarting") && (
          <>
            <DialogHeader>
              <DialogTitle>{t("updateApply.applying")}</DialogTitle>
              <DialogDescription>
                {phase === "restarting"
                  ? t("updateApply.step.restarting")
                  : t(stepKey(step))}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {t("updateApply.doNotClose")}
            </div>
          </>
        )}

        {phase === "done" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("updateApply.done", { version: targetVersion })}</DialogTitle>
              <DialogDescription>{t("updateApply.doneBody")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => window.location.reload()}>{t("updateApply.reload")}</Button>
            </DialogFooter>
          </>
        )}

        {phase === "error" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("updateApply.failed")}</DialogTitle>
              <DialogDescription className="break-words">{error}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
