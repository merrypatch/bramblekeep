import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { FileText, Table2 } from "lucide-react";

/** PUBLIC RENDER schema: default blocks + neutralized variants of `page`
 * and `dbview`. The Yjs doc may contain these custom blocks; the schema must
 * therefore declare the same `type`/`propSchema`, but their render is passive
 * (no navigation in the app, no authenticated API call). */

/** Link to a sub-page: points to the PUBLIC URL of the sub-page (the token
 * is the 2nd segment of the current path `/public/{token}/…`). If the sub-page is
 * not within the published scope, its page will return "not found". */
const PublicPageBlockSpec = createReactBlockSpec(
  { type: "page", propSchema: { itemId: { default: "" }, title: { default: "" } }, content: "none" },
  {
    render: (props) => {
      const token = window.location.pathname.split("/")[2] ?? "";
      const { itemId, title } = props.block.props;
      const label = title || "Untitled";
      return (
        <a
          contentEditable={false}
          href={itemId ? `/public/${token}/${itemId}` : undefined}
          className="my-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 no-underline hover:bg-accent"
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{label}</span>
        </a>
      );
    },
  },
);

/** Inline database: out of public scope (V1). Inert placeholder. */
const PublicDbViewBlockSpec = createReactBlockSpec(
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
    render: () => (
      <div
        contentEditable={false}
        className="my-0.5 flex w-full items-center gap-2 rounded border border-dashed px-2 py-1.5 text-sm text-muted-foreground"
      >
        <Table2 className="size-4 shrink-0" />
        Database — not available on the public page
      </div>
    ),
  },
);

export const publicSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    page: PublicPageBlockSpec(),
    dbview: PublicDbViewBlockSpec(),
  },
});
