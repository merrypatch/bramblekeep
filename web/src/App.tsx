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
import {
  ApiError,
  type AuthConfig,
  getAuthConfig,
  getMe,
  loginWithPassword,
  logout,
  requestLink,
  signupOwner,
  verifyToken,
  type User,
} from "@/lib/api";
import { StaleClient } from "@/components/StaleClient";
import { useFreshness } from "@/hooks/useFreshness";
import i18n, { isLanguage, setLanguage } from "@/i18n";

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

function AuthShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="dot-grid flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="space-y-1 text-center">
          <h1 className="font-brand text-4xl font-bold tracking-tight">{APP_NAME}</h1>
          <p className="text-sm text-muted-foreground">{t("auth.brandSubtitle")}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Maps an auth failure to a message. Every rejected sign-in gets the same
 * wording on purpose: the server does not say whether the account exists, and
 * the UI must not invent the distinction either. */
function authErrorMessage(e: unknown): string {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 429) return i18n.t("auth.tooMany");
  if (status === 401 || status === 403) return i18n.t("auth.badCredentials");
  // 400 = a rule the server enforces (address shape, password policy); its
  // English detail is more useful than a generic sentence.
  if (status === 400 && e instanceof ApiError && e.message) return e.message;
  return i18n.t("auth.sendFailed");
}

/** First run: the instance has no account yet, so this form creates the owner —
 * with a password, which is what makes an install with no SMTP relay usable. */
function SetupForm({ minPassword, onSignedIn }: { minPassword: number; onSignedIn: (u: User) => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = password.length > 0 && password.length < minPassword;
  const mismatch = confirm.length > 0 && confirm !== password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onSignedIn(await signupOwner(email, password));
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
        {t("auth.setupIntro")}
      </p>
      <Input
        type="email"
        required
        autoFocus
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t("auth.emailPlaceholder")}
      />
      <Input
        type="password"
        required
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={t("auth.passwordPlaceholder", { min: minPassword })}
      />
      <Input
        type="password"
        required
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder={t("auth.confirmPlaceholder")}
      />
      {tooShort && <p className="text-xs text-muted-foreground">{t("auth.passwordTooShort", { min: minPassword })}</p>}
      {mismatch && <p className="text-xs text-destructive">{t("auth.passwordMismatch")}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy || tooShort || mismatch || !password}>
        {t("auth.createAccount")}
      </Button>
    </form>
  );
}

/** Sign-in screen. Two ways in, and which one leads depends on the instance:
 * with an SMTP relay the magic link is offered first (nothing to remember),
 * without one it would be undeliverable, so the password leads. Both stay
 * reachable — a password is the way in when the relay is down. */
function SignInForm({ smtp, onSignedIn }: { smtp: boolean; onSignedIn: (u: User) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"password" | "link">(smtp ? "link" : "password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "link") {
        await requestLink(email);
        setSent(true);
      } else {
        onSignedIn(await loginWithPassword(email, password));
      }
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p className="rounded-md border bg-muted/40 p-3 text-sm">
        {t("auth.sent", { email })}
        {!smtp && (
          <>
            <br />
            <span className="text-xs text-muted-foreground">{t("auth.noSmtpConsole")}</span>
          </>
        )}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Input
        type="email"
        required
        autoFocus
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t("auth.emailPlaceholder")}
      />
      {mode === "password" && (
        <Input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("auth.passwordOnly")}
        />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {mode === "link" ? t("auth.getLink") : t("auth.signIn")}
      </Button>
      <button
        type="button"
        className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => {
          setError(null);
          setMode((m) => (m === "link" ? "password" : "link"));
        }}
      >
        {mode === "link" ? t("auth.usePassword") : t("auth.useLink")}
      </button>
      {mode === "password" && !smtp && (
        <p className="text-center text-xs text-muted-foreground">{t("auth.forgotNoSmtp")}</p>
      )}
    </form>
  );
}

/** Login screen: owner creation on a fresh instance, sign-in otherwise. */
function Login({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  useEffect(() => {
    getAuthConfig()
      // A failing config call must not lock the screen: fall back to the most
      // conservative shape (existing instance, mail available).
      .catch(() => ({ bootstrap: false, smtp: true, min_password: 12 }) satisfies AuthConfig)
      .then(setConfig);
  }, []);

  if (!config) return <AuthShell>{null}</AuthShell>;
  return (
    <AuthShell>
      {config.bootstrap ? (
        <SetupForm minPassword={config.min_password} onSignedIn={onSignedIn} />
      ) : (
        <SignInForm smtp={config.smtp} onSignedIn={onSignedIn} />
      )}
    </AuthShell>
  );
}

/** Authentication gate: /auth/verify always passes; otherwise login is required.
 * Doubles as the freshness gate: nothing that opens a sync socket mounts before
 * the running bundle is confirmed to be this server's (cf. `lib/freshness` — a
 * stale bundle deletes the block types it does not know from the CRDT). */
export default function App() {
  const location = useLocation();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  // Runs in parallel with getMe, so the gate costs no extra round trip.
  const freshness = useFreshness();

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
  if (user === undefined || freshness.state === "checking") return <AppShellSkeleton />;
  if (!user) {
    return (
      <Login
        onSignedIn={(u) => {
          if (isLanguage(u.language)) setLanguage(u.language);
          setUser(u);
        }}
      />
    );
  }
  // Before onboarding too: the welcome funnel writes pages through the CRDT.
  if (freshness.state === "stale") return <StaleClient serverVersion={freshness.serverVersion} />;

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
