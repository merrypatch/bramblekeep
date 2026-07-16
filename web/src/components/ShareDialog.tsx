import { Check, ChevronDown, Copy, Globe, Info, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { Avatar, avatarConfig } from "@/components/Avatar";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  addShare,
  getPublication,
  getWorkspace,
  listShares,
  publishItem,
  removeShare,
  unpublishItem,
  type Member,
  type PendingInvite,
  type PublicNavItem,
  type Share,
} from "@/lib/api";

const LEVEL_VALUES = ["read", "edit", "creator", "admin"] as const;
const levelLabel = (l: string) => i18n.t(`share.level.${l}` as "share.level.read");
const levelDesc = (l: string) => i18n.t(`share.levelDesc.${l}` as "share.levelDesc.read");

// ACCOUNT status (no real-time presence: cf. product decision — global
// "online" presence will be added with the in-app notifications).
const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-500",
  suspended: "bg-destructive",
};
const statusOf = (s: string) => ({
  label: i18n.t(`share.status.${s}` as "share.status.active", { defaultValue: s }),
  dot: STATUS_DOT[s] ?? "bg-muted-foreground",
});

/** Manage a page's shares (owner). An email with an account is
 * shared immediately; an email without an account receives an email invitation,
 * accepted upon sign-in. */
export function ShareDialog({
  itemId,
  open,
  onOpenChange,
}: {
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [shares, setShares] = useState<Share[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState("edit");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<Share | null>(null);
  const [confirmValue, setConfirmValue] = useState("");
  // Web publication (read without sign-in).
  const [pubOn, setPubOn] = useState(false);
  const [pubToken, setPubToken] = useState<string | null>(null);
  const [includeSub, setIncludeSub] = useState(false);
  const [pubPages, setPubPages] = useState<PublicNavItem[]>([]);
  const [copied, setCopied] = useState(false);
  // Warning before web publication (making the page accessible without sign-in).
  const [confirmPublish, setConfirmPublish] = useState(false);

  useEffect(() => {
    setConfirmValue("");
  }, [revoking]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setEmail("");
    listShares(itemId)
      .then((s) => {
        setShares(s.shares);
        setInvites(s.invites);
      })
      .catch(() => {
        setShares([]);
        setInvites([]);
      });
    // Workspace roster for the picker (best-effort; accessible to any member).
    getWorkspace()
      .then((ws) => setMembers(ws.members))
      .catch(() => setMembers([]));
    // Publication state of the page.
    setCopied(false);
    getPublication(itemId)
      .then((p) => {
        if (p.published) {
          setPubOn(true);
          setPubToken(p.token);
          setPubPages(p.pages);
          setIncludeSub(p.include_subtree);
        } else {
          setPubOn(false);
          setPubToken(null);
          setPubPages([]);
          setIncludeSub(false);
        }
      })
      .catch(() => setPubOn(false));
  }, [open, itemId]);

  // Enables/disables web publication. Publishing exposes the page without sign-in:
  // we first ask for explicit consent (cf. doPublish). Unpublishing is
  // risk-free → direct.
  async function togglePublish(on: boolean) {
    setError(null);
    if (on) {
      setConfirmPublish(true);
      return;
    }
    setBusy(true);
    try {
      await unpublishItem(itemId);
      setPubOn(false);
      setPubToken(null);
      setPubPages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("share.errPublish"));
    } finally {
      setBusy(false);
    }
  }

  // Actual publication, after consent. Returns the link + the exposed set.
  async function doPublish() {
    setConfirmPublish(false);
    setError(null);
    setBusy(true);
    try {
      const r = await publishItem(itemId, includeSub);
      setPubToken(r.token);
      setPubPages(r.pages);
      setPubOn(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("share.errPublish"));
    } finally {
      setBusy(false);
    }
  }

  // Toggles subtree inclusion (republishes with the new scope).
  async function changeSubtree(v: boolean) {
    setIncludeSub(v);
    if (!pubOn) return;
    setBusy(true);
    try {
      const r = await publishItem(itemId, v);
      setPubToken(r.token);
      setPubPages(r.pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("share.errUpdate"));
    } finally {
      setBusy(false);
    }
  }

  const publicUrl = pubToken ? `${window.location.origin}/public/${pubToken}` : "";
  async function copyLink() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions): the input stays selectable.
    }
  }

  // Direct share with a workspace member (picked from the roster), at the level
  // selected above. Avoids retyping the email.
  async function shareMember(memberEmail: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await addShare(itemId, memberEmail, level);
      setShares(res.shares);
      setInvites(res.invites);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("share.errShare"));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await addShare(itemId, email, level);
      setShares(res.shares);
      setInvites(res.invites);
      setNotice(res.invited ? t("share.inviteSent", { email: res.invited }) : null);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("share.errShare"));
    } finally {
      setBusy(false);
    }
  }

  async function changeLevel(targetEmail: string, newLevel: string) {
    try {
      const res = await addShare(itemId, targetEmail, newLevel);
      setShares(res.shares);
      setInvites(res.invites);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("share.errUpdate"));
    }
  }

  async function revoke(userId: string) {
    await removeShare(itemId, userId);
    setShares((s) => s.filter((x) => x.user_id !== userId));
    setRevoking(null);
  }

  // Suggestible members: workspace members not already shared/invited (self included,
  // cleanly rejected by the backend "you are already the owner" if applicable).
  const alreadyIn = new Set([...shares.map((s) => s.email), ...invites.map((i) => i.email)]);
  const pickable = members.filter((m) => m.status === "active" && !alreadyIn.has(m.email));

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full gap-0 sm:max-w-md">
          <SheetHeader className="border-b pb-3">
            <SheetTitle>{t("share.title")}</SheetTitle>
            <SheetDescription>{t("share.byEmail")}</SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
            {/* Web publication: read without sign-in. */}
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Globe className="size-4 text-muted-foreground" /> {t("share.publishToggle")}
                </div>
                <Switch
                  checked={pubOn}
                  disabled={busy}
                  onCheckedChange={(v) => void togglePublish(v)}
                  aria-label={t("share.publishToggle")}
                />
              </div>
              <p className="text-xs text-muted-foreground">{t("share.publishHint")}</p>
              {pubOn && pubToken && (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center gap-1">
                    <Input readOnly value={publicUrl} className="text-xs" onFocus={(e) => e.target.select()} />
                    <Button size="icon" variant="outline" onClick={() => void copyLink()} aria-label={t("share.copyLink")}>
                      {copied ? <Check /> : <Copy />}
                    </Button>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={includeSub}
                      disabled={busy}
                      onCheckedChange={(v) => void changeSubtree(v === true)}
                    />
                    {t("share.includeSub")}
                  </label>
                  {includeSub && pubPages.length > 1 && (
                    <div className="rounded bg-muted/50 p-2 text-xs text-muted-foreground">
                      <p className="mb-1 font-medium">{t("share.publishedPages", { count: pubPages.length })}</p>
                      <ul className="space-y-0.5">
                        {pubPages.map((p) => (
                          <li key={p.id} className="truncate">
                            {p.icon ? `${p.icon} ` : ""}
                            {p.title || t("share.untitled")}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            <form onSubmit={submit} className="space-y-2">
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("share.invitePlaceholder")}
              />
              <div className="flex items-center gap-2">
                <select
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                  className="flex-1 rounded-md border bg-background px-2 py-1.5 text-sm"
                >
                  {LEVEL_VALUES.map((v) => (
                    <option key={v} value={v}>
                      {levelLabel(v)}
                    </option>
                  ))}
                </select>
                <Button type="submit" disabled={busy}>
                  {t("share.invite")}
                </Button>
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" aria-label={t("share.rolesAria")} className="text-muted-foreground hover:text-foreground">
                        <Info className="size-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-64">
                      <ul className="space-y-1">
                        {LEVEL_VALUES.map((v) => (
                          <li key={v}>
                            <span className="font-medium">{levelLabel(v)}</span> — {levelDesc(v)}
                          </li>
                        ))}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </form>

            {pickable.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={busy}
                    className="flex w-full items-center justify-between rounded-md border bg-background px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
                  >
                    <span className="flex items-center gap-1.5">
                      <UserPlus className="size-4" /> {t("share.addMember")}
                    </span>
                    <ChevronDown className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 w-(--radix-dropdown-menu-trigger-width) overflow-auto">
                  {pickable.map((m) => {
                    const st = statusOf(m.status);
                    return (
                      <DropdownMenuItem
                        key={m.id}
                        className="gap-2"
                        onSelect={() => void shareMember(m.email)}
                      >
                        <Avatar name={m.display_name} config={avatarConfig(m.avatar)} size={32} ring={false} />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium text-foreground">{m.display_name}</span>
                          <span className="truncate text-xs text-muted-foreground">{m.email}</span>
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <span className={`size-1.5 rounded-full ${st.dot}`} aria-hidden />
                          {st.label}
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
            {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

            <ul className="space-y-1">
              {shares.length === 0 && invites.length === 0 && (
                <li className="text-sm text-muted-foreground">{t("share.notShared")}</li>
              )}
              {shares.map((s) => (
                <li
                  key={s.user_id}
                  className="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-accent"
                >
                  <span className="truncate">{s.email}</span>
                  <span className="flex items-center gap-2">
                    <select
                      className="rounded-md border bg-background px-1.5 py-0.5 text-xs"
                      value={s.level}
                      onChange={(e) => void changeLevel(s.email, e.target.value)}
                      aria-label={t("share.accessLevel")}
                    >
                      {LEVEL_VALUES.map((v) => (
                        <option key={v} value={v}>
                          {levelLabel(v)}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => setRevoking(s)}
                      aria-label={t("share.revoke")}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                </li>
              ))}
              {invites.map((inv) => (
                <li
                  key={`invite-${inv.email}`}
                  className="flex items-center justify-between rounded px-2 py-1 text-sm text-muted-foreground"
                >
                  <span className="truncate">{inv.email}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs">{levelLabel(inv.level)}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                      {t("share.invited")}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </SheetContent>
      </Sheet>

      {/* Revocation — confirmation by copy-pasting the email (like page deletion). */}
      <AlertDialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("share.revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("share.revokeDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revoking && (
            <div className="space-y-2">
              <code className="block rounded bg-muted px-2 py-1 text-sm select-all">
                {revoking.email}
              </code>
              <Input
                value={confirmValue}
                autoFocus
                onChange={(e) => setConfirmValue(e.target.value)}
                placeholder={t("share.revokePlaceholder")}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("share.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!revoking || confirmValue !== revoking.email}
              onClick={() => {
                if (revoking) void revoke(revoking.user_id);
              }}
            >
              {t("share.revokeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmPublish} onOpenChange={(o) => !o && setConfirmPublish(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("share.publishWarnTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("share.publishWarnDesc", { sub: includeSub ? t("share.publishWarnSub") : "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("share.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doPublish()}>{t("share.publish")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
