import type { BlockNoteEditor } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core";
import {
  BlockColorsItem,
  DragHandleMenu,
  RemoveBlockItem,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtensionState,
} from "@blocknote/react";
import {
  ChevronRight,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Type,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { editorSchema } from "@/lib/editorSchema";

/** Editor typed with OUR schema (the `page`/`dbview`/`embed` blocks included),
 * so `updateBlock` resolves the props of the target type instead of widening
 * them away. */
type Editor = BlockNoteEditor<
  typeof editorSchema.blockSchema,
  typeof editorSchema.inlineContentSchema,
  typeof editorSchema.styleSchema
>;

/**
 * "Turn into" targets. Data-model wise this is the cheapest operation there is:
 * the block keeps its id, its parent and its position, only `type` (and the
 * props of that type) change — cf. the block invariant, "the type is a rendering
 * lens, not a structure".
 *
 * Each entry carries its own `apply` so the call is typed against the real block
 * type instead of casting a union of props (`any` is banned here).
 */
const TARGETS: {
  key: string;
  icon: LucideIcon;
  /** i18n key under `editor.turnInto.` */
  label: string;
  /** `blockId` is enough: `updateBlock` accepts a bare id as identifier. */
  apply: (editor: Editor, blockId: string) => void;
}[] = [
  { key: "paragraph", icon: Type, label: "text", apply: (e, b) => e.updateBlock(b, { type: "paragraph" }) },
  { key: "h1", icon: Heading1, label: "h1", apply: (e, b) => e.updateBlock(b, { type: "heading", props: { level: 1 } }) },
  { key: "h2", icon: Heading2, label: "h2", apply: (e, b) => e.updateBlock(b, { type: "heading", props: { level: 2 } }) },
  { key: "h3", icon: Heading3, label: "h3", apply: (e, b) => e.updateBlock(b, { type: "heading", props: { level: 3 } }) },
  { key: "bullet", icon: List, label: "bullet", apply: (e, b) => e.updateBlock(b, { type: "bulletListItem" }) },
  { key: "numbered", icon: ListOrdered, label: "numbered", apply: (e, b) => e.updateBlock(b, { type: "numberedListItem" }) },
  { key: "check", icon: ListTodo, label: "check", apply: (e, b) => e.updateBlock(b, { type: "checkListItem" }) },
  { key: "toggle", icon: ChevronRight, label: "toggle", apply: (e, b) => e.updateBlock(b, { type: "toggleListItem" }) },
  { key: "quote", icon: Quote, label: "quote", apply: (e, b) => e.updateBlock(b, { type: "quote" }) },
  { key: "code", icon: Code, label: "code", apply: (e, b) => e.updateBlock(b, { type: "codeBlock" }) },
];

/**
 * "Turn into" submenu of the drag-handle menu (Notion's gesture: hover a block,
 * open the ⋮⋮ menu, change its type).
 *
 * Only shown for blocks whose content is inline text (`content` is an array):
 * a `page`, `dbview` or `embed` block references an item and holds no text, so
 * turning it into a heading would leave an empty heading and drop the reference.
 * Those are converted by replacing them, not by re-typing them.
 */
function TurnIntoItem() {
  const { t } = useTranslation();
  const Components = useComponentsContext();
  const editor = useBlockNoteEditor<
    typeof editorSchema.blockSchema,
    typeof editorSchema.inlineContentSchema,
    typeof editorSchema.styleSchema
  >();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  if (!Components || !block || !Array.isArray(block.content)) return null;

  return (
    <Components.Generic.Menu.Root position="right" sub>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger>
          {t("editor.turnInto.label")}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown">
        {TARGETS.map((target) => {
          const Icon = target.icon;
          return (
            <Components.Generic.Menu.Item
              key={target.key}
              className="bn-menu-item"
              icon={<Icon size={16} />}
              onClick={() => target.apply(editor, block.id)}
            >
              {t(`editor.turnInto.${target.label}` as "editor.turnInto.text")}
            </Components.Generic.Menu.Item>
          );
        })}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

/**
 * Drag-handle menu of a block: "Turn into" first, then BlockNote's own items.
 * Overriding the children means re-listing the defaults — `TableHeadersItem`
 * included, which hides itself outside a table.
 */
export function BlockDragHandleMenu() {
  const dict = useDictionary();
  return (
    <DragHandleMenu>
      <TurnIntoItem />
      <BlockColorsItem>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
      <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
      <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
      <RemoveBlockItem>{dict.drag_handle.delete_menuitem}</RemoveBlockItem>
    </DragHandleMenu>
  );
}
