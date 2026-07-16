import { ChevronRight, Copy, FileStack, FileText, Files, Heart, LogOut, MoreHorizontal, Pencil, Plus, Settings, Star, Table2, Trash2 } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Avatar, avatarConfig } from "@/components/Avatar";
import { NotificationBell } from "@/components/NotificationBell";
import { SearchBox } from "@/components/SearchBox";
import { SettingsDialog } from "@/components/SettingsDialog";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { ItemIcon } from "@/components/ItemIcon";
import type { ItemMeta, User } from "@/lib/api";
import { APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

const labelOf = (it: ItemMeta) => it.title || "Sans titre";

/** Number of root pages shown before collapsing the overflow behind a "show more".
 * Subpages are already collapsible under their parent: only the number of roots
 * inflates the list. */
const ROOT_LIMIT = 10;

/** Builds the tree: children by parent + roots (orphans included). */
function buildTree(items: ItemMeta[]): { childrenOf: Map<string, ItemMeta[]>; roots: ItemMeta[] } {
  const ids = new Set(items.map((i) => i.id));
  const childrenOf = new Map<string, ItemMeta[]>();
  const roots: ItemMeta[] = [];
  for (const it of items) {
    const parent = it.parent_item_id;
    if (parent && ids.has(parent)) {
      const arr = childrenOf.get(parent);
      if (arr) arr.push(it);
      else childrenOf.set(parent, [it]);
    } else {
      roots.push(it);
    }
  }
  return { childrenOf, roots };
}

function countDescendants(childrenOf: Map<string, ItemMeta[]>, id: string): number {
  const kids = childrenOf.get(id) ?? [];
  return kids.reduce((n, k) => n + 1 + countDescendants(childrenOf, k.id), 0);
}

export function AppSidebar({
  items,
  activeId,
  isAllPagesActive,
  currentUserId,
  onSelect,
  onShowAll,
  onShowCredits,
  onToggleFavorite,
  onCreate,
  onCreateSub,
  onDuplicate,
  onRename,
  onDelete,
  user,
  onLogout,
  onUserChange,
}: {
  items: ItemMeta[];
  activeId: string | null;
  /** Is the "All pages" page (/pages) open? (link highlight) */
  isAllPagesActive: boolean;
  currentUserId: string;
  onSelect: (id: string) => void;
  /** Opens the dedicated page listing everything accessible. */
  onShowAll: () => void;
  /** Opens the "Credits" page (what makes the project possible + contributing). */
  onShowCredits: () => void;
  /** Toggles an item's favorite (favorite = per user, not gated by permissions). */
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onCreate: (kind: "page" | "database") => void;
  onCreateSub: (parentId: string) => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  user: User;
  onLogout: () => void;
  onUserChange: (u: User) => void;
}) {
  const { t } = useTranslation();
  const { isMobile, setOpenMobile } = useSidebar();
  // On mobile, opening a page closes the drawer (otherwise it hides the page).
  const select = (id: string) => {
    onSelect(id);
    if (isMobile) setOpenMobile(false);
  };
  const showCredits = () => {
    onShowCredits();
    if (isMobile) setOpenMobile(false);
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renaming, setRenaming] = useState<ItemMeta | null>(null);
  const [deleting, setDeleting] = useState<ItemMeta | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    setRenameValue(renaming?.title ?? "");
  }, [renaming]);

  const { childrenOf, roots } = buildTree(items);
  const favorites = items.filter((it) => it.is_favorite);

  // Root cap: beyond ROOT_LIMIT, the overflow is collapsed behind a
  // "show more". Exception: if the active page descends from a collapsed root,
  // everything is expanded — otherwise its highlight would disappear from the sidebar.
  const byId = new Map(items.map((i) => [i.id, i]));
  const rootIdOf = (id: string): string => {
    let cur = byId.get(id);
    const seen = new Set<string>();
    while (cur?.parent_item_id && byId.has(cur.parent_item_id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent_item_id);
    }
    return cur?.id ?? id;
  };
  // Root cap: the sidebar shows at most ROOT_LIMIT; the rest is browsed via
  // the dedicated "All pages" page. Subpages are collapsible under their parent,
  // so only the number of roots inflates the list.
  const overLimit = roots.length > ROOT_LIMIT;
  const activeRootIndex = activeId ? roots.findIndex((r) => r.id === rootIdOf(activeId)) : -1;
  const shownRoots = roots.slice(0, ROOT_LIMIT);
  // Active root outside the cap: add it to keep its highlight visible.
  if (activeRootIndex >= ROOT_LIMIT) shownRoots.push(roots[activeRootIndex]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const deletingDescendants = deleting ? countDescendants(childrenOf, deleting.id) : 0;
  const isDeletingDb = !!deleting?.db_schema;

  // Page actions, shared by the "…" menu (dropdown on click) AND the context
  // menu (right-click) — a single source. `Item`/`Separator` = primitives of the
  // calling menu (Dropdown* or Context*), passed as components.
  const renderPageActions = (
    it: ItemMeta,
    isOwner: boolean,
    Item: React.ElementType,
    Separator: React.ElementType,
  ): React.ReactNode => (
    <>
      {/* Favorite: available to any user who sees the page (personal). */}
      <Item onSelect={() => onToggleFavorite(it.id, !it.is_favorite)}>
        <Star className={cn("text-muted-foreground", it.is_favorite && "fill-current text-foreground")} />
        {it.is_favorite ? t("sidebar.unfavorite") : t("sidebar.favorite")}
      </Item>
      {(it.can_edit || isOwner) && <Separator />}
      {it.can_edit && (
        <Item onSelect={() => onCreateSub(it.id)}>
          <Plus className="text-muted-foreground" />
          {t("sidebar.createSub")}
        </Item>
      )}
      {it.can_edit && (
        <Item onSelect={() => setRenaming(it)}>
          <Pencil className="text-muted-foreground" />
          {t("sidebar.rename")}
        </Item>
      )}
      {it.can_edit && (
        <Item onSelect={() => onDuplicate(it.id)}>
          <Copy className="text-muted-foreground" />
          {t("sidebar.duplicate")}
        </Item>
      )}
      {/* Deletion reserved for the owner (backend: require_owner). */}
      {isOwner && (
        <Item variant="destructive" onSelect={() => setDeleting(it)}>
          <Trash2 />
          {t("sidebar.delete")}
        </Item>
      )}
    </>
  );

  const renderNode = (it: ItemMeta, depth: number): React.ReactNode => {
    if (depth > 64) return null; // anti-cycle guard
    const kids = childrenOf.get(it.id) ?? [];
    const hasKids = kids.length > 0;
    const isCollapsed = collapsed.has(it.id);
    const isOwner = it.owner_id === currentUserId;

    return (
      <Fragment key={it.id}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={it.id === activeId}
                onClick={() => select(it.id)}
                tooltip={labelOf(it)}
                style={{ paddingLeft: 8 + depth * 12 }}
              >
                {hasKids ? (
                  <span
                    role="button"
                    aria-label={isCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(it.id);
                    }}
                    className="flex size-4 shrink-0 items-center justify-center rounded hover:bg-sidebar-accent-foreground/10 group-data-[collapsible=icon]:hidden"
                  >
                    <ChevronRight
                      className={cn("size-3.5 transition-transform", !isCollapsed && "rotate-90")}
                    />
                  </span>
                ) : (
                  <span className="w-4 shrink-0 group-data-[collapsible=icon]:hidden" />
                )}
                <ItemIcon
                  icon={it.icon}
                  kind={it.db_schema ? "database" : "page"}
                  size={16}
                  className="shrink-0"
                />
                <span className="truncate">{labelOf(it)}</span>
              </SidebarMenuButton>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuAction showOnHover>
                    <MoreHorizontal />
                    <span className="sr-only">{t("sidebar.actions")}</span>
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side={isMobile ? "bottom" : "right"}
                  align={isMobile ? "end" : "start"}
                  className="w-48"
                >
                  {renderPageActions(it, isOwner, DropdownMenuItem, DropdownMenuSeparator)}
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            {renderPageActions(it, isOwner, ContextMenuItem, ContextMenuSeparator)}
          </ContextMenuContent>
        </ContextMenu>
        {hasKids && !isCollapsed && kids.map((k) => renderNode(k, depth + 1))}
      </Fragment>
    );
  };

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <div className="px-2 py-1 text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
          {APP_NAME}
        </div>
        <div className="group-data-[collapsible=icon]:hidden">
          <SearchBox onSelect={select} />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {favorites.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>
              <Star className="mr-1.5 size-3.5" />
              {t("sidebar.favorites")}
            </SidebarGroupLabel>
            {/* Collapsed rail: the label disappears → we just show the section
                star (non-clickable) above the favorites for segmentation. */}
            <div
              aria-hidden
              className="hidden justify-center py-1 text-muted-foreground group-data-[collapsible=icon]:flex"
            >
              <Star className="size-4" />
            </div>
            <SidebarGroupContent>
              <SidebarMenu>
                {favorites.map((it) => (
                  <ContextMenu key={it.id}>
                    <ContextMenuTrigger asChild>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={it.id === activeId}
                          onClick={() => select(it.id)}
                          tooltip={labelOf(it)}
                        >
                          <ItemIcon
                            icon={it.icon}
                            kind={it.db_schema ? "database" : "page"}
                            size={16}
                            className="shrink-0"
                          />
                          <span className="truncate">{labelOf(it)}</span>
                        </SidebarMenuButton>
                        <SidebarMenuAction
                          showOnHover
                          onClick={() => onToggleFavorite(it.id, false)}
                          title={t("sidebar.unfavorite")}
                        >
                          <Star className="fill-current" />
                          <span className="sr-only">{t("sidebar.unfavorite")}</span>
                        </SidebarMenuAction>
                      </SidebarMenuItem>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-48">
                      {renderPageActions(
                        it,
                        it.owner_id === currentUserId,
                        ContextMenuItem,
                        ContextMenuSeparator,
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        <SidebarGroup>
          <SidebarGroupLabel>
            <FileStack className="mr-1.5 size-3.5" />
            {t("sidebar.pages")}
          </SidebarGroupLabel>
          {/* Collapsed rail: same as favorites, the section icon (non-clickable)
              marks the Pages group when the label disappears. `FileStack` ≠ the
              default page icon (`FileText`) so section and item aren't confused. */}
          <div
            aria-hidden
            className="hidden justify-center py-1 text-muted-foreground group-data-[collapsible=icon]:flex"
          >
            <FileStack className="size-4" />
          </div>
          <SidebarGroupContent>
            <SidebarMenu>
              {/* Create a page/database — right below the "Pages" label, visible even when collapsed. */}
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton title={t("sidebar.add")} className="text-muted-foreground">
                      <Plus className="size-4 shrink-0" />
                      <span className="truncate">{t("sidebar.add")}</span>
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side={isMobile ? "bottom" : "right"}
                    align="start"
                    className="w-44"
                  >
                    <DropdownMenuItem onSelect={() => onCreate("page")}>
                      <FileText className="text-muted-foreground" />
                      {t("sidebar.newPage")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onCreate("database")}>
                      <Table2 className="text-muted-foreground" />
                      {t("sidebar.newDatabase")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
              {shownRoots.map((it) => renderNode(it, 0))}
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={isAllPagesActive}
                  onClick={() => {
                    onShowAll();
                    if (isMobile) setOpenMobile(false);
                  }}
                  tooltip={t("sidebar.allPages")}
                  className="text-muted-foreground"
                >
                  <Files className="size-4 shrink-0" />
                  <span className="truncate">
                    {overLimit
                      ? t("sidebar.allPagesCount", { count: roots.length })
                      : t("sidebar.allPages")}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {/* "Credits" card: what makes the project possible + how to
            contribute. Hidden in the collapsed rail (icons only). */}
        <button
          type="button"
          onClick={showCredits}
          className="relative mb-1 flex flex-col gap-1 rounded-lg border bg-sidebar-accent/40 p-3 text-left transition-colors hover:bg-sidebar-accent group-data-[collapsible=icon]:hidden"
        >
          {/* Persistent "notification" dot: never dismisses, invites you to
              open the support page. Pulsing ring (ping) + solid dot. */}
          <span className="absolute right-2.5 top-2.5 flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-500 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-blue-500" />
          </span>
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            <Heart className="size-3.5 text-primary" /> {t("sidebar.credits.title")}
          </span>
          <span className="text-xs leading-snug text-muted-foreground">{t("sidebar.credits.body")}</span>
          <span className="mt-0.5 text-xs font-medium text-primary">{t("sidebar.credits.cta")} →</span>
        </button>
        <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={user.display_name}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
            >
              <Avatar name={user.display_name} config={avatarConfig(user.avatar)} size={26} />
              <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                <span className="block truncate text-sm">{user.display_name}</span>
                <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
              <Settings className="size-4" /> {t("sidebar.settings")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onLogout}>
              <LogOut className="size-4" /> {t("sidebar.logout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Notification bell: next to the user in expanded mode (hidden in the rail). */}
        <div className="group-data-[collapsible=icon]:hidden">
          <NotificationBell onNavigate={select} />
        </div>
        </div>
      </SidebarFooter>

      <SettingsDialog
        user={user}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onLogout={onLogout}
        onUserChange={onUserChange}
      />

      {/* Rename */}
      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sidebar.renameTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-input">{t("sidebar.titleLabel")}</Label>
            <Input
              id="rename-input"
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && renaming) {
                  onRename(renaming.id, renameValue);
                  setRenaming(null);
                }
              }}
              placeholder={t("common.untitled")}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (renaming) onRename(renaming.id, renameValue);
                setRenaming(null);
              }}
            >
              {t("sidebar.renameConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete — confirmation by copy-pasting the title */}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isDeletingDb ? t("common.trashPage.dbTitle") : t("common.trashPage.pageTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
{t("common.trashPage.retention")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleting && (
            <div className="space-y-2 text-sm text-muted-foreground">
              <code className="block rounded bg-muted px-2 py-1 text-foreground select-all">
                {labelOf(deleting)}
              </code>
              {isDeletingDb ? (
                <p>{t("common.trashPage.dbRows")}</p>
              ) : (
                deletingDescendants > 0 && (
<p>{t("common.trashPage.subpages", { count: deletingDescendants })}</p>
                )
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!deleting}
              onClick={() => {
                if (deleting) onDelete(deleting.id);
                setDeleting(null);
              }}
            >
              {t("common.trashPage.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sidebar>
  );
}
