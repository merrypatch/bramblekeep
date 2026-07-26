import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ImageSourcePicker } from "@/components/ImageSourcePicker";
import { ItemIcon } from "@/components/ItemIcon";
import { Button } from "@/components/ui/button";
import { PickerSkeleton } from "@/components/ui/skeletons";
import { fileUrl, type ItemMeta, type MetaPatch, type StoredFile } from "@/lib/api";
import {
  type CoverPos,
  coverObjectPosition,
  coverSlack,
  dragCoverPos,
  formatCoverPos,
  nudgeCoverPos,
  parseCoverPos,
  type Size,
} from "@/lib/coverPosition";
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [title, setTitle] = useState(meta?.title ?? "");
  // Mobile: cover actions (change/remove) have no hover.
  // A tap on the cover shows them; a tap elsewhere hides them.
  const [coverActions, setCoverActions] = useState(false);
  const coverRef = useRef<HTMLDivElement>(null);
  const coverImg = useRef<HTMLImageElement>(null);
  // Cover framing: `repositioning` = drag mode (explicit, like the "Reposition"
  // of the reference tools), `pos` = live framing shown while dragging.
  const [repositioning, setRepositioning] = useState(false);
  const [pos, setPos] = useState<CoverPos>(() => parseCoverPos(meta?.cover_pos));
  // Drag origin: pointer + framing at pointerdown (deltas are relative to it).
  const drag = useRef<{ px: number; py: number; from: CoverPos } | null>(null);
  // "Where from?" panel for the cover (computer / URL): a single entry point,
  // then the source question — same panel as the icon picker.
  const [coverSourceOpen, setCoverSourceOpen] = useState(false);

  // Reset the local title only when switching pages (not on every meta
  // update, otherwise typing would be overwritten by the PATCH response).
  useEffect(() => {
    setTitle(meta?.title ?? "");
    setPickerOpen(false);
    setCoverActions(false);
    setCoverSourceOpen(false);
  }, [meta?.id]);

  // Framing realigned on the stored value: page switch, save, change of image,
  // or edit by a collaborator.
  useEffect(() => {
    setPos(parseCoverPos(meta?.cover_pos));
    setRepositioning(false);
    drag.current = null;
  }, [meta?.id, meta?.cover, meta?.cover_pos]);

  // Click outside the source panel → closes it (like the icon picker). The
  // action bar is excluded: its "Change" button toggles the panel itself.
  useEffect(() => {
    if (!coverSourceOpen) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest("[data-cover-source]") && !el.closest("[data-cover-actions]")) {
        setCoverSourceOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [coverSourceOpen]);

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

  /** Applies a stored file as the cover. `ImageSourcePicker` has already checked
   * that it is an image. A new image RESETS the framing: the old focal point
   * means nothing on another picture. */
  async function applyCover(stored: StoredFile) {
    setCoverSourceOpen(false);
    await onChange({ cover: stored.hash, cover_pos: "" });
  }

  function commitTitle() {
    if (title !== (meta?.title ?? "")) void onChange({ title });
  }

  /** Pannable overflow of the current image in its box, in px per axis.
   * Recomputed at each move: the box depends on the viewport. */
  function slackNow(): Size {
    const img = coverImg.current;
    const box = coverRef.current;
    if (!img || !box) return { w: 0, h: 0 };
    const r = box.getBoundingClientRect();
    return coverSlack({ w: img.naturalWidth, h: img.naturalHeight }, { w: r.width, h: r.height });
  }

  function saveFraming() {
    setRepositioning(false);
    drag.current = null;
    void onChange({ cover_pos: formatCoverPos(pos) });
  }

  function cancelFraming() {
    setRepositioning(false);
    drag.current = null;
    setPos(parseCoverPos(meta?.cover_pos));
  }

  return (
    <div>
      {meta.cover && (
        <div
          ref={coverRef}
          className={cn(
            "bk-page-cover group relative h-40 w-full overflow-hidden sm:h-56 print:!h-48",
            // touch-none: the drag must pan the image, not scroll the page.
            repositioning && "cursor-grab touch-none select-none active:cursor-grabbing",
          )}
          onClick={() => {
            if (!repositioning) setCoverActions(true);
          }}
          tabIndex={repositioning ? 0 : undefined}
          aria-label={repositioning ? t("page.coverRepositionHint") : undefined}
          onPointerDown={(e) => {
            if (!repositioning) return;
            // A press on the action bar must stay a click: capturing the pointer
            // here would redirect pointerup (and the click) to the container.
            if ((e.target as HTMLElement).closest("[data-cover-actions]")) return;
            e.preventDefault(); // no native image drag / text selection
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { px: e.clientX, py: e.clientY, from: pos };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            setPos(dragCoverPos(d.from, e.clientX - d.px, e.clientY - d.py, slackNow()));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(e) => {
            if (!repositioning) return;
            const step = e.shiftKey ? 10 : 2;
            const by: Record<string, [number, number]> = {
              ArrowLeft: [-step, 0],
              ArrowRight: [step, 0],
              ArrowUp: [0, -step],
              ArrowDown: [0, step],
            };
            const delta = by[e.key];
            if (delta) {
              e.preventDefault();
              setPos((p) => nudgeCoverPos(p, delta[0], delta[1]));
            } else if (e.key === "Enter") {
              saveFraming();
            } else if (e.key === "Escape") {
              cancelFraming();
            }
          }}
        >
          <img
            ref={coverImg}
            src={fileUrl(meta.cover)}
            alt=""
            draggable={false}
            // object-cover + object-position in %: the image always fills the box,
            // the % only splits the overflow — no empty edge, whatever the value.
            className="pointer-events-none h-full w-full object-cover"
            style={{ objectPosition: coverObjectPosition(pos) }}
          />
          {!readOnly && (
            <div
              data-cover-actions=""
              className={cn(
                "absolute top-2 right-2 gap-1 sm:group-hover:flex",
                coverActions || repositioning ? "flex" : "hidden",
              )}
            >
              {repositioning ? (
                <>
                  <Button size="sm" onClick={saveFraming}>
                    {t("page.coverPosSave")}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={cancelFraming}>
                    {t("common.cancel")}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setRepositioning(true);
                      // Focus for the arrow keys (drag stays the main gesture).
                      coverRef.current?.focus();
                    }}
                  >
                    {t("page.coverReposition")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setCoverSourceOpen((o) => !o)}
                  >
                    {t("page.coverChange")}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void onChange({ cover: "" })}>
                    {t("page.coverRemove")}
                  </Button>
                </>
              )}
            </div>
          )}
          {!readOnly && coverSourceOpen && !repositioning && (
            <div
              data-cover-actions=""
              data-cover-source=""
              className="absolute inset-x-2 top-12 mx-auto max-w-md rounded-md border bg-background/95 p-3 shadow-lg backdrop-blur"
            >
              <ImageSourcePicker onPicked={applyCover} />
            </div>
          )}
          {repositioning && (
            <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
              <span className="rounded-full bg-background/90 px-3 py-1 text-xs text-foreground shadow-sm backdrop-blur">
                {t("page.coverRepositionHint")}
              </span>
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
                onClick={() => setCoverSourceOpen((o) => !o)}
              >
                🖼️ {t("page.addCover")}
              </button>
            )}
          </div>
        )}

        {/* No cover yet: the source panel sits under the quick actions (there is
            no image to overlay). */}
        {!readOnly && !meta.cover && coverSourceOpen && (
          <div data-cover-source="" className="max-w-md rounded-md border p-3">
            <ImageSourcePicker onPicked={applyCover} autoFocusUrl />
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

    </div>
  );
}
