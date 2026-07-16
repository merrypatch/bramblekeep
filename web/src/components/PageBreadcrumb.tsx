import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ItemIcon, type ItemKind } from "@/components/ItemIcon";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { ancestors, type Crumb } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Icon + title of a crumb (ancestors are containers → default page). */
function CrumbLabel({
  icon,
  title,
  kind,
  iconOnlyMobile,
}: {
  icon: string | null;
  title: string | null;
  kind?: ItemKind;
  /** On mobile, show only the icon (saves space in the trail). */
  iconOnlyMobile?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <ItemIcon icon={icon} kind={kind} size={14} className="shrink-0" />
      <span className={cn("truncate", iconOnlyMobile && "max-sm:hidden")}>{title || t("common.untitled")}</span>
    </span>
  );
}

/** Breadcrumb of the current page: ancestors (root → parent) then the page.
 * An accessible ancestor is clickable; otherwise it stays visible but inert
 * (invited only to a sub-page → we give context without allowing going up). */
export function PageBreadcrumb({
  itemId,
  title,
  icon,
  kind,
  onNavigate,
}: {
  itemId: string;
  title: string | null;
  icon: string | null;
  kind?: ItemKind;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);

  useEffect(() => {
    let alive = true;
    ancestors(itemId)
      .then((c) => alive && setCrumbs(c))
      .catch(() => alive && setCrumbs([]));
    return () => {
      alive = false;
    };
  }, [itemId]);

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((c) => (
          <Fragment key={c.id}>
            <BreadcrumbItem className="min-w-0">
              {c.accessible ? (
                <BreadcrumbLink asChild>
                  <button className="max-w-[10rem]" onClick={() => onNavigate(c.id)}>
                    <CrumbLabel icon={c.icon} title={c.title} iconOnlyMobile />
                  </button>
                </BreadcrumbLink>
              ) : (
                <span
                  className="max-w-[10rem] cursor-default text-muted-foreground/50"
                  title={t("page.noAccess")}
                >
                  <CrumbLabel icon={c.icon} title={c.title} iconOnlyMobile />
                </span>
              )}
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </Fragment>
        ))}
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="max-w-[16rem]">
            <CrumbLabel icon={icon} title={title} kind={kind} />
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
