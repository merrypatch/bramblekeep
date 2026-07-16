import { createContext, useCallback, useContext, useRef, useState } from "react";
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
import { getItem } from "@/lib/api";

/** Guard function: to call BEFORE creating a sub-page under `parentId`.
 * Resolves `true` if we can continue. If the parent is published on the web,
 * shows a consent first (the sub-page will become public); otherwise passes through. */
type ConfirmPublicChild = (parentId: string | null | undefined) => Promise<boolean>;

const ConsentCtx = createContext<ConfirmPublicChild>(async () => true);

/** Hook for components that create sub-pages (editor, sidebar). */
export function useConfirmPublicChild(): ConfirmPublicChild {
  return useContext(ConsentCtx);
}

/** Provides the "sub-page of a published page" consent (option 4). Mounted once
 * high in the tree; the backend PROPAGATES publication on creation, this
 * dialog ensures the user is informed of it and accepts it beforehand. */
export function PublishConsentProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const settle = useCallback((v: boolean) => {
    setOpen(false);
    const r = resolver.current;
    resolver.current = null;
    r?.(v);
  }, []);

  const confirm = useCallback<ConfirmPublicChild>(async (parentId) => {
    if (!parentId) return true; // root page: no public inheritance
    let isPublic: boolean;
    try {
      isPublic = (await getItem(parentId)).is_public ?? false;
    } catch {
      isPublic = false; // indeterminate status → does not block creation
    }
    if (!isPublic) return true;
    setOpen(true);
    return new Promise<boolean>((res) => {
      resolver.current = res;
    });
  }, []);

  return (
    <ConsentCtx.Provider value={confirm}>
      {children}
      <AlertDialog open={open} onOpenChange={(o) => !o && settle(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("publishConsent.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("publishConsent.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => settle(true)}>
              {t("publishConsent.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConsentCtx.Provider>
  );
}
