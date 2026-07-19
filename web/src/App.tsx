import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import { APP_NAME } from "@/lib/brand";
import { PublishConsentProvider } from "@/lib/publishConsent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppShellSkeleton, PageSkeleton } from "@/components/ui/skeletons";

// Code-split: each major screen is a separate chunk. The public route then does
// NOT pull in the `Shell` graph (editor, db views, sidebar…) — a lighter public
// page, and in dev fewer modules loaded (avoids the browser OOM).
const Shell = lazy(() => import("@/components/Shell").then((m) => ({ default: m.Shell })));
const PublicPage = lazy(() =>
  import("@/components/PublicPage").then((m) => ({ default: m.PublicPage })),
);
const InvitePage = lazy(() =>
  import("@/components/InvitePage").then((m) => ({ default: m.InvitePage })),
);
const OnboardingFlow = lazy(() =>
  import("@/components/OnboardingFlow").then((m) => ({ default: m.OnboardingFlow })),
);
import { getMe, logout, requestLink, verifyToken, type User } from "@/lib/api";
import { isLanguage, setLanguage } from "@/i18n";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Magic-link verification page: consumes the token then reloads on /. */
function VerifyPage() {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setFailed(true);
      return;
    }
    verifyToken(token)
      .then(() => {
        window.location.href = "/"; // reload → App re-runs getMe, authenticated
      })
      .catch(() => setFailed(true));
  }, []);
  return <Centered>{failed ? t("auth.linkInvalid") : t("auth.verifying")}</Centered>;
}

/** Passwordless login screen: email → magic link. */
function Login() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await requestLink(email);
      setSent(true);
    } catch {
      setError(t("auth.sendFailed"));
    }
  }

  return (
    <div className="dot-grid flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="space-y-1 text-center">
          <h1 className="font-brand text-4xl font-bold tracking-tight">{APP_NAME}</h1>
          <p className="text-sm text-muted-foreground">{t("auth.brandSubtitle")}</p>
        </div>
        {sent ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm">
            {t("auth.sent", { email })}
            <br />
            <span className="text-xs text-muted-foreground">{t("invite.devNote")}</span>
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <Input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("auth.emailPlaceholder")}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button type="submit" className="w-full">
              {t("auth.getLink")}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Authentication gate: /auth/verify always passes; otherwise login is required. */
export default function App() {
  const location = useLocation();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    getMe()
      .then((u) => {
        // Apply the account's language (source of truth) over the boot cache.
        if (isLanguage(u.language)) setLanguage(u.language);
        setUser(u);
      })
      .catch(() => setUser(null));
  }, []);

  // Public pages: read without login, before any auth requirement.
  if (location.pathname.startsWith("/public/")) {
    return (
      <Suspense fallback={<div className="min-h-dvh"><PageSkeleton /></div>}>
        <PublicPage />
      </Suspense>
    );
  }
  if (location.pathname === "/auth/verify") return <VerifyPage />;
  // /invite handles the logged-in/logged-out states itself (internal getMe).
  if (location.pathname === "/invite") {
    return (
      <Suspense fallback={<div className="min-h-dvh"><PageSkeleton /></div>}>
        <InvitePage />
      </Suspense>
    );
  }
  if (user === undefined) return <AppShellSkeleton />;
  if (!user) return <Login />;

  // First login: welcome funnel until onboarding is completed.
  if (user.onboarded_ts == null) {
    return (
      <Suspense fallback={<div className="min-h-dvh bg-background" />}>
        <OnboardingFlow user={user} onDone={setUser} />
      </Suspense>
    );
  }

  return (
    <PublishConsentProvider>
      <Suspense fallback={<AppShellSkeleton />}>
        <Shell
          user={user}
          onLogout={() => {
            void logout().then(() => setUser(null));
          }}
          onUserChange={setUser}
        />
      </Suspense>
    </PublishConsentProvider>
  );
}
