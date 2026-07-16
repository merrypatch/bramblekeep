import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Building2,
  ChevronDown,
  Crown,
  Eye,
  Grid3x3,
  Grip,
  Info,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Pencil,
  RotateCcw,
  Settings2,
  Shield,
  Shuffle,
  Sun,
  Trash2,
  X,
  User as UserIcon,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { type AvatarFullConfig as AvatarConfig, genConfig } from "react-nice-avatar";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import i18n, { LANGUAGES, LANGUAGE_FLAGS, LANGUAGE_NAMES, setLanguage, type Language } from "@/i18n";

import { Avatar, avatarConfig } from "@/components/Avatar";
import { UpdateApplyDialog } from "@/components/UpdateApplyDialog";
import { ItemIcon } from "@/components/ItemIcon";
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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ListRowsSkeleton, TextLinesSkeleton } from "@/components/ui/skeletons";
import {
  type Member,
  type MemberPage,
  type Role,
  type TrashItem,
  type User,
  type UpdateCheckResult,
  type UpdateConsent,
  type Workspace,
  getMemberPages,
  getTrash,
  getUpdateConsent,
  getWorkspace,
  inviteMember,
  purgeItem,
  removeMember,
  restoreItem,
  revokeInvite,
  checkForUpdates,
  setMemberRole,
  setUpdateConsent,
  transferOwnership,
  updateMe,
  updateWorkspace,
} from "@/lib/api";
import {
  type Accent,
  type GridPattern,
  ACCENTS,
  ACCENT_SWATCH,
  getAccent,
  getGrid,
  setAccent,
  setGrid,
} from "@/lib/appearance";
import { type Theme, getTheme, setTheme } from "@/lib/theme";
import { formatDate } from "@/lib/locale";
import { cn } from "@/lib/utils";

type Section = "general" | "account" | "trash" | "members" | "workspace";

function roleLabel(role: Role): string {
  return i18n.t(`settings.role.${role}` as "settings.role.owner");
}

/** Rights granted by each role (mirror of `require_role` on the server). */
const ROLE_CAP_KEYS: Record<Role, string[]> = {
  owner: ["ownerAllAdmin", "ownerPromote", "ownerDisable", "ownerTransfer"],
  admin: ["adminInvite", "adminRename", "adminPending"],
  member: ["memberAccess", "memberEdit"],
};
function roleCaps(role: Role): string[] {
  return ROLE_CAP_KEYS[role].map((k) => i18n.t(`settings.caps.${k}` as "settings.caps.ownerAllAdmin"));
}

/** Settings panel (Claude.ai style): left nav + right content. */
export function SettingsDialog({
  user,
  open,
  onOpenChange,
  onLogout,
  onUserChange,
}: {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLogout: () => void;
  onUserChange: (u: User) => void;
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("general");
  const [ws, setWs] = useState<Workspace | null>(null);
  const isAdmin = user.role === "owner" || user.role === "admin";
  const navigate = useNavigate();

  // Open a page from supervision: closes the modal then navigates. The
  // supervisor accesses it READ-ONLY (supervision access is enforced server-side).
  const openPage = (id: string) => {
    onOpenChange(false);
    navigate(`/p/${id}`);
  };

  const reload = () => {
    getWorkspace()
      .then(setWs)
      .catch(() => setWs(null));
  };
  useEffect(() => {
    if (open) reload();
  }, [open]);

  const nav: { id: Section; label: string; icon: ReactNode }[] = [
    { id: "general", label: t("settings.nav.general"), icon: <Settings2 className="size-4" /> },
    { id: "account", label: t("settings.nav.account"), icon: <UserIcon className="size-4" /> },
    { id: "trash", label: t("settings.nav.trash"), icon: <Trash2 className="size-4" /> },
    ...(isAdmin
      ? ([
          { id: "members", label: t("settings.nav.members"), icon: <Users className="size-4" /> },
          { id: "workspace", label: t("settings.nav.workspace"), icon: <Building2 className="size-4" /> },
        ] as const)
      : []),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(44rem,88vh)] w-[min(64rem,95vw)] max-w-[95vw] gap-0 overflow-hidden p-0 sm:max-w-[64rem]">
        <DialogTitle className="sr-only">{t("settings.title")}</DialogTitle>
        <div className="flex h-full w-full min-w-0 flex-col sm:flex-row">
          {/* Mobile: scrollable horizontal bar at the top. Desktop: column on the left. */}
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b bg-muted/30 p-2 max-sm:pt-11 [scrollbar-width:none] sm:w-60 sm:flex-col sm:gap-0 sm:space-y-1 sm:overflow-visible sm:border-r sm:border-b-0 sm:p-4 [&::-webkit-scrollbar]:hidden">
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground max-sm:hidden">{t("settings.title")}</p>
            {nav.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => setSection(n.id)}
                className={cn(
                  "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-sm transition-colors sm:w-full",
                  section === n.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                {n.icon}
                {n.label}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5 sm:px-8 sm:py-7">
            {section === "general" && <GeneralSection user={user} onUserChange={onUserChange} />}
            {section === "account" && <AccountSection user={user} ws={ws} onLogout={onLogout} />}
            {section === "trash" && <TrashSection isAdmin={isAdmin} />}
            {section === "members" && (
              <MembersSection user={user} ws={ws} onChanged={reload} onOpenPage={openPage} />
            )}
            {section === "workspace" && <WorkspaceSection ws={ws} onChanged={reload} />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 text-lg font-semibold">{children}</h2>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  );
}

/** Palettes offered by the color pickers in the avatar editor. */
const FACE_COLORS = ["#F9C9B6", "#AC6651", "#EDB98A", "#FFDBB4", "#D08B5B"];
const BG_COLORS = ["#6BD9E9", "#F4D150", "#E0DDFF", "#9287FF", "#FC909F", "#A7DDA4", "#77311D"];
const HAIR_COLORS = ["#000000", "#5A3825", "#B58143", "#D6B370", "#E8E1E1", "#FC909F"];
const HAT_COLORS = ["#000000", "#77311D", "#6BD9E9", "#F4D150", "#FC909F", "#A7DDA4"];
const SHIRT_COLORS = ["#9287FF", "#6BD9E9", "#F4D150", "#FC909F", "#A7DDA4", "#77311D", "#E8E1E1"];

function AvatarEditor({ user, onUserChange }: { user: User; onUserChange: (u: User) => void }) {
  const { t } = useTranslation();
  const initial = () => avatarConfig(user.avatar) ?? genConfig(user.display_name);
  const [cfg, setCfg] = useState<AvatarConfig>(initial);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => setCfg(initial()), [user.avatar, user.display_name]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = JSON.stringify(cfg) !== (user.avatar ?? "");
  const set = (patch: Partial<AvatarConfig>) => setCfg((c) => ({ ...c, ...patch }));

  const persist = async (avatar: string) => {
    setBusy(true);
    try {
      onUserChange(await updateMe({ avatar }));
      toast.success(t("settings.avatar.updated"));
      setEditing(false);
    } catch {
      toast.error(t("settings.profile.updateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setCfg(initial());
    setEditing(false);
  };

  // Collapsed mode: preview + "Edit" button. The options only appear while editing.
  if (!editing) {
    return (
      <div className="flex items-center gap-4">
        <Avatar name={user.display_name} config={cfg} size={64} ring={false} />
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" /> {t("settings.avatar.edit")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:gap-5">
      <div className="flex flex-col items-center gap-2">
        <Avatar name={user.display_name} config={cfg} size={84} ring={false} />
        <Button size="sm" variant="outline" onClick={() => setCfg(genConfig())}>
          <Shuffle className="size-3.5" /> {t("settings.avatar.random")}
        </Button>
      </div>

      <div className="grid w-full min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2.5">
        <SelectField
          label={t("settings.avatar.style")}
          value={cfg.sex ?? "man"}
          onChange={(v) => set({ sex: v as AvatarConfig["sex"] })}
          options={[["man", t("settings.avatar.opt.man")], ["woman", t("settings.avatar.opt.woman")]]}
        />
        <SelectField
          label={t("settings.avatar.hair")}
          value={cfg.hairStyle ?? "normal"}
          onChange={(v) => set({ hairStyle: v as AvatarConfig["hairStyle"] })}
          options={[["normal", t("settings.avatar.opt.normal")], ["thick", t("settings.avatar.opt.thick")], ["mohawk", t("settings.avatar.opt.mohawk")], ["womanLong", t("settings.avatar.opt.womanLong")], ["womanShort", t("settings.avatar.opt.womanShort")]]}
        />
        <SelectField
          label={t("settings.avatar.ears")}
          value={cfg.earSize ?? "small"}
          onChange={(v) => set({ earSize: v as AvatarConfig["earSize"] })}
          options={[["small", t("settings.avatar.opt.small")], ["big", t("settings.avatar.opt.big")]]}
        />
        <SelectField
          label={t("settings.avatar.eyes")}
          value={cfg.eyeStyle ?? "circle"}
          onChange={(v) => set({ eyeStyle: v as AvatarConfig["eyeStyle"] })}
          options={[["circle", t("settings.avatar.opt.circle")], ["oval", t("settings.avatar.opt.oval")], ["smile", t("settings.avatar.opt.smile")]]}
        />
        <SelectField
          label={t("settings.avatar.eyebrows")}
          value={cfg.eyeBrowStyle ?? "up"}
          onChange={(v) => set({ eyeBrowStyle: v as AvatarConfig["eyeBrowStyle"] })}
          options={[["up", t("settings.avatar.opt.up")], ["upWoman", t("settings.avatar.opt.upWoman")]]}
        />
        <SelectField
          label={t("settings.avatar.nose")}
          value={cfg.noseStyle ?? "short"}
          onChange={(v) => set({ noseStyle: v as AvatarConfig["noseStyle"] })}
          options={[["short", t("settings.avatar.opt.short")], ["long", t("settings.avatar.opt.long")], ["round", t("settings.avatar.opt.round")]]}
        />
        <SelectField
          label={t("settings.avatar.glasses")}
          value={cfg.glassesStyle ?? "none"}
          onChange={(v) => set({ glassesStyle: v as AvatarConfig["glassesStyle"] })}
          options={[["none", t("settings.avatar.opt.none")], ["round", t("settings.avatar.opt.round")], ["square", t("settings.avatar.opt.square")]]}
        />
        <SelectField
          label={t("settings.avatar.mouth")}
          value={cfg.mouthStyle ?? "smile"}
          onChange={(v) => set({ mouthStyle: v as AvatarConfig["mouthStyle"] })}
          options={[["smile", t("settings.avatar.opt.smile")], ["laugh", t("settings.avatar.opt.laugh")], ["peace", t("settings.avatar.opt.peace")]]}
        />
        <SelectField
          label={t("settings.avatar.hat")}
          value={cfg.hatStyle ?? "none"}
          onChange={(v) => set({ hatStyle: v as AvatarConfig["hatStyle"] })}
          options={[["none", t("settings.avatar.opt.none")], ["beanie", t("settings.avatar.opt.beanie")], ["turban", t("settings.avatar.opt.turban")]]}
        />
        <SelectField
          label={t("settings.avatar.clothing")}
          value={cfg.shirtStyle ?? "hoody"}
          onChange={(v) => set({ shirtStyle: v as AvatarConfig["shirtStyle"] })}
          options={[["hoody", t("settings.avatar.opt.hoody")], ["short", t("settings.avatar.opt.tshirt")], ["polo", t("settings.avatar.opt.polo")]]}
        />
        <SwatchField label={t("settings.avatar.bg")} value={cfg.bgColor} colors={BG_COLORS} onChange={(bgColor) => set({ bgColor })} />
        <SwatchField label={t("settings.avatar.skin")} value={cfg.faceColor} colors={FACE_COLORS} onChange={(faceColor) => set({ faceColor })} />
        <SwatchField label={t("settings.avatar.hair")} value={cfg.hairColor} colors={HAIR_COLORS} onChange={(hairColor) => set({ hairColor })} />
        {cfg.hatStyle && cfg.hatStyle !== "none" && (
          <SwatchField label={t("settings.avatar.hatColor")} value={cfg.hatColor} colors={HAT_COLORS} onChange={(hatColor) => set({ hatColor })} />
        )}
        <SwatchField label={t("settings.avatar.clothingColor")} value={cfg.shirtColor} colors={SHIRT_COLORS} onChange={(shirtColor) => set({ shirtColor })} />

        <ToggleField label={t("settings.avatar.gradient")} checked={!!cfg.isGradient} onChange={(isGradient) => set({ isGradient })} />

        <div className="col-span-2 mt-1 flex gap-2">
          <Button size="sm" onClick={() => void persist(JSON.stringify(cfg))} disabled={busy || !dirty}>
            {t("settings.avatar.save")}
          </Button>
          <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
            <X className="size-3.5" /> {t("settings.avatar.cancel")}
          </Button>
          {user.avatar && (
            <Button size="sm" variant="ghost" onClick={() => void persist("")} disabled={busy}>
              <RotateCcw className="size-3.5" /> {t("settings.avatar.reset")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 rounded-md border bg-background px-2 py-1 text-sm text-foreground"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function SwatchField({
  label,
  value,
  colors,
  onChange,
}: {
  label: string;
  value: string | undefined;
  colors: string[];
  onChange: (c: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <div className="flex flex-wrap gap-1">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            onClick={() => onChange(c)}
            style={{ backgroundColor: c }}
            className={cn(
              "size-5 rounded-full border transition-transform hover:scale-110",
              value === c && "ring-2 ring-ring ring-offset-1 ring-offset-background",
            )}
          />
        ))}
      </div>
    </div>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 self-end text-xs text-muted-foreground">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4" />
      {label}
    </label>
  );
}

function GeneralSection({ user, onUserChange }: { user: User; onUserChange: (u: User) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(user.display_name);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [grid, setGridState] = useState<GridPattern>(getGrid());
  const [accent, setAccentState] = useState<Accent>(getAccent());
  const [busy, setBusy] = useState(false);

  useEffect(() => setName(user.display_name), [user.display_name]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === user.display_name) return;
    setBusy(true);
    try {
      const updated = await updateMe({ display_name: trimmed });
      onUserChange(updated);
      toast.success(t("settings.profile.updated"));
    } catch {
      toast.error(t("settings.profile.updateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const pick = (theme: Theme) => {
    setTheme(theme);
    setThemeState(theme);
  };

  const pickGrid = (g: GridPattern) => {
    setGrid(g);
    setGridState(g);
  };

  const pickAccent = (a: Accent) => {
    setAccent(a);
    setAccentState(a);
  };

  const changeLang = async (lng: Language) => {
    setLanguage(lng); // applied + cached immediately
    try {
      onUserChange(await updateMe({ language: lng }));
    } catch {
      /* language already applied client-side; server sync will retry next change */
    }
  };

  return (
    <div>
      <SectionTitle>{t("settings.profile.title")}</SectionTitle>
      <div className="py-2">
        <Label className="mb-2 block text-sm">{t("settings.profile.avatar")}</Label>
        <AvatarEditor user={user} onUserChange={onUserChange} />
      </div>
      <div className="py-3">
        <Label htmlFor="settings-name" className="mb-1.5 block text-sm">
          {t("settings.profile.fullName")}
        </Label>
        <div className="flex min-w-0 gap-2">
          <Input
            id="settings-name"
            className="min-w-0 flex-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
          <Button onClick={() => void save()} disabled={busy || !name.trim() || name.trim() === user.display_name}>
            {t("settings.profile.save")}
          </Button>
        </div>
      </div>

      <h3 className="mt-6 mb-2 text-sm font-semibold text-muted-foreground">{t("settings.profile.prefs")}</h3>
      <Row label={t("settings.profile.appearance")}>
        <div className="flex gap-1 rounded-md border p-0.5">
          {(
            [
              ["system", <Monitor className="size-4" key="s" />, t("settings.theme.system")],
              ["light", <Sun className="size-4" key="l" />, t("settings.theme.light")],
              ["dark", <Moon className="size-4" key="d" />, t("settings.theme.dark")],
            ] as const
          ).map(([t, icon, title]) => (
            <button
              key={t}
              type="button"
              title={title}
              aria-label={title}
              onClick={() => pick(t)}
              className={cn(
                "rounded p-1.5 transition-colors",
                theme === t ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {icon}
            </button>
          ))}
        </div>
      </Row>
      <Row label={t("settings.grid.label")}>
        <div className="flex gap-1 rounded-md border p-0.5">
          {(
            [
              ["plus", <Plus className="size-4" key="p" />, t("settings.grid.plus")],
              ["dots", <Grip className="size-4" key="d" />, t("settings.grid.dots")],
              ["lines", <Grid3x3 className="size-4" key="l" />, t("settings.grid.lines")],
              ["none", <Ban className="size-4" key="n" />, t("settings.grid.none")],
            ] as const
          ).map(([g, icon, title]) => (
            <button
              key={g}
              type="button"
              title={title}
              aria-label={title}
              onClick={() => pickGrid(g)}
              className={cn(
                "rounded p-1.5 transition-colors",
                grid === g ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {icon}
            </button>
          ))}
        </div>
      </Row>
      <Row label={t("settings.accent.label")}>
        <div className="flex gap-1.5">
          {ACCENTS.map((a) => (
            <button
              key={a}
              type="button"
              title={t(`settings.accent.${a}`)}
              aria-label={t(`settings.accent.${a}`)}
              aria-pressed={accent === a}
              onClick={() => pickAccent(a)}
              style={{ backgroundColor: ACCENT_SWATCH[a] }}
              className={cn(
                "size-6 rounded-full ring-offset-2 ring-offset-background transition-shadow",
                accent === a ? "ring-2 ring-ring" : "ring-1 ring-border hover:ring-ring/50",
              )}
            />
          ))}
        </div>
      </Row>
      <Row label={t("settings.language.label")}>
        <select
          value={i18n.language}
          onChange={(e) => void changeLang(e.target.value as Language)}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_FLAGS[l]} {LANGUAGE_NAMES[l]}
            </option>
          ))}
        </select>
      </Row>
    </div>
  );
}

function AccountSection({ user, ws, onLogout }: { user: User; ws: Workspace | null; onLogout: () => void }) {
  const { t } = useTranslation();
  const me = ws?.members.find((m) => m.id === user.id);
  return (
    <div>
      <SectionTitle>{t("settings.account.title")}</SectionTitle>
      <Row label={t("settings.account.email")}>
        <span className="text-sm text-muted-foreground">{user.email}</span>
      </Row>
      <Row label={t("settings.account.role")}>
        <RoleBadge role={user.role} />
      </Row>
      {me && (
        <Row label={t("settings.account.memberSince")}>
          <span className="text-sm text-muted-foreground">
            {formatDate(me.created_ts)}
          </span>
        </Row>
      )}
      <div className="pt-6">
        <Button variant="outline" onClick={onLogout}>
          <LogOut className="size-4" /> {t("settings.account.logout")}
        </Button>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: Role }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
      {role === "owner" ? <Crown className="size-3" /> : role === "admin" ? <Shield className="size-3" /> : null}
      {roleLabel(role)}
    </span>
  );
}

/** Expandable legend explaining the rights of each role. */
function RolePermissionsInfo() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const roles: Role[] = ["owner", "admin", "member"];
  return (
    <div className="mb-4 rounded-lg border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
      >
        <Info className="size-4 text-muted-foreground" />
        {t("settings.rolePerm.question")}
        <ChevronDown className={cn("ml-auto size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-3 border-t px-3 py-3">
          {roles.map((r) => (
            <div key={r} className="flex flex-col gap-1">
              <RoleBadge role={r} />
              <ul className="ml-1 list-disc pl-4 text-xs text-muted-foreground">
                {roleCaps(r).map((cap) => (
                  <li key={cap}>{cap}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Can a role supervise (see the content of) another? EXACT mirror of
 * `can_supervise` on the server (the source of truth stays server-side; this only adjusts the UI).
 * Owner → everyone; admin → members only; member → no one. */
function canSupervise(actor: Role, target: Role): boolean {
  if (actor === "owner") return target !== "owner";
  if (actor === "admin") return target === "member";
  return false;
}

function MembersSection({
  user,
  ws,
  onChanged,
  onOpenPage,
}: {
  user: User;
  ws: Workspace | null;
  onChanged: () => void;
  onOpenPage: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<Member | null>(null);
  const isOwner = user.role === "owner";

  if (!ws) return <ListRowsSkeleton />;

  // Supervision view of a member (their pages): replaces the list.
  if (viewing) {
    return <MemberSupervision member={viewing} onBack={() => setViewing(null)} onOpenPage={onOpenPage} />;
  }

  const invite = async () => {
    const e = email.trim();
    if (!e) return;
    setBusy(true);
    try {
      await inviteMember(e, role);
      setEmail("");
      toast.success(t("settings.members.inviteSent", { email: e }));
      onChanged();
    } catch {
      toast.error(t("settings.members.inviteFailed"));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<void>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      onChanged();
    } catch {
      toast.error(t("settings.members.actionDenied"));
    }
  };

  return (
    <div>
      <SectionTitle>{t("settings.members.title")}</SectionTitle>

      <RolePermissionsInfo />

      <div className="mb-4 space-y-2">
        <Label className="text-sm">{t("settings.members.inviteByEmail")}</Label>
        <div className="flex gap-2">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("settings.members.invitePlaceholder")}
            onKeyDown={(e) => e.key === "Enter" && void invite()}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="rounded-md border bg-background px-2 text-sm"
          >
            <option value="member">{t("settings.role.member")}</option>
            {isOwner && <option value="admin">{t("settings.role.admin")}</option>}
          </select>
          <Button onClick={() => void invite()} disabled={busy || !email.trim()}>
            {t("settings.members.invite")}
          </Button>
        </div>
      </div>

      <ul className="space-y-1">
        {ws.members.map((m) => (
          <MemberRow
            key={m.id}
            m={m}
            me={user}
            isOwner={isOwner}
            act={act}
            onView={
              m.id !== user.id && canSupervise(user.role, m.role) ? () => setViewing(m) : undefined
            }
          />
        ))}
      </ul>

      {ws.invites.length > 0 && (
        <>
          <h3 className="mt-6 mb-2 text-sm font-semibold text-muted-foreground">{t("settings.members.pending")}</h3>
          <ul className="space-y-1">
            {ws.invites.map((inv) => (
              <li key={inv.email} className="flex items-center justify-between rounded px-2 py-1.5 text-sm">
                <span className="truncate text-muted-foreground">{inv.email}</span>
                <span className="flex items-center gap-2">
                  <RoleBadge role={inv.role} />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("settings.members.revoke")}
                    onClick={() => void act(() => revokeInvite(inv.email), t("settings.members.revoked"))}
                  >
                    <Trash2 />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Management action requiring explicit confirmation before execution. */
type PendingAction = {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive: boolean;
  run: () => Promise<void>;
  ok: string;
  /** If present, the user must retype this text to unlock the action. */
  challenge?: string;
};

function MemberRow({
  m,
  me,
  isOwner,
  act,
  onView,
}: {
  m: Member;
  me: User;
  isOwner: boolean;
  act: (fn: () => Promise<void>, ok: string) => Promise<void>;
  /** Present if the current supervisor can see this member's pages. */
  onView?: () => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [running, setRunning] = useState(false);
  const [challengeInput, setChallengeInput] = useState("");
  const disabled = m.status !== "active";
  const isSelf = m.id === me.id;
  const canDemote = isOwner && m.role !== "owner" && !isSelf;
  const canRemove = !isSelf && m.role !== "owner" && (me.role === "owner" || m.role === "member");
  const canTransfer = isOwner && m.role !== "owner" && !disabled;

  const changeRole = (next: Role) => {
    if (next === m.role) return;
    const promote = next === "admin";
    setPending({
      title: promote
        ? t("settings.members.promoteTitle", { name: m.display_name })
        : t("settings.members.demoteTitle", { name: m.display_name }),
      body: promote
        ? t("settings.members.promoteBody", { name: m.display_name })
        : t("settings.members.demoteBody", { name: m.display_name }),
      confirmLabel: promote ? t("settings.members.promoteConfirm") : t("settings.members.demoteConfirm"),
      destructive: !promote,
      run: () => setMemberRole(m.id, next),
      ok: t("settings.members.roleUpdated"),
    });
  };

  const confirmTransfer = () => {
    setChallengeInput("");
    setPending({
      title: t("settings.members.transferTitle", { name: m.display_name }),
      body: t("settings.members.transferBody", { name: m.display_name }),
      confirmLabel: t("settings.members.transferConfirm"),
      destructive: true,
      run: () => transferOwnership(m.id),
      ok: t("settings.members.transferred"),
      challenge: m.email,
    });
  };

  const confirmRemove = () =>
    setPending({
      title: t("settings.members.removeTitle", { name: m.display_name }),
      body: t("settings.members.removeBody", { name: m.display_name }),
      confirmLabel: t("settings.members.removeConfirm"),
      destructive: true,
      run: () => removeMember(m.id),
      ok: t("settings.members.removed"),
    });

  const execute = async () => {
    if (!pending) return;
    setRunning(true);
    await act(pending.run, pending.ok);
    setRunning(false);
    setPending(null);
    setChallengeInput("");
  };

  return (
    <li className="flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-accent">
      <span className="flex min-w-0 items-center gap-2">
        <Avatar name={m.display_name} config={avatarConfig(m.avatar)} size={26} />
        <span className="min-w-0">
          <span className={cn("block truncate text-sm", disabled && "text-muted-foreground line-through")}>
            {m.display_name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {disabled && <span className="text-xs text-muted-foreground">{t("settings.members.disabled")}</span>}
        {onView && (
          <Button
            size="icon-xs"
            variant="ghost"
            title={t("settings.members.viewPages")}
            aria-label={t("settings.members.viewPages")}
            onClick={onView}
          >
            <Eye />
          </Button>
        )}
        {canDemote ? (
          <select
            value={m.role}
            onChange={(e) => changeRole(e.target.value as Role)}
            className="rounded-md border bg-background px-1.5 py-0.5 text-xs"
            aria-label={t("settings.members.roleAria")}
          >
            <option value="member">{t("settings.role.member")}</option>
            <option value="admin">{t("settings.role.admin")}</option>
          </select>
        ) : (
          <RoleBadge role={m.role} />
        )}
        {canTransfer && (
          <Button
            size="icon-xs"
            variant="ghost"
            title={t("settings.members.transfer")}
            aria-label={t("settings.members.transfer")}
            onClick={confirmTransfer}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Crown />
          </Button>
        )}
        {canRemove && !disabled && (
          <Button
            size="icon-xs"
            variant="ghost"
            title={t("settings.members.disableMember")}
            aria-label={t("settings.members.disableMember")}
            onClick={confirmRemove}
          >
            <Trash2 />
          </Button>
        )}
      </span>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o && !running) {
            setPending(null);
            setChallengeInput("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {pending?.destructive && <AlertTriangle className="size-4 text-destructive" />}
              {pending?.title}
            </AlertDialogTitle>
            <AlertDialogDescription>{pending?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {pending?.challenge && (
            <div className="space-y-1.5 text-sm">
              <p className="text-muted-foreground">
                {t("settings.members.challenge", { value: pending.challenge })}
              </p>
              <Input
                value={challengeInput}
                onChange={(e) => setChallengeInput(e.target.value)}
                placeholder={pending.challenge}
                autoComplete="off"
                autoFocus
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>{t("settings.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void execute();
              }}
              disabled={running || (pending?.challenge != null && challengeInput.trim() !== pending.challenge)}
              className={cn(
                pending?.destructive &&
                  "bg-red-700 text-white hover:bg-red-800 disabled:opacity-100 disabled:bg-destructive/50 disabled:text-white",
              )}
            >
              {pending?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** Human-readable label for a share level (pages the member is invited to). */
function levelLabel(level: string): string {
  return i18n.t(`settings.level.${level}` as "settings.level.read");
}

/** Supervision of a member: lists their pages (owned + shared). Opening a
 * page navigates to it READ-ONLY (supervision access is verified
 * server-side; the supervisor can neither edit nor delete). */
function MemberSupervision({
  member,
  onBack,
  onOpenPage,
}: {
  member: Member;
  onBack: () => void;
  onOpenPage: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<{ owned: MemberPage[]; shared: MemberPage[] } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    getMemberPages(member.id)
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [member.id]);

  const pageRow = (p: MemberPage) => (
    <li key={p.id}>
      <button
        type="button"
        onClick={() => onOpenPage(p.id)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
      >
        <ItemIcon icon={p.icon} kind={p.is_database ? "database" : "page"} size={16} />
        <span className="min-w-0 flex-1 truncate">{p.title || t("settings.supervision.untitled")}</span>
        {p.level && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {levelLabel(p.level)}
          </span>
        )}
      </button>
    </li>
  );

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> {t("settings.supervision.back")}
      </button>

      <div className="mb-4 flex items-center gap-2">
        <Avatar name={member.display_name} config={avatarConfig(member.avatar)} size={32} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{member.display_name}</p>
          <p className="truncate text-xs text-muted-foreground">{member.email}</p>
        </div>
      </div>

      <p className="mb-4 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {t("settings.supervision.note")}
      </p>

      {error && <p className="text-sm text-destructive">{t("settings.supervision.loadFailed")}</p>}
      {!error && !data && <ListRowsSkeleton />}
      {data && (
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
              {t("settings.supervision.owned", { count: data.owned.length })}
            </h3>
            {data.owned.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">{t("settings.supervision.noOwned")}</p>
            ) : (
              <ul className="space-y-0.5">{data.owned.map(pageRow)}</ul>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
              {t("settings.supervision.sharedWith", { count: data.shared.length })}
            </h3>
            {data.shared.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">{t("settings.supervision.noShared")}</p>
            ) : (
              <ul className="space-y-0.5">{data.shared.map(pageRow)}</ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Trash action awaiting confirmation (one or more pages). */
type TrashPending = { action: "restore" | "purge"; items: TrashItem[] };

/** Trash: deleted pages (soft-delete), restorable for 30 days. Multiple
 * selection (all/partial) + bulk restore or permanent deletion,
 * each confirmed. Each user sees their own; an admin/owner also sees
 * those of the members they supervise ("Other members"). */
function TrashSection({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const [data, setData] = useState<{ mine: TrashItem[]; others: TrashItem[] } | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<TrashPending | null>(null);
  const [running, setRunning] = useState(false);

  const load = () => {
    setError(false);
    setSelected(new Set());
    getTrash()
      .then(setData)
      .catch(() => setError(true));
  };
  useEffect(load, []);

  const all: TrashItem[] = data ? [...data.mine, ...data.others] : [];
  const byId = new Map(all.map((it) => [it.id, it]));
  const allSelected = all.length > 0 && selected.size === all.length;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSelected((s) => (s.size === all.length ? new Set() : new Set(all.map((it) => it.id))));

  const selectedItems = () => [...selected].map((id) => byId.get(id)).filter((x): x is TrashItem => !!x);

  const run = async () => {
    if (!pending) return;
    setRunning(true);
    const act = pending.action === "restore" ? restoreItem : purgeItem;
    const results = await Promise.allSettled(pending.items.map((it) => act(it.id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    const done = pending.items.length - failed;
    if (done > 0) {
      toast.success(
        pending.action === "restore"
          ? t("settings.trash.restoredToast", { count: done })
          : t("settings.trash.purgedToast", { count: done }),
      );
    }
    if (failed > 0) toast.error(t("settings.trash.failedToast", { count: failed }));
    setRunning(false);
    setPending(null);
    load();
  };

  const row = (it: TrashItem, showOwner: boolean) => (
    <li key={it.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
      <Checkbox
        checked={selected.has(it.id)}
        onCheckedChange={() => toggle(it.id)}
        aria-label={t("settings.trash.selectItem", { name: it.title || t("settings.trash.untitled") })}
      />
      <ItemIcon icon={it.icon} kind={it.is_database ? "database" : "page"} size={16} />
      <span className="min-w-0 flex-1 truncate">
        {it.title || t("settings.trash.untitled")}
        <span className="ml-2 text-xs text-muted-foreground">
          {t("settings.trash.deletedOn", { date: formatDate(it.deleted_ts) })}
          {showOwner && it.owner_name ? ` · ${it.owner_name}` : ""}
        </span>
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        title={t("settings.trash.restore")}
        aria-label={t("settings.trash.restore")}
        onClick={() => setPending({ action: "restore", items: [it] })}
      >
        <RotateCcw />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        title={t("settings.trash.purge")}
        aria-label={t("settings.trash.purge")}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setPending({ action: "purge", items: [it] })}
      >
        <Trash2 />
      </Button>
    </li>
  );

  const purging = pending?.action === "purge";
  const n = pending?.items.length ?? 0;

  return (
    <div>
      <SectionTitle>{t("settings.trash.title")}</SectionTitle>
      <p className="mb-4 text-sm text-muted-foreground">{t("settings.trash.retention")}</p>
      {error && <p className="text-sm text-destructive">{t("settings.trash.loadFailed")}</p>}
      {!error && !data && <ListRowsSkeleton />}

      {data && all.length === 0 && <p className="px-2 text-sm text-muted-foreground">{t("settings.trash.empty")}</p>}

      {data && all.length > 0 && (
        <>
          {/* Selection bar: check all + bulk actions. */}
          <div className="mb-2 flex items-center gap-2 border-b pb-2">
            <Checkbox
              checked={allSelected}
              onCheckedChange={toggleAll}
              aria-label={t("settings.trash.selectAll")}
            />
            <span className="text-sm text-muted-foreground">
              {selected.size > 0 ? t("settings.trash.selected", { count: selected.size }) : t("settings.trash.selectAll")}
            </span>
            {selected.size > 0 && (
              <span className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPending({ action: "restore", items: selectedItems() })}
                >
                  <RotateCcw className="mr-1 size-3.5" /> {t("settings.trash.restore")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setPending({ action: "purge", items: selectedItems() })}
                >
                  <Trash2 className="mr-1 size-3.5" /> {t("settings.trash.delete")}
                </Button>
              </span>
            )}
          </div>

          <div className="space-y-5">
            <div>
              <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
                {t("settings.trash.mine", { count: data.mine.length })}
              </h3>
              {data.mine.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground">{t("settings.trash.none")}</p>
              ) : (
                <ul className="space-y-0.5">{data.mine.map((it) => row(it, false))}</ul>
              )}
            </div>
            {isAdmin && data.others.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
                  {t("settings.trash.others", { count: data.others.length })}
                </h3>
                <ul className="space-y-0.5">{data.others.map((it) => row(it, true))}</ul>
              </div>
            )}
          </div>
        </>
      )}

      {/* Confirmation (restore or permanent deletion). */}
      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && !running && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {purging && <AlertTriangle className="size-4 text-destructive" />}
              {purging
                ? t("settings.trash.purgeTitle", { count: n })
                : t("settings.trash.restoreTitle", { count: n })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {purging ? t("settings.trash.purgeDesc") : t("settings.trash.restoreDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>{t("settings.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={running}
              onClick={(e) => {
                e.preventDefault();
                void run();
              }}
              className={cn(
                purging &&
                  "bg-red-700 text-white hover:bg-red-800 disabled:bg-destructive/50 disabled:text-white",
              )}
            >
              {purging ? t("settings.trash.purge") : t("settings.trash.restore")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function WorkspaceSection({ ws, onChanged }: { ws: Workspace | null; onChanged: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  useEffect(() => setName(ws?.name ?? ""), [ws?.name]);
  if (!ws) return <TextLinesSkeleton lines={3} />;

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === ws.name) return;
    try {
      await updateWorkspace({ name: trimmed });
      toast.success(t("settings.workspace.renamed"));
      onChanged();
    } catch {
      toast.error(t("settings.workspace.renameFailed"));
    }
  };

  const setReg = async (registration: "invite" | "open") => {
    if (registration === ws.registration) return;
    try {
      await updateWorkspace({ registration });
      toast.success(t("settings.workspace.regUpdated"));
      onChanged();
    } catch {
      toast.error(t("settings.workspace.failed"));
    }
  };

  return (
    <div>
      <SectionTitle>{t("settings.workspace.title")}</SectionTitle>
      <div className="py-3">
        <Label htmlFor="ws-name" className="mb-1.5 block text-sm">
          {t("settings.workspace.name")}
        </Label>
        <div className="flex gap-2">
          <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void saveName()} />
          <Button onClick={() => void saveName()} disabled={!name.trim() || name.trim() === ws.name}>
            {t("settings.workspace.save")}
          </Button>
        </div>
      </div>

      <h3 className="mt-6 mb-2 text-sm font-semibold text-muted-foreground">{t("settings.workspace.registration")}</h3>
      <div className="space-y-2">
        {(
          [
            ["invite", t("settings.workspace.inviteOnly"), t("settings.workspace.inviteOnlyDesc")],
            ["open", t("settings.workspace.open"), t("settings.workspace.openDesc")],
          ] as const
        ).map(([value, label, desc]) => (
          <button
            key={value}
            type="button"
            onClick={() => void setReg(value)}
            className={cn(
              "flex w-full flex-col items-start rounded-md border p-3 text-left transition-colors",
              ws.registration === value ? "border-primary bg-accent" : "hover:bg-accent/50",
            )}
          >
            <span className="text-sm font-medium">{label}</span>
            <span className="text-xs text-muted-foreground">{desc}</span>
          </button>
        ))}
      </div>

      <UpdateCheckSetting />
    </div>
  );
}

/** Setting (admin): enable/disable automatic update checks.
 * Allows revisiting the choice made at the first-launch prompt. */
function UpdateCheckSetting() {
  const { t } = useTranslation();
  const [consent, setConsent] = useState<UpdateConsent | null>(null);
  const [version, setVersion] = useState("");
  const [canApply, setCanApply] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    getUpdateConsent()
      .then((r) => {
        if (!alive) return;
        setConsent(r.consent);
        setVersion(r.version);
        setCanApply(r.can_apply);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async (on: boolean) => {
    const next: UpdateConsent = on ? "on" : "off";
    const prev = consent;
    setConsent(next); // optimistic
    try {
      await setUpdateConsent(next);
    } catch {
      setConsent(prev); // rollback if the call fails
    }
  };

  const checkNow = async () => {
    setChecking(true);
    setResult(null);
    try {
      setResult(await checkForUpdates());
    } catch {
      setResult({ current: version, latest: null, available: false, notes: null, url: null, error: "network" });
    } finally {
      setChecking(false);
    }
  };

  if (consent === null) return null;

  return (
    <>
      <h3 className="mt-6 mb-2 text-sm font-semibold text-muted-foreground">
        {t("settings.updates.title")}
      </h3>
      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("settings.updates.check")}</p>
          <p className="text-xs text-muted-foreground">{t("settings.updates.checkDesc")}</p>
          {version && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.updates.current", { version })}
            </p>
          )}
        </div>
        <Switch checked={consent === "on"} onCheckedChange={(v) => void toggle(v)} />
      </div>

      <div className="mt-2">
        <Button variant="outline" size="sm" disabled={checking} onClick={() => void checkNow()}>
          {checking ? t("settings.updates.checking") : t("settings.updates.checkNow")}
        </Button>
      </div>

      {/* Inline result (not just a toast) — immediate feedback + update channel. */}
      {result && !checking && (
        <div className="mt-2 rounded-md border p-3 text-sm">
          {result.error ? (
            <p className="text-destructive">{t("settings.updates.checkFailed")}</p>
          ) : result.available ? (
            <div className="space-y-2">
              <p className="font-medium">
                {t("settings.updates.available", { version: result.latest ?? "" })}
              </p>
              {result.notes && <p className="text-xs text-muted-foreground">{result.notes}</p>}
              <div className="flex flex-wrap gap-2">
                {canApply && result.latest && (
                  <Button size="sm" onClick={() => setApplyOpen(true)}>
                    {t("updateApply.apply")}
                  </Button>
                )}
                {result.url && (
                  <Button
                    size="sm"
                    variant={canApply ? "outline" : "default"}
                    onClick={() => window.open(result.url!, "_blank", "noopener,noreferrer")}
                  >
                    {t("settings.updates.viewRelease")}
                  </Button>
                )}
              </div>
              {result.latest && (
                <UpdateApplyDialog
                  open={applyOpen}
                  onOpenChange={setApplyOpen}
                  targetVersion={result.latest}
                />
              )}
            </div>
          ) : (
            <p className="text-muted-foreground">{t("settings.updates.upToDate")}</p>
          )}
        </div>
      )}
    </>
  );
}
