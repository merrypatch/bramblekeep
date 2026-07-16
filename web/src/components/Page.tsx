import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { DatabaseView } from "@/components/DatabaseView";
import { Editor } from "@/components/Editor";
import { PageHeader } from "@/components/PageHeader";
import { RowProperties } from "@/components/RowProperties";
import { Button } from "@/components/ui/button";
import { ApiError, getItem, patchItem, type ItemMeta, type MetaPatch } from "@/lib/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { parseSchema } from "@/lib/db";
import { useLivePresence, usePresence } from "@/lib/presence";
import { TEMPLATE_TOKENS } from "@/lib/templateTokens";
import { Copy } from "lucide-react";
import { acquireRoom, releaseRoom, type Room } from "@/lib/room";

/** A page: header (cover, emoji, title) + collaborative editor. */
export function Page({
  itemId,
  currentUserName,
  currentUserAvatar,
  onMetaChange,
}: {
  itemId: string;
  currentUserName: string;
  currentUserAvatar: string | null;
  onMetaChange: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [meta, setMeta] = useState<ItemMeta | null>(null);
  // HTTP status on load failure (403 access removed / page deleted,
  // 404, or 0 = network failure). Null = not yet loaded / OK.
  const [errStatus, setErrStatus] = useState<number | null>(null);

  // Doc + awareness shared between the editor (CRDT + text cursors) and
  // presence (avatars, mouse cursors), via a refcounted cache immune to
  // StrictMode double-mounting (cf. lib/room).
  const [rt, setRt] = useState<Room | null>(null);
  useEffect(() => {
    setRt(acquireRoom(itemId));
    return () => releaseRoom(itemId);
  }, [itemId]);

  const presence = usePresence(rt?.awareness ?? null);

  // If this page is a row of a database, we broadcast our presence
  // (with `location`) into the parent database's room → visible from the db.
  const [parentDbId, setParentDbId] = useState<string | null>(null);
  const [parentDbSchema, setParentDbSchema] = useState<string | null>(null);
  useEffect(() => {
    setParentDbId(null);
    setParentDbSchema(null);
    const parent = meta?.parent_item_id;
    if (!parent) return;
    let alive = true;
    getItem(parent)
      .then((p) => {
        if (alive && p.db_schema != null) {
          setParentDbId(parent);
          setParentDbSchema(p.db_schema);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [meta?.parent_item_id]);
  useLivePresence(parentDbId, currentUserName, currentUserAvatar, itemId);

  useEffect(() => {
    let alive = true;
    setMeta(null);
    setErrStatus(null);
    getItem(itemId)
      .then((m) => {
        if (alive) setMeta(m);
      })
      .catch((e) => {
        if (alive) setErrStatus(e instanceof ApiError ? e.status : 0);
      });
    return () => {
      alive = false;
    };
  }, [itemId]);

  async function update(patch: MetaPatch) {
    const updated = await patchItem(itemId, patch);
    setMeta(updated);
    onMetaChange(); // refreshes the navbar (title + emoji)
  }

  // Load failed: we do NOT open the editor (its WS would return a misleading
  // "backend unreachable" message). We explain based on the status.
  if (errStatus !== null) {
    // 403 (access removed or page deleted — indistinguishable client-side, by
    // design: don't reveal existence) and 404 → same access screen.
    const network = errStatus === 0;
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {network ? t("page.networkTitle") : t("page.unavailableTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
{network ? t("page.networkBody") : t("page.unavailableBody")}
          </p>
        </div>
        <Button variant="outline" onClick={() => navigate("/")}>
          {t("page.backHome")}
        </Button>
      </div>
    );
  }

  // Is this page a template of its parent database?
  const isTemplate =
    !!parentDbSchema && (parseSchema(parentDbSchema).templates ?? []).includes(itemId);

  // No min-h-dvh: under the Shell header (h-14), it would force a
  // vertical overflow (a slight permanent page scroll).
  return (
    <div className="dot-grid relative min-h-[calc(100dvh-3.5rem)]">
      {isTemplate && (
        <div className="absolute top-2 right-4 z-10">
          <Popover>
            <PopoverTrigger asChild>
              <button className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-600 ring-1 ring-amber-500/30 hover:bg-amber-500/25 dark:text-amber-400">
                {t("page.templateBadge")}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <p className="mb-2 text-xs text-muted-foreground">
{t("page.templateInstructions")}
              </p>
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {TEMPLATE_TOKENS.map((tk) => (
                  <button
                    key={tk.token}
                    className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-accent"
                    onClick={() => void navigator.clipboard?.writeText(tk.token)}
                    title={t("page.copy")}
                  >
                    <code className="shrink-0 rounded bg-muted px-1 text-xs">{tk.token}</code>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">{t(`templateTokens.${tk.key}` as "templateTokens.date")}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {t("page.egPrefix")} {tk.example}
                      </span>
                    </span>
                    <Copy className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}
      <PageHeader meta={meta} onChange={update} />
      {/* Database row → its properties at the top (properties header). */}
      {meta && meta.db_schema == null && parentDbId && parentDbSchema && (
        <RowProperties
          rowId={itemId}
          dbId={parentDbId}
          dbSchemaJson={parentDbSchema}
          propertiesJson={meta.properties}
          canEdit={meta.can_edit}
          canManage={meta.can_create ?? false}
        />
      )}
      {/* Database → table view; otherwise editor (mounted after meta is loaded). */}
      {meta?.db_schema != null ? (
        <DatabaseView
          dbId={itemId}
          schemaJson={meta.db_schema}
          canEdit={meta.can_edit}
          canCreate={meta.can_create ?? false}
          canDelete={meta.can_delete ?? false}
          userName={currentUserName}
          avatar={currentUserAvatar}
          presence={presence}
          doc={rt?.doc ?? null}
          awareness={rt?.awareness ?? null}
        />
      ) : (
        meta &&
        rt && (
          <Editor
            itemId={itemId}
            userName={currentUserName}
            avatar={currentUserAvatar}
            doc={rt.doc}
            awareness={rt.awareness}
            onTreeChange={onMetaChange}
          />
        )
      )}
    </div>
  );
}
