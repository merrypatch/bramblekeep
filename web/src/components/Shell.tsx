import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Route, Routes, useMatch, useNavigate, useParams } from "react-router-dom";

import { ChevronDown, Download, History, Star, Trash2, Users } from "lucide-react";

import { HistoryDrawer } from "@/components/HistoryDrawer";
import { APP_NAME } from "@/lib/brand";
import { AllPages } from "@/components/AllPages";
import { CreditsPage } from "@/components/CreditsPage";
import { AppSidebar } from "@/components/AppSidebar";
import { Page } from "@/components/Page";
import { PageBreadcrumb } from "@/components/PageBreadcrumb";
import { Avatar } from "@/components/Avatar";
import { PresenceAvatars } from "@/components/PresenceAvatars";
import { ShareDialog } from "@/components/ShareDialog";
import { UpdateConsentPrompt } from "@/components/UpdateConsentPrompt";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { useConfirmPublicChild } from "@/lib/publishConsent";
import { acquireRoom, releaseRoom } from "@/lib/room";
import { exportCsv, exportMarkdown } from "@/lib/export";
import { usePresence } from "@/lib/presence";
import type { Awareness } from "y-protocols/awareness";
import {
  createDatabase,
  createItem,
  deleteItem,
  duplicateItem,
  getItem,
  listItems,
  patchItem,
  setFavorite,
  type ItemMeta,
  type User,
} from "@/lib/api";

function PageView({
  user,
  onMetaChange,
}: {
  user: User;
  onMetaChange: () => void;
}) {
  const { id } = useParams();
  if (!id) return null;
  return (
    <Page
      key={id}
      itemId={id}
      currentUserName={user.display_name}
      currentUserAvatar={user.avatar}
      onMetaChange={onMetaChange}
    />
  );
}

/** Home (no page open): random illustrated avatar + personalized greeting. */
function HomeEmpty({ user }: { user: User }) {
  // Random avatar, stable for the duration of display (new on each visit).
  const { t } = useTranslation();
  const seed = useMemo(() => Math.random().toString(36).slice(2), []);
  return (
    <div className="dot-grid flex min-h-[calc(100dvh-3.5rem)] flex-col items-center justify-center gap-4 p-6 text-center">
      <Avatar name={seed} size={88} />
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">{t("home.greeting", { name: user.display_name })}</h2>
        <p className="text-sm text-muted-foreground">
{t("home.empty")}
        </p>
      </div>
    </div>
  );
}

/** Authenticated layout: sidebar (pages + user) + header + active page. */
export function Shell({
  user,
  onLogout,
  onUserChange,
}: {
  user: User;
  onLogout: () => void;
  onUserChange: (u: User) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeId = useMatch("/p/:id")?.params.id ?? null;
  const isAllPagesActive = !!useMatch("/pages");

  const [items, setItems] = useState<ItemMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Counter bumped on each refresh → refetch of the active page's meta (its
  // title may have changed). Needed for db rows / templates, which
  // are not in `items` (list_pages excludes children).
  const [metaVersion, setMetaVersion] = useState(0);

  async function refresh() {
    try {
      setItems(await listItems());
      setMetaVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknownError"));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Active page's meta (breadcrumb), read directly — also works
  // for database rows and templates (absent from the sidebar).
  const [activeMeta, setActiveMeta] = useState<ItemMeta | null>(null);
  useEffect(() => {
    if (!activeId) {
      setActiveMeta(null);
      return;
    }
    let alive = true;
    getItem(activeId)
      .then((m) => {
        if (!alive) return;
        setActiveMeta(m);
        // Opening a page recorded a view (record_view in
        // get_item) → re-orders the sidebar by recency. We re-list WITHOUT bumping
        // metaVersion (setItems doesn't re-trigger any effect): no loop with this
        // effect, which itself depends on metaVersion.
        void listItems().then((it) => alive && setItems(it)).catch(() => {});
      })
      .catch(() => alive && setActiveMeta(null));
    return () => {
      alive = false;
    };
  }, [activeId, metaVersion]);

  // Presence of the active page (refcounted room, shared with Page) → avatars
  // in the header. Sharing is triggered from the same header.
  const [headerAwareness, setHeaderAwareness] = useState<Awareness | null>(null);
  useEffect(() => {
    if (!activeId) {
      setHeaderAwareness(null);
      return;
    }
    const room = acquireRoom(activeId);
    setHeaderAwareness(room.awareness);
    return () => {
      releaseRoom(activeId);
      setHeaderAwareness(null);
    };
  }, [activeId]);
  const presence = usePresence(headerAwareness);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const confirmPublicChild = useConfirmPublicChild();
  // Managing shares = administration power over the item, not just direct
  // ownership: the server also grants it through supervision (owner over
  // everyone, admin over a member — cf. require_owner/can_administer). The meta
  // reflects it via can_delete (effective level ≥ admin). Gating on owner_id alone
  // hid "Share" from an admin/owner visiting a member's page.
  const canManageShares = !!activeMeta && (activeMeta.can_delete ?? false);

  async function onCreate(kind: "page" | "database") {
    try {
      const id = kind === "database" ? await createDatabase() : await createItem();
      await refresh();
      navigate(`/p/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknownError"));
    }
  }

  async function onRename(id: string, title: string) {
    try {
      await patchItem(id, { title });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknownError"));
    }
  }

  async function onCreateSub(parentId: string) {
    if (!(await confirmPublicChild(parentId))) return;
    try {
      const id = await createItem(parentId);
      await refresh();
      navigate(`/p/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknownError"));
    }
  }

  async function onDuplicate(id: string) {
    try {
      const copy = await duplicateItem(id);
      await refresh();
      navigate(`/p/${copy}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknownError"));
    }
  }

  async function onToggleFavorite(id: string, favorite: boolean) {
    try {
      await setFavorite(id, favorite);
      // refresh() re-lists (Favorites section) and bumps metaVersion → activeMeta
      // refetched (the Options menu star reflects the new state).
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknownError"));
    }
  }

  async function onDelete(id: string) {
    try {
      // Parent of the deleted page, captured before the call (activeMeta reflects the
      // open page, including sub-pages absent from listItems).
      const deletedParent = id === activeId ? (activeMeta?.parent_item_id ?? null) : null;
      await deleteItem(id);
      setItems(await listItems());
      // We delete the OPEN page → go back up to its parent page (sub-page);
      // otherwise (root page) → home. Deleting another page does not navigate.
      if (id === activeId) navigate(deletedParent ? `/p/${deletedParent}` : "/");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknownError"));
    }
  }

  const activeLabel = activeMeta
    ? `${activeMeta.icon ? activeMeta.icon + " " : ""}${activeMeta.title || t("common.untitled")}`
    : isAllPagesActive
      ? t("allPages.title")
      : APP_NAME;

  return (
    <SidebarProvider>
      <AppSidebar
        items={items}
        activeId={activeId}
        isAllPagesActive={isAllPagesActive}
        currentUserId={user.id}
        onSelect={(id) => navigate(`/p/${id}`)}
        onShowAll={() => navigate("/pages")}
        onShowCredits={() => navigate("/credits")}
        onToggleFavorite={(id, fav) => void onToggleFavorite(id, fav)}
        onCreate={(kind) => void onCreate(kind)}
        onCreateSub={(pid) => void onCreateSub(pid)}
        onDuplicate={(id) => void onDuplicate(id)}
        onRename={(id, title) => void onRename(id, title)}
        onDelete={(id) => void onDelete(id)}
        user={user}
        onLogout={onLogout}
        onUserChange={onUserChange}
      />
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {activeId ? (
              <PageBreadcrumb
                itemId={activeId}
                title={activeMeta?.title ?? null}
                icon={activeMeta?.icon ?? null}
                kind={activeMeta?.db_schema ? "database" : "page"}
                onNavigate={(id) => navigate(`/p/${id}`)}
              />
            ) : (
              <span className="truncate text-sm font-medium">{activeLabel}</span>
            )}
          </div>
          {error && <span className="ml-2 shrink-0 text-xs text-destructive">{error}</span>}
          {activeId && (
            <div className="ml-2 flex shrink-0 items-center gap-2">
              <PresenceAvatars users={presence} selfAvatar={user.avatar} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent">
                    {t("pageMenu.options")} <ChevronDown className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => void onToggleFavorite(activeId, !(activeMeta?.is_favorite ?? false))}
                  >
                    <Star
                      className={
                        activeMeta?.is_favorite ? "size-3.5 fill-current" : "size-3.5"
                      }
                    />{" "}
                    {activeMeta?.is_favorite ? t("pageMenu.unfavorite") : t("pageMenu.favorite")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {canManageShares && (
                    <>
                      <DropdownMenuItem onSelect={() => setShareOpen(true)}>
                        <Users className="size-3.5" /> {t("pageMenu.share")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                    <History className="size-3.5" /> {t("pageMenu.history")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void exportMarkdown(activeId)}>
                    <Download className="size-3.5" /> {t("pageMenu.exportMd")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setTimeout(() => window.print(), 0)}>
                    <Download className="size-3.5" /> {t("pageMenu.exportPdf")}
                  </DropdownMenuItem>
                  {activeMeta?.db_schema != null && (
                    <DropdownMenuItem onSelect={() => void exportCsv(activeId)}>
                      <Download className="size-3.5" /> {t("pageMenu.exportCsv")}
                    </DropdownMenuItem>
                  )}
                  {canManageShares && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                        <Trash2 className="size-3.5" />{" "}
                        {activeMeta?.db_schema != null ? t("pageMenu.deleteDb") : t("pageMenu.deletePage")}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </header>
        {activeId && (
          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {activeMeta?.db_schema != null
                    ? t("common.trashPage.dbTitle")
                    : t("common.trashPage.pageTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
{t("common.trashPage.retention")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <code className="block rounded bg-muted px-2 py-1 text-sm text-foreground select-all">
                {activeMeta?.title || t("common.untitled")}
              </code>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    void onDelete(activeId);
                    setDeleteOpen(false);
                  }}
                >
                  {t("common.trashPage.confirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        {activeId && <ShareDialog itemId={activeId} open={shareOpen} onOpenChange={setShareOpen} />}
        {activeId && (
          <HistoryDrawer
            itemId={activeId}
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            onNavigate={(id) => navigate(`/p/${id}`)}
          />
        )}

        <div className="min-w-0 flex-1">
          <Routes>
            <Route
              path="/"
              element={<HomeEmpty user={user} />}
            />
            <Route
              path="/pages"
              element={<AllPages items={items} onSelect={(id) => navigate(`/p/${id}`)} />}
            />
            <Route
              path="/p/:id"
              element={<PageView user={user} onMetaChange={() => void refresh()} />}
            />
            <Route path="/credits" element={<CreditsPage />} />
          </Routes>
        </div>
      </SidebarInset>
      <UpdateConsentPrompt role={user.role} />
    </SidebarProvider>
  );
}
