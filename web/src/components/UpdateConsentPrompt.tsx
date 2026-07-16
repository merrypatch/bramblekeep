import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getUpdateConsent, setUpdateConsent, type Role } from "@/lib/api";

/**
 * Asks, on first launch (`unset` state), for consent to check for updates. An
 * explicit opt-in makes the network call "requested" (the "zero unrequested
 * outgoing calls" principle), after which the check is automatic. Reserved for
 * admins/owner (installation setting); silent for everyone else.
 */
export function UpdateConsentPrompt({ role }: { role: Role }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (role !== "owner" && role !== "admin") return;
    let alive = true;
    getUpdateConsent()
      .then((r) => alive && r.consent === "unset" && setOpen(true))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [role]);

  const decide = (value: "on" | "off") => {
    setOpen(false);
    void setUpdateConsent(value).catch(() => {});
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && decide("off")}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("updateConsent.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("updateConsent.body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => decide("off")}>
            {t("updateConsent.decline")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => decide("on")}>
            {t("updateConsent.accept")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
