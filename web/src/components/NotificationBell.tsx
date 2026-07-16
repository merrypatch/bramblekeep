import { Archive, Bell, Download, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { relative } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  type AppNotification,
  archiveAllNotifications,
  archiveNotification,
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
} from "@/lib/api";

const POLL_MS = 60_000;

/** Icon per notification type. */
function kindIcon(kind: string) {
  switch (kind) {
    case "share":
      return UserPlus;
    case "update":
      return Download;
    default:
      return Bell;
  }
}

/** i18n key of the message per type (strictly typed; default = share). */
const MSG_KEY = {
  share: "notif.msg.share",
  update: "notif.msg.update",
} as const;
function msgKey(kind: string): (typeof MSG_KEY)[keyof typeof MSG_KEY] {
  return MSG_KEY[kind as keyof typeof MSG_KEY] ?? MSG_KEY.share;
}

/** Render params (JSON `payload`) — best-effort, tolerates a missing payload. */
function parsePayload(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Notification center (bell + Vercel-style panel). Current producers:
 * page sharing. Coming (generic): update available, mentions.
 * Delivery via lightweight poll (focus + interval) — no server push.
 */
export function NotificationBell({ onNavigate }: { onNavigate: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"inbox" | "archive">("inbox");
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);

  const refreshCount = useCallback(() => {
    unreadNotificationCount()
      .then(setUnread)
      .catch(() => {});
  }, []);

  // Lightweight poll of the counter: on mount, at interval, and on focus return.
  useEffect(() => {
    refreshCount();
    const id = setInterval(refreshCount, POLL_MS);
    const onFocus = () => refreshCount();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshCount]);

  const load = useCallback(
    (which: "inbox" | "archive") => {
      setLoading(true);
      listNotifications(which === "archive")
        .then((r) => {
          setItems(r.notifications);
          setUnread(r.unread);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    },
    [],
  );

  // On open: load the inbox and mark everything as read (the badge
  // reflects unread items → viewing = reading, like Vercel).
  useEffect(() => {
    if (!open) return;
    setTab("inbox");
    load("inbox");
    markNotificationsRead()
      .then(() => setUnread(0))
      .catch(() => {});
  }, [open, load]);

  const switchTab = (which: "inbox" | "archive") => {
    setTab(which);
    load(which);
  };

  const onArchive = async (id: string) => {
    try {
      await archiveNotification(id);
      setItems((prev) => prev.filter((n) => n.id !== id));
    } catch {
      /* silent: reloaded on the next poll */
    }
  };

  const onArchiveAll = async () => {
    try {
      await archiveAllNotifications();
      setItems([]);
    } catch {
      /* silent */
    }
  };

  const openItem = (n: AppNotification) => {
    setOpen(false);
    if (n.item_id) {
      onNavigate(n.item_id);
      return;
    }
    // Notification without a target item (e.g. update): open the payload URL if present
    // (release page). One-click apply will arrive with the apply phase.
    const url = parsePayload(n.payload).url;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("notif.title")}
          className="relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute top-1 right-1 flex min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80 p-0">
        <div className="flex items-center gap-1 border-b px-2 py-1.5">
          <button
            type="button"
            onClick={() => switchTab("inbox")}
            className={cn(
              "rounded px-2 py-1 text-sm font-medium",
              tab === "inbox" ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t("notif.inbox")}
          </button>
          <button
            type="button"
            onClick={() => switchTab("archive")}
            className={cn(
              "rounded px-2 py-1 text-sm font-medium",
              tab === "archive" ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t("notif.archive")}
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto">
          {loading && items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">…</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {t("notif.empty")}
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((n) => {
                const Icon = kindIcon(n.kind);
                const values = parsePayload(n.payload);
                return (
                  <li key={n.id} className="group/notif relative">
                    <button
                      type="button"
                      onClick={() => openItem(n)}
                      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-accent"
                    >
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm leading-snug">
                          <Trans
                            i18nKey={msgKey(n.kind)}
                            values={values}
                            components={{ b: <span className="font-medium text-foreground" /> }}
                          />
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {relative(n.created_ts)}
                        </span>
                      </span>
                    </button>
                    {tab === "inbox" && (
                      <button
                        type="button"
                        onClick={() => void onArchive(n.id)}
                        aria-label={t("notif.archiveOne")}
                        title={t("notif.archiveOne")}
                        className="absolute top-2 right-2 hidden size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground group-hover/notif:flex"
                      >
                        <Archive className="size-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {tab === "inbox" && items.length > 0 && (
          <div className="border-t p-1">
            <button
              type="button"
              onClick={() => void onArchiveAll()}
              className="w-full rounded px-2 py-1.5 text-center text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t("notif.archiveAll")}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
