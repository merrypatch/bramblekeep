import { useState } from "react";
import { useTranslation } from "react-i18next";
import { genConfig, type AvatarFullConfig } from "react-nice-avatar";

import { Ban, FileText, Grid3x3, Grip, Languages, Laptop, Moon, Plus, Shuffle, Sparkles, Sun, Users } from "lucide-react";

import { LANGUAGES, LANGUAGE_FLAGS, LANGUAGE_NAMES, setLanguage, type Language } from "@/i18n";
import { Avatar, avatarConfig } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateMe, type User } from "@/lib/api";
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
import { getTheme, setTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

// First-login welcome funnel: alternates settings and short explanations.
// Order: language → intro → name → "pages" → avatar → "collaboration" → theme
//        → appearance → done.
// Language comes first so the rest of the funnel renders in the chosen language.
type StepKind =
  | "language"
  | "intro"
  | "name"
  | "pitchPages"
  | "avatar"
  | "pitchCollab"
  | "theme"
  | "appearance"
  | "done";
const STEPS: StepKind[] = [
  "language",
  "intro",
  "name",
  "pitchPages",
  "avatar",
  "pitchCollab",
  "theme",
  "appearance",
  "done",
];

/** Explanatory (pitch) screens: icon + a `pitch.<key>` translation. */
const PITCH: Record<string, { icon: typeof FileText; key: string }> = {
  intro: { icon: Sparkles, key: "intro" },
  pitchPages: { icon: FileText, key: "pages" },
  pitchCollab: { icon: Users, key: "collab" },
};

export function OnboardingFlow({ user, onDone }: { user: User; onDone: (u: User) => void }) {
  const { t, i18n } = useTranslation();
  const [i, setI] = useState(0);
  const [lang, setLang] = useState<Language>(() => i18n.language as Language);
  const [name, setName] = useState(user.display_name);
  const [avatar, setAvatar] = useState<AvatarFullConfig>(
    () => avatarConfig(user.avatar) ?? genConfig(user.display_name),
  );
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [grid, setGridState] = useState<GridPattern>(getGrid());
  const [accent, setAccentState] = useState<Accent>(getAccent());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const step = STEPS[i];
  const isLast = i === STEPS.length - 1;
  const nameValid = name.trim().length > 0 && name.trim().length <= 80;

  function chooseTheme(next: Theme) {
    setThemeState(next);
    setTheme(next); // applied live so the user sees the effect immediately
  }

  function chooseLang(next: Language) {
    setLang(next);
    setLanguage(next); // applied live → the rest of the funnel switches language
  }

  // Grid + accent: apply AND persist immediately (localStorage, like the
  // theme); the funnel preview changes live.
  function chooseGrid(next: GridPattern) {
    setGridState(next);
    setGrid(next);
  }
  function chooseAccent(next: Accent) {
    setAccentState(next);
    setAccent(next);
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const u = await updateMe({
        display_name: name.trim(),
        avatar: JSON.stringify(avatar),
        language: lang,
        onboarded: true,
      });
      setTheme(theme); // persist choice (already applied)
      onDone(u);
    } catch {
      setError(t("onboarding.saveError"));
      setBusy(false);
    }
  }

  function next() {
    if (step === "name" && !nameValid) return;
    if (isLast) {
      void finish();
      return;
    }
    setI((n) => Math.min(n + 1, STEPS.length - 1));
  }

  const themes: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "light", label: t("onboarding.theme.light"), icon: Sun },
    { value: "dark", label: t("onboarding.theme.dark"), icon: Moon },
    { value: "system", label: t("onboarding.theme.system"), icon: Laptop },
  ];

  const grids: { value: GridPattern; label: string; icon: typeof Sun }[] = [
    { value: "plus", label: t("settings.grid.plus"), icon: Plus },
    { value: "dots", label: t("settings.grid.dots"), icon: Grip },
    { value: "lines", label: t("settings.grid.lines"), icon: Grid3x3 },
    { value: "none", label: t("settings.grid.none"), icon: Ban },
  ];

  return (
    <div className="dot-grid flex min-h-dvh items-center justify-center bg-background p-6">
      {/* Content on a solid card: the funnel doesn't "float" over the grid
          (same UX choice as tables). The grid stays as a frame around it
          — and serves as a live preview for the "appearance" step. */}
      <div className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-lg sm:p-8">
        {/* Progress + skip. */}
        <div className="mb-8 flex items-center justify-between">
          <div className="flex gap-1.5">
            {STEPS.map((_, n) => (
              <span
                key={n}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  n === i ? "w-6 bg-primary" : n < i ? "w-1.5 bg-primary/50" : "w-1.5 bg-muted",
                )}
              />
            ))}
          </div>
          {!isLast && (
            <button
              type="button"
              onClick={() => void finish()}
              disabled={busy}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t("onboarding.skip")}
            </button>
          )}
        </div>

        <div className="min-h-[19rem]">
          {/* Language. */}
          {step === "language" && (
            <div className="flex flex-col items-center gap-4 pt-6 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Languages className="size-7" />
              </div>
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold tracking-tight">{t("onboarding.language.title")}</h2>
                <p className="text-sm text-muted-foreground">{t("onboarding.language.body")}</p>
              </div>
              <div className="grid w-full grid-cols-3 gap-2">
                {LANGUAGES.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => chooseLang(l)}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-lg border p-3 text-sm transition-colors",
                      lang === l
                        ? "border-primary bg-primary/5 text-foreground"
                        : "text-muted-foreground hover:bg-accent",
                    )}
                  >
                    <span className="text-2xl leading-none">{LANGUAGE_FLAGS[l]}</span>
                    {LANGUAGE_NAMES[l]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Explanatory screens. */}
          {(step === "intro" || step === "pitchPages" || step === "pitchCollab") &&
            (() => {
              const p = PITCH[step];
              const Icon = p.icon;
              return (
                <div className="flex flex-col items-center gap-4 pt-6 text-center">
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Icon className="size-7" />
                  </div>
                  <h2 className="text-2xl font-semibold tracking-tight">
                    {t(`onboarding.pitch.${p.key}.title` as "onboarding.pitch.intro.title")}
                  </h2>
                  <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                    {t(`onboarding.pitch.${p.key}.body` as "onboarding.pitch.intro.body")}
                  </p>
                </div>
              );
            })()}

          {/* Setting: name. */}
          {step === "name" && (
            <div className="space-y-4 pt-6">
              <div className="space-y-1 text-center">
                <h2 className="text-2xl font-semibold tracking-tight">{t("onboarding.name.title")}</h2>
                <p className="text-sm text-muted-foreground">{t("onboarding.name.body")}</p>
              </div>
              <Input
                autoFocus
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && next()}
                placeholder={t("onboarding.name.placeholder")}
                className="text-center"
              />
            </div>
          )}

          {/* Setting: avatar. */}
          {step === "avatar" && (
            <div className="flex flex-col items-center gap-4 pt-6 text-center">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold tracking-tight">{t("onboarding.avatar.title")}</h2>
                <p className="text-sm text-muted-foreground">{t("onboarding.avatar.body")}</p>
              </div>
              <Avatar name={name} config={avatar} size={104} />
              <Button variant="outline" size="sm" onClick={() => setAvatar(genConfig())}>
                <Shuffle className="size-3.5" /> {t("onboarding.avatar.shuffle")}
              </Button>
            </div>
          )}

          {/* Setting: theme. */}
          {step === "theme" && (
            <div className="space-y-4 pt-6">
              <div className="space-y-1 text-center">
                <h2 className="text-2xl font-semibold tracking-tight">{t("onboarding.theme.title")}</h2>
                <p className="text-sm text-muted-foreground">{t("onboarding.theme.body")}</p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {themes.map((opt) => {
                  const Icon = opt.icon;
                  const active = theme === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => chooseTheme(opt.value)}
                      className={cn(
                        "flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors",
                        active
                          ? "border-primary bg-primary/5 text-foreground"
                          : "text-muted-foreground hover:bg-accent",
                      )}
                    >
                      <Icon className="size-5" />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Setting: appearance (accent + background grid) — the visual signature. */}
          {step === "appearance" && (
            <div className="space-y-5 pt-6">
              <div className="space-y-1 text-center">
                <h2 className="text-2xl font-semibold tracking-tight">{t("onboarding.appearance.title")}</h2>
                <p className="text-sm text-muted-foreground">{t("onboarding.appearance.body")}</p>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">{t("settings.accent.label")}</p>
                <div className="flex justify-center gap-2">
                  {ACCENTS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      title={t(`settings.accent.${a}`)}
                      aria-label={t(`settings.accent.${a}`)}
                      aria-pressed={accent === a}
                      onClick={() => chooseAccent(a)}
                      style={{ backgroundColor: ACCENT_SWATCH[a] }}
                      className={cn(
                        "size-8 rounded-full ring-offset-2 ring-offset-background transition-shadow",
                        accent === a ? "ring-2 ring-ring" : "ring-1 ring-border hover:ring-ring/50",
                      )}
                    />
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">{t("settings.grid.label")}</p>
                <div className="grid grid-cols-4 gap-2">
                  {grids.map((opt) => {
                    const Icon = opt.icon;
                    const active = grid === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => chooseGrid(opt.value)}
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs transition-colors",
                          active
                            ? "border-primary bg-primary/5 text-foreground"
                            : "text-muted-foreground hover:bg-accent",
                        )}
                      >
                        <Icon className="size-5" />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Done. */}
          {step === "done" && (
            <div className="flex flex-col items-center gap-4 pt-6 text-center">
              <Avatar name={name} config={avatar} size={88} />
              <h2 className="text-2xl font-semibold tracking-tight">
                {t("onboarding.done.title", { name: name.trim() })}
              </h2>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                {t("onboarding.done.body")}
              </p>
            </div>
          )}
        </div>

        {error && <p className="mb-2 text-center text-xs text-destructive">{error}</p>}

        {/* Navigation. */}
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button variant="ghost" onClick={() => setI((n) => Math.max(n - 1, 0))} disabled={i === 0 || busy}>
            {t("onboarding.back")}
          </Button>
          <Button onClick={next} disabled={busy || (step === "name" && !nameValid)}>
            {isLast ? t("onboarding.start") : t("onboarding.continue")}
          </Button>
        </div>
      </div>
    </div>
  );
}
