import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { createReactBlockSpec, createReactInlineContentSpec } from "@blocknote/react";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { InlineDatabase, type ViewState } from "@/components/db/InlineDatabase";
import { InlineDbHostContext } from "@/components/db/hostContext";
import { EmbedBlock } from "@/components/EmbedBlock";
import { TaskProgressBlock } from "@/components/TaskProgress";
import { ApiError, getItem } from "@/lib/api";
import { migrateFilters } from "@/lib/db";

/** Card of a referenced page (sub-page or link). Refreshes the title from
 * the real page. If the target is deleted or inaccessible (getItem → 403/404),
 * the card becomes inert and grayed out — no navigation to a 404. */
function PageLink({ itemId, title }: { itemId: string; title: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [live, setLive] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    setLive(null);
    setMissing(false);
    if (itemId) {
      getItem(itemId)
        .then((m) => alive && setLive(m.title ?? ""))
        .catch((e) => {
          // 403 (deleted or access removed) / 404 → target unavailable. A network
          // failure (other error) does not condemn the link.
          if (alive && e instanceof ApiError) setMissing(true);
        });
    }
    return () => {
      alive = false;
    };
  }, [itemId]);

  if (missing) {
    return (
      <div
        contentEditable={false}
        title={t("editor.pageLink.deleted")}
        className="my-0.5 flex w-full cursor-default items-center gap-2 rounded px-2 py-1.5 text-muted-foreground/50"
      >
        <FileText className="size-4 shrink-0" />
        <span className="truncate italic line-through">{t("editor.pageLink.unavailable")}</span>
      </div>
    );
  }

  const label = (live ?? title) || t("common.untitled");
  return (
    <div
      contentEditable={false}
      role="button"
      tabIndex={0}
      onClick={() => itemId && navigate(`/p/${itemId}`)}
      onKeyDown={(e) => {
        if (itemId && (e.key === "Enter" || e.key === " ")) navigate(`/p/${itemId}`);
      }}
      className="my-0.5 flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
    >
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium underline-offset-2 hover:underline">{label}</span>
    </div>
  );
}

/** `page` block: references another page (option 2/B). No inline content. */
export const PageBlockSpec = createReactBlockSpec(
  {
    type: "page",
    propSchema: { itemId: { default: "" }, title: { default: "" } },
    content: "none",
  },
  {
    render: (props) => (
      <PageLink itemId={props.block.props.itemId} title={props.block.props.title} />
    ),
  },
);

/** `dbview` block: database rendered inline in the page. */
export const DbViewBlockSpec = createReactBlockSpec(
  {
    type: "dbview",
    propSchema: {
      itemId: { default: "" },
      locked: { default: false },
      hiddenViews: { default: "" },
      viewState: { default: "" },
    },
    content: "none",
  },
  {
    render: (props) => (
      // Consumer (not a hook) → host page context reaches this non-component render.
      <InlineDbHostContext.Consumer>
        {(host) => (
          <InlineDatabase
            itemId={props.block.props.itemId}
            locked={props.block.props.locked}
            onToggleLock={() =>
              props.editor.updateBlock(props.block, { props: { locked: !props.block.props.locked } })
            }
            hiddenViews={props.block.props.hiddenViews.split(",").filter(Boolean)}
            onSetHiddenViews={(ids) =>
              props.editor.updateBlock(props.block, { props: { hiddenViews: ids.join(",") } })
            }
            viewState={parseViewState(props.block.props.viewState)}
            onSetViewState={(next) =>
              props.editor.updateBlock(props.block, { props: { viewState: JSON.stringify(next) } })
            }
            host={host}
          />
        )}
      </InlineDbHostContext.Consumer>
    ),
  },
);

/** `taskProgress` block: % completion of a checklist. `scope` = the run of
 * checkboxes that follows the block (`next`) or the whole page (`page`). Nothing
 * is stored: the count is derived from the document at each change. */
export const TaskProgressBlockSpec = createReactBlockSpec(
  {
    type: "taskProgress",
    propSchema: { scope: { default: "next", values: ["next", "page"] as const } },
    content: "none",
  },
  {
    render: (props) => (
      <TaskProgressBlock
        editor={props.editor}
        blockId={props.block.id}
        scope={props.block.props.scope}
        onToggleScope={() =>
          props.editor.updateBlock(props.block, {
            props: { scope: props.block.props.scope === "page" ? "next" : "page" },
          })
        }
      />
    ),
  },
);

/** `embed` block: YouTube / Vimeo player. Only the source URL is stored; the
 * player URL is rebuilt from a validated id at render time (cf. `lib/embed`). */
export const EmbedBlockSpec = createReactBlockSpec(
  {
    type: "embed",
    propSchema: { url: { default: "" } },
    content: "none",
  },
  {
    render: (props) => (
      <EmbedBlock
        url={props.block.props.url}
        onChangeUrl={(url) => props.editor.updateBlock(props.block, { props: { url } })}
      />
    ),
  },
);

/** Tolerant parse of the per-view sort/filter JSON stored in the dbview block.
 * Migrates each view's legacy flat `filters` array to the current tree shape. */
function parseViewState(json: string): ViewState {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== "object") return {};
    const out: ViewState = {};
    for (const [viewId, entry] of Object.entries(v as Record<string, { sort?: ViewState[string]["sort"]; filters?: unknown }>)) {
      out[viewId] = { sort: entry?.sort, filters: migrateFilters(entry?.filters) };
    }
    return out;
  } catch {
    return {};
  }
}

/** Editor schema = default blocks + the `page` and `dbview` blocks.
 * `createReactBlockSpec` returns a factory (0.51): call it to get
 * the BlockSpec. */
/** Inline `@` mention of another item (page OR database row): a clickable chip
 * with the target's live title. Content lives in the CRDT like any inline run;
 * the projection captures it as a `links` edge (backlinks / graph). */
function PageMention({ itemId, label }: { itemId: string; label: string }) {
  const navigate = useNavigate();
  const [live, setLive] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    setLive(null);
    setMissing(false);
    if (itemId) {
      getItem(itemId)
        .then((m) => alive && setLive(m.title ?? ""))
        .catch((e) => {
          if (alive && e instanceof ApiError) setMissing(true);
        });
    }
    return () => {
      alive = false;
    };
  }, [itemId]);

  const text = (live ?? label) || "…";
  if (missing) {
    return (
      <span
        contentEditable={false}
        className="rounded px-0.5 text-muted-foreground/60 line-through"
      >
        @{label || "?"}
      </span>
    );
  }
  return (
    <span
      contentEditable={false}
      role="button"
      tabIndex={0}
      onClick={() => itemId && navigate(`/p/${itemId}`)}
      onKeyDown={(e) => {
        if (itemId && (e.key === "Enter" || e.key === " ")) navigate(`/p/${itemId}`);
      }}
      className="cursor-pointer rounded bg-accent px-1 py-0.5 font-medium text-foreground underline-offset-2 hover:underline"
    >
      @{text}
    </span>
  );
}

/** `pageLink` inline content: an `@` mention referencing another item. */
export const PageMentionSpec = createReactInlineContentSpec(
  {
    type: "pageLink",
    propSchema: { itemId: { default: "" }, label: { default: "" } },
    content: "none",
  },
  {
    render: (props) => (
      <PageMention
        itemId={props.inlineContent.props.itemId}
        label={props.inlineContent.props.label}
      />
    ),
  },
);

export const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    page: PageBlockSpec(),
    dbview: DbViewBlockSpec(),
    taskProgress: TaskProgressBlockSpec(),
    embed: EmbedBlockSpec(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageLink: PageMentionSpec },
});
