import { type ReactNode, useEffect, useState } from "react";

import { Avatar } from "@/components/Avatar";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ListRowsSkeleton, TextLinesSkeleton } from "@/components/ui/skeletons";
import { type PageEvent, type PageViews, getEvents, getViews } from "@/lib/api";
import { colorFromName } from "@/lib/presence";
import { relative } from "@/lib/time";
import { formatDate } from "@/lib/locale";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

type Tab = "changes" | "analytics";

/** Side drawer: timeline of modifications + analytical data. */
export function HistoryDrawer({
  itemId,
  open,
  onOpenChange,
  onNavigate,
}: {
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("changes");
  const [events, setEvents] = useState<PageEvent[] | null>(null);
  const [analytics, setAnalytics] = useState<PageViews | null>(null);

  useEffect(() => {
    if (!open) return;
    setEvents(null);
    setAnalytics(null);
    getEvents(itemId)
      .then(setEvents)
      .catch(() => setEvents([]));
    getViews(itemId)
      .then(setAnalytics)
      .catch(() => setAnalytics({ views: [], total: 0, unique: 0 }));
  }, [open, itemId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b pb-3">
          <SheetTitle>{t("history.title")}</SheetTitle>
<SheetDescription className="sr-only">{t("history.desc")}</SheetDescription>
          <div className="mt-2 flex gap-1">
            <TabButton active={tab === "changes"} onClick={() => setTab("changes")}>
              {t("history.tab.changes")}
            </TabButton>
            <TabButton active={tab === "analytics"} onClick={() => setTab("analytics")}>
              {t("history.tab.analytics")}
            </TabButton>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {tab === "changes" ? (
            <ChangesTab events={events} onNavigate={onNavigate} />
          ) : (
            <AnalyticsTab data={analytics} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
      )}
    >
      {children}
    </button>
  );
}

function ChangesTab({
  events,
  onNavigate,
}: {
  events: PageEvent[] | null;
  onNavigate?: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (events == null) return <ListRowsSkeleton />;
  if (events.length === 0)
    return <p className="text-sm text-muted-foreground">{t("history.noChanges")}</p>;

  return (
    <ul className="space-y-4">
      {events.map((e) => {
        const title = e.title?.trim() || t("common.untitled");
        const clickable = e.kind !== "deleted" && onNavigate;
        return (
          <li key={e.id} className="flex gap-2.5">
            <Avatar name={e.display_name} color={colorFromName(e.display_name)} size={24} />
            <div className="min-w-0 flex-1">
              <div className="text-sm leading-snug">
                <span className="font-medium">{e.display_name}</span>{" "}
                <span className="text-muted-foreground">{t(`history.verb.${e.kind}` as "history.verb.created")}</span>{" "}
                {clickable ? (
                  <button
                    type="button"
                    onClick={() => onNavigate(e.item_id)}
                    className="font-medium text-foreground hover:underline"
                  >
                    {title}
                  </button>
                ) : (
                  <span className="font-medium">{title}</span>
                )}
              </div>
              <div
                className="text-xs text-muted-foreground"
                title={formatDate(e.ts, { dateStyle: "medium", timeStyle: "short" })}
              >
                {relative(e.ts)}
              </div>
              {e.changes && e.changes.length > 0 && (
                <ul className="mt-2 space-y-1.5 border-l pl-3">
                  {e.changes.map((c) => (
                    <li key={c.field} className="text-xs">
                      <div className="text-muted-foreground">{c.label}</div>
                      <div className="flex flex-wrap items-center gap-1">
                        {c.old != null && (
                          <>
                            <span className="text-muted-foreground line-through">{c.old}</span>
                            <span className="text-muted-foreground">→</span>
                          </>
                        )}
                        <span className="font-medium text-foreground">{c.new ?? t("common.empty")}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function AnalyticsTab({ data }: { data: PageViews | null }) {
  const { t } = useTranslation();
  if (data == null) return <TextLinesSkeleton lines={5} />;

  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{data.total}</span>{" "}
        {t("history.viewsWord", { count: data.total })} ·{" "}
        <span className="font-medium text-foreground">{data.unique}</span>{" "}
        {t("history.readersWord", { count: data.unique })}
      </p>
      {data.views.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("history.noViews")}</p>
      ) : (
        <ul className="space-y-1">
          {data.views.map((v) => (
            <li key={v.user_id} className="flex items-center gap-2 rounded px-1 py-1.5">
              <Avatar name={v.display_name} color={colorFromName(v.display_name)} size={24} />
              <span className="min-w-0 flex-1 truncate text-sm">{v.display_name}</span>
              <span
                className="shrink-0 text-xs text-muted-foreground"
                title={formatDate(v.last_ts, { dateStyle: "medium", timeStyle: "short" })}
              >
                {v.views} {t("history.viewsWord", { count: v.views })} · {relative(v.last_ts)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
