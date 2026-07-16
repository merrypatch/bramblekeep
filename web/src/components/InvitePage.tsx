import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TextLinesSkeleton } from "@/components/ui/skeletons";
import {
  acceptInvite,
  getMe,
  inviteInfo,
  logout,
  requestLink,
  type InviteInfo,
  type User,
} from "@/lib/api";

type Phase =
  | { k: "loading" }
  | { k: "invalid" }
  | { k: "accepting" }
  | { k: "need-login" }
  | { k: "sent" }
  | { k: "mismatch"; me: string };

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 text-center">{children}</div>
    </div>
  );
}

/** Invitation acceptance page (/invite?token=…). Discovers the invitation
 * (public info), then: logged in with the right email → accepts and opens the page;
 * not logged in → offers passwordless login (email pre-filled). */
export function InvitePage() {
  const navigate = useNavigate();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ k: "loading" });

  useEffect(() => {
    let alive = true;
    if (!token) {
      setPhase({ k: "invalid" });
      return;
    }
    (async () => {
      let invite: InviteInfo;
      try {
        invite = await inviteInfo(token);
      } catch {
        if (alive) setPhase({ k: "invalid" });
        return;
      }
      if (!alive) return;
      setInfo(invite);

      let me: User | null;
      try {
        me = await getMe();
      } catch {
        me = null;
      }
      if (!alive) return;

      if (!me) {
        setPhase({ k: "need-login" });
      } else if (me.email.toLowerCase() !== invite.email.toLowerCase()) {
        setPhase({ k: "mismatch", me: me.email });
      } else {
        // Right account: accept and open the page.
        setPhase({ k: "accepting" });
        try {
          const itemId = await acceptInvite(token);
          if (alive) navigate(`/p/${itemId}`);
        } catch {
          if (alive) setPhase({ k: "invalid" });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, navigate]);

  const title = info?.item_title || t("invite.fallbackPage");

  if (phase.k === "loading" || phase.k === "accepting") {
    return (
      <Card>
        <TextLinesSkeleton lines={3} />
      </Card>
    );
  }

  if (phase.k === "invalid") {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">
{t("invite.invalid")}
        </p>
        <Button variant="outline" onClick={() => navigate("/")}>
          {t("invite.goHome")}
        </Button>
      </Card>
    );
  }

  if (phase.k === "mismatch") {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">
{t("invite.mismatch", { email: info?.email, me: phase.me })}
        </p>
        <Button
          variant="outline"
          onClick={() => void logout().then(() => window.location.reload())}
        >
          {t("invite.switchAccount")}
        </Button>
      </Card>
    );
  }

  if (phase.k === "sent") {
    return (
      <Card>
        <p className="rounded-md border bg-muted/40 p-3 text-sm">
{t("invite.sent", { email: info?.email, title })}
          <br />
<span className="text-xs text-muted-foreground">{t("invite.devNote")}</span>
        </p>
      </Card>
    );
  }

  // need-login
  return (
    <Card>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("invite.title")}</h1>
        <p className="text-sm text-muted-foreground">
{t("invite.inviterInvites", { inviter: info?.inviter, title })}
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (info) void requestLink(info.email).then(() => setPhase({ k: "sent" }));
        }}
        className="space-y-3"
      >
        <Input type="email" value={info?.email ?? ""} readOnly className="text-center" />
        <Button type="submit" className="w-full">
          {t("invite.getLink")}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">{t("invite.passwordless")}</p>
    </Card>
  );
}
