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

/** Guard for MOVING a page: publication is inherited, so a move can expose a
 * page to the web (destination inside a publication) or withdraw it (leaving
 * one). Both are consequences the user must accept before the move happens. */
type ConfirmMove = (itemId: string, destParent: string | null | undefined) => Promise<boolean>;

const ConsentCtx = createContext<ConfirmPublicChild>(async () => true);
const MoveCtx = createContext<ConfirmMove>(async () => true);

/** Hook for components that create sub-pages (editor, sidebar). */
export function useConfirmPublicChild(): ConfirmPublicChild {
  return useContext(ConsentCtx);
}

/** Hook for the sidebar: consent before a move changes what is public. */
export function useConfirmMovePublic(): ConfirmMove {
  return useContext(MoveCtx);
}

/** Provides the "sub-page of a published page" consent (option 4). Mounted once
 * high in the tree; the backend PROPAGATES publication on creation, this
 * dialog ensures the user is informed of it and accepts it beforehand. */
export function PublishConsentProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Which consequence we are asking about: gaining publicity (a new/moved page
  // under a published parent) or losing it (leaving a published subtree).
  const [kind, setKind] = useState<"publish" | "unpublish">("publish");
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
    setKind("publish");
    setOpen(true);
    return new Promise<boolean>((res) => {
      resolver.current = res;
    });
  }, []);

  /** Is this page currently exposed on the web? Indeterminate (request failure)
   * counts as "no": a network hiccup must not block a move. */
  const isPublic = async (id: string | null | undefined): Promise<boolean> => {
    if (!id) return false;
    try {
      return (await getItem(id)).is_public ?? false;
    } catch {
      return false;
    }
  };

  const confirmMove = useCallback<ConfirmMove>(async (itemId, destParent) => {
    // Into a publication → it becomes readable by anyone with the link.
    if (await isPublic(destParent)) {
      setKind("publish");
      setOpen(true);
      return new Promise<boolean>((res) => {
        resolver.current = res;
      });
    }
    // Out of one → the backend withdraws the branch from the web (unless the
    // page owns its own publication, which `is_public` cannot distinguish here;
    // the wording therefore stays about the public link, not about deletion).
    if (await isPublic(itemId)) {
      setKind("unpublish");
      setOpen(true);
      return new Promise<boolean>((res) => {
        resolver.current = res;
      });
    }
    return true;
  }, []);

  return (
    <ConsentCtx.Provider value={confirm}>
      <MoveCtx.Provider value={confirmMove}>
      {children}
      <AlertDialog open={open} onOpenChange={(o) => !o && settle(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {kind === "publish" ? t("publishConsent.title") : t("publishConsent.unpublishTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {kind === "publish" ? t("publishConsent.body") : t("publishConsent.unpublishBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => settle(true)}>
              {kind === "publish" ? t("publishConsent.confirm") : t("publishConsent.unpublishConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </MoveCtx.Provider>
    </ConsentCtx.Provider>
  );
}
