import { useTranslation } from "react-i18next";

import { Code2, Cpu, Github, Heart, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

// Real links (cf. git remote). GitHub sponsoring must be enabled on the
// account for the URL to resolve; otherwise it redirects to the profile.
const REPO_URL = "https://github.com/merrypatch/bramblekeep";
const SPONSOR_URL = "https://github.com/sponsors/merrypatch";

// Open-source building blocks that carry the project. Technology names → not translated.
const STACK = [
  "Rust",
  "axum",
  "sqlx",
  "SQLite",
  "yrs / Yjs",
  "React",
  "Vite",
  "BlockNote",
  "shadcn/ui",
  "Tailwind CSS",
  "Chart.js",
];

/** "Credits" page: what makes the project possible + how to contribute.
 * Transparent about the open-source stack AND about AI assistance. Opened from
 * the sidebar card (route /credits). */
export function CreditsPage() {
  const { t } = useTranslation();

  return (
    <div className="dot-grid min-h-[calc(100dvh-3.5rem)]">
      <div className="mx-auto w-full max-w-2xl px-6 py-12">
        <div className="mb-10 flex flex-col items-center gap-4 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Heart className="size-7" />
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">{t("credits.title")}</h1>
          <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">{t("credits.intro")}</p>
        </div>

        {/* Built on open-source. */}
        <section className="mb-6 rounded-xl border bg-background/60 p-5">
          <div className="mb-2 flex items-center gap-2">
            <Code2 className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">{t("credits.built.title")}</h2>
          </div>
          <p className="mb-3 text-sm leading-relaxed text-muted-foreground">{t("credits.built.body")}</p>
          <div className="flex flex-wrap gap-1.5">
            {STACK.map((s) => (
              <span key={s} className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {s}
              </span>
            ))}
          </div>
        </section>

        {/* AI transparency. */}
        <section className="mb-6 rounded-xl border bg-background/60 p-5">
          <div className="mb-2 flex items-center gap-2">
            <Cpu className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">{t("credits.ai.title")}</h2>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{t("credits.ai.body")}</p>
        </section>

        {/* Contribute. */}
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4 text-primary" /> {t("credits.contribute.title")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col rounded-xl border bg-background/60 p-5">
            <h3 className="mb-1 text-sm font-semibold">{t("credits.sponsor.title")}</h3>
            <p className="mb-4 flex-1 text-sm leading-relaxed text-muted-foreground">
              {t("credits.sponsor.body")}
            </p>
            <Button asChild variant="default" size="sm" className="w-full">
              <a href={SPONSOR_URL} target="_blank" rel="noreferrer noopener">
                <Heart className="size-3.5" /> {t("credits.sponsor.cta")}
              </a>
            </Button>
          </div>
          <div className="flex flex-col rounded-xl border bg-background/60 p-5">
            <h3 className="mb-1 text-sm font-semibold">{t("credits.oss.title")}</h3>
            <p className="mb-4 flex-1 text-sm leading-relaxed text-muted-foreground">{t("credits.oss.body")}</p>
            <Button asChild variant="outline" size="sm" className="w-full">
              <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
                <Github className="size-3.5" /> {t("credits.oss.cta")}
              </a>
            </Button>
          </div>
        </div>

        <p className="mt-10 text-center text-xs text-muted-foreground">{t("credits.thanks")}</p>
      </div>
    </div>
  );
}
