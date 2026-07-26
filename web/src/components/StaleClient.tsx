import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/brand";
import { BUILD_VERSION, healAndReload } from "@/lib/freshness";

/**
 * Blocking screen for a client whose bundle is not the one this server ships,
 * and which survived the automatic repair (cf. `hooks/useFreshness`).
 *
 * Deliberately NOT code-split: a stale service worker serves its own precache,
 * which does not contain today's chunks — a lazy import here could fail exactly
 * when it is needed. It also stays free of any CRDT import: the whole point is
 * that nothing touching the Yjs document mounts.
 */
export function StaleClient({ serverVersion }: { serverVersion: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="dot-grid flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="font-brand text-4xl font-bold tracking-tight">{APP_NAME}</h1>
        <h2 className="text-lg font-medium">{t("stale.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("stale.body")}</p>
        <Button
          className="w-full"
          onClick={() => {
            void healAndReload();
          }}
        >
          {t("stale.reload")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("stale.hint")}</p>
        <p className="text-xs text-muted-foreground/70">
          {t("stale.versions", { build: BUILD_VERSION || "?", server: serverVersion ?? "?" })}
        </p>
      </div>
    </div>
  );
}
