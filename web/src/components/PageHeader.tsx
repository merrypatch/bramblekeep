import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ItemIcon } from "@/components/ItemIcon";
import { Button } from "@/components/ui/button";
import { PickerSkeleton } from "@/components/ui/skeletons";
import { fileUrl, uploadFile, type ItemMeta, type MetaPatch } from "@/lib/api";
import { cn } from "@/lib/utils";

// Loaded on demand: bundles the emoji catalog + Lucide icons (heavy),
// useless until the picker is opened.
const IconPicker = lazy(() =>
  import("@/components/IconPicker").then((m) => ({ default: m.IconPicker })),
);

export function PageHeader({
  meta,
  onChange,
  readOnly = false,
}: {
  meta: ItemMeta | null;
  onChange: (patch: MetaPatch) => void | Promise<void>;
  /** Disables editing (icon/cover/title) for read-only roles. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [title, setTitle] = useState(meta?.title ?? "");
  // Mobile: cover actions (change/remove) have no hover.
  // A tap on the cover shows them; a tap elsewhere hides them.
  const [coverActions, setCoverActions] = useState(false);
  const coverRef = useRef<HTMLDivElement>(null);

  // Reset the local title only when switching pages (not on every meta
  // update, otherwise typing would be overwritten by the PATCH response).
  useEffect(() => {
    setTitle(meta?.title ?? "");
    setPickerOpen(false);
    setCoverActions(false);
  }, [meta?.id]);

  // Tap outside the cover → hides the actions (mobile).
  useEffect(() => {
    if (!coverActions) return;
    const onDown = (e: PointerEvent) => {
      if (!coverRef.current?.contains(e.target as Node)) setCoverActions(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [coverActions]);

  if (!meta) return null;

  async function onCoverPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const hash = await uploadFile(file);
    await onChange({ cover: hash });
  }

  function commitTitle() {
    if (title !== (meta?.title ?? "")) void onChange({ title });
  }

  return (
    <div>
      {meta.cover && (
        <div
          ref={coverRef}
          className="bk-page-cover group relative h-40 w-full sm:h-56 print:!h-48"
          onClick={() => setCoverActions(true)}
        >
          <img src={fileUrl(meta.cover)} alt="" className="h-full w-full object-cover" />
          {!readOnly && (
            <div
              className={cn(
                "absolute top-2 right-2 gap-1 sm:group-hover:flex",
                coverActions ? "flex" : "hidden",
              )}
            >
              <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
                {t("page.coverChange")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void onChange({ cover: "" })}>
                {t("page.coverRemove")}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="mx-auto w-full max-w-4xl px-[54px] pt-6 max-sm:px-4">
        {meta.icon && (
          <div className={cn("bk-page-icon relative z-10 w-fit print:!mt-2", meta.cover && "-mt-12 sm:-mt-14")}>
            <button
              className="leading-none drop-shadow-sm"
              onClick={readOnly ? undefined : () => setPickerOpen((o) => !o)}
              aria-label={t("common.changeIcon")}
            >
              <ItemIcon icon={meta.icon} kind={meta.db_schema ? "database" : "page"} size={60} />
            </button>
          </div>
        )}

        {pickerOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setPickerOpen(false)} />
            <div className="relative">
              <div className="absolute z-20 mt-2">
                <Suspense
                  fallback={
                    <div className="rounded-md border bg-popover shadow-md">
                      <PickerSkeleton />
                    </div>
                  }
                >
                  <IconPicker
                    onPick={(value) => {
                      void onChange({ icon: value });
                      setPickerOpen(false);
                    }}
                    onRemove={
                      meta.icon
                        ? () => {
                            void onChange({ icon: "" });
                            setPickerOpen(false);
                          }
                        : undefined
                    }
                  />
                </Suspense>
              </div>
            </div>
          </>
        )}

        {/* Quick actions: icon / cover (if absent). Sharing + presence
            are in the Shell header (top-right). */}
        {!readOnly && (!meta.icon || !meta.cover) && (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            {!meta.icon && (
              <button className="rounded px-2 py-1 hover:bg-accent" onClick={() => setPickerOpen(true)}>
                😀 {t("page.addIcon")}
              </button>
            )}
            {!meta.cover && (
              <button
                className="rounded px-2 py-1 hover:bg-accent"
                onClick={() => fileInput.current?.click()}
              >
                🖼️ {t("page.addCover")}
              </button>
            )}
          </div>
        )}

        <input
          value={title}
          readOnly={readOnly}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          placeholder={t("common.untitled")}
          className="mt-9 mb-3 w-full bg-transparent text-4xl font-bold outline-none placeholder:text-muted-foreground/50"
        />
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void onCoverPicked(e)}
      />
    </div>
  );
}
