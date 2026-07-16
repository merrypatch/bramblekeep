import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

import { filterSuggestionItems } from "@blocknote/core";
import { en as bnEn, es as bnEs, fr as bnFr } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
} from "@blocknote/react";
import { FileText, Link2, Table2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import { PageLinkDialog } from "@/components/PageLinkDialog";
import { PresenceCursors } from "@/components/PresenceCursors";
import { PageSkeleton } from "@/components/ui/skeletons";
import { createDatabase, createItem } from "@/lib/api";
import { editorSchema } from "@/lib/editorSchema";
import { colorFromName, useBroadcastPointer } from "@/lib/presence";
import { useConfirmPublicChild } from "@/lib/publishConsent";
import { useIsDark } from "@/lib/theme";
import { useTranslation } from "react-i18next";
import { connectSync, FRAGMENT } from "@/lib/sync";

/**
 * BlockNote editor connected to a Yjs document synced to the server. The content
 * lives in the CRDT (persisted + projected on the server side); real-time presence
 * (text cursors, avatars, mouse cursors) goes through the awareness relayed on
 * the same socket. The doc and awareness are owned by `Page`.
 */
export function Editor({
  itemId,
  userName,
  avatar,
  doc,
  awareness,
  onTreeChange,
}: {
  itemId: string;
  userName: string;
  /** Current user's avatar JSON config, broadcasted to peers (null = derived from name). */
  avatar: string | null;
  doc: Y.Doc;
  awareness: Awareness;
  /** Called after creating a sub-page (refreshes the sidebar). */
  onTreeChange: () => void;
}) {
  const { t, i18n } = useTranslation();
  // BlockNote dictionary (placeholders + default items of the "/" menu) aligned
  // with the active language. `lang` is in useCreateBlockNote deps → a
  // language change reconstructs the editor with the correct dictionary.
  const lang = i18n.language;
  const bnDictionary = lang.startsWith("fr") ? bnFr : lang.startsWith("es") ? bnEs : bnEn;
  const navigate = useNavigate();
  const confirmPublicChild = useConfirmPublicChild();
  const dark = useIsDark();
  // We only mount the editor once the server state is received: otherwise a local empty
  // doc would display, then merge with the remote content (misleading empty rendering
  // upon revisit). The server always sends a first message.
  const [synced, setSynced] = useState(false);
  const [failed, setFailed] = useState(false);
  const [lost, setLost] = useState(false);
  // Link selector to an existing page: open + "/" block to replace.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<string | null>(null);
  // The selector is used for linking to a page (`page` block) or an inline database (`dbview` block).
  const [linkKind, setLinkKind] = useState<"page" | "db">("page");
  const columnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSynced(false);
    setFailed(false);
    setLost(false);
    // We set our identity in the awareness OURSELVES (not via the single set
    // of BlockNote): the connectSync cleanup removes the local state upon
    // disconnection, and under React.StrictMode (double mount in dev) the remount
    // would otherwise leave an empty awareness → no presence. Here it is reset at
    // each connection.
    // setLocalState (not setLocalStateField): after a removeAwarenessStates
    // (connectSync cleanup), getLocalState() is null and setLocalStateField
    // is a no-op on its guard. setLocalState resets the state unconditionally.
    // `avatar` = separate awareness field (the BlockNote collaboration plugin
    // owns `user` and overwrites it as keystrokes occur; a separate field survives).
    awareness.setLocalState({ user: { name: userName, color: colorFromName(userName) }, avatar });
    const disconnect = connectSync(doc, awareness, itemId, {
      onSynced: () => setSynced(true),
      onError: () => setFailed(true),
      onClosed: () => setLost(true),
    });
    return disconnect;
  }, [doc, awareness, itemId, userName, avatar]);

  // Broadcasts our mouse (anchored to the column) once the editor is mounted.
  useBroadcastPointer(awareness, columnRef, synced);

  const editor = useCreateBlockNote(
    {
      schema: editorSchema,
      dictionary: bnDictionary,
      collaboration: {
        fragment: doc.getXmlFragment(FRAGMENT),
        user: { name: userName, color: colorFromName(userName) },
        provider: { awareness },
      },
    },
    [doc, userName, bnDictionary],
  );

  // Creates a sub-page: new child item + insertion of a `page` block that references
  // it, then we open it. The sidebar refreshes via onTreeChange.
  async function insertSubpage() {
    if (!(await confirmPublicChild(itemId))) return;
    const childId = await createItem(itemId);
    // Replace the current block (the one with the "/") with the page block.
    const current = editor.getTextCursorPosition().block;
    editor.updateBlock(current, {
      type: "page",
      props: { itemId: childId, title: t("editor.newPage") },
    });
    onTreeChange();
    navigate(`/p/${childId}`);
  }

  async function insertDatabase() {
    const dbId = await createDatabase(itemId);
    const current = editor.getTextCursorPosition().block;
    editor.updateBlock(current, {
      type: "page",
      props: { itemId: dbId, title: t("sidebar.newDatabase") },
    });
    onTreeChange();
    navigate(`/p/${dbId}`);
  }

  /** Database rendered inline in the page (`dbview` block), without leaving. */
  async function insertInlineDatabase() {
    const dbId = await createDatabase(itemId);
    const current = editor.getTextCursorPosition().block;
    editor.updateBlock(current, { type: "dbview", props: { itemId: dbId } });
    onTreeChange();
  }

  if (failed) {
    return (
      <p className="text-sm text-destructive">
        {t("editor.err.backendDown")}
      </p>
    );
  }

  if (!synced) {
    return <PageSkeleton fill />;
  }

  return (
    <div
      ref={columnRef}
      className="relative mx-auto w-full max-w-4xl cursor-text"
      // Click in the margin (outside text) → focus the editor (click-in-margin pattern).
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) editor.focus();
      }}
    >
      <BlockNoteView
        editor={editor}
        theme={dark ? "dark" : "light"}
        className="bk-editor"
        slashMenu={false}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                {
                  title: t("editor.item.subpage.title"),
                  subtext: t("editor.item.subpage.subtext"),
                  aliases: ["subpage", "new", "under"],
                  group: t("editor.group.basic"),
                  icon: <FileText className="size-4" />,
                  onItemClick: () => void insertSubpage(),
                },
                {
                  title: t("editor.item.linkPage.title"),
                  subtext: t("editor.item.linkPage.subtext"),
                  aliases: ["link", "reference", "mention"],
                  group: t("editor.group.basic"),
                  icon: <Link2 className="size-4" />,
                  onItemClick: () => {
                    setLinkTarget(editor.getTextCursorPosition().block.id);
                    setLinkKind("page");
                    setLinkOpen(true);
                  },
                },
                {
                  title: t("editor.item.database.title"),
                  subtext: t("editor.item.database.subtext"),
                  aliases: ["database", "base", "table", "db"],
                  group: t("editor.group.basic"),
                  icon: <Table2 className="size-4" />,
                  onItemClick: () => void insertDatabase(),
                },
                {
                  title: t("editor.item.inlineDb.title"),
                  subtext: t("editor.item.inlineDb.subtext"),
                  aliases: ["database", "base", "inline", "db", "view"],
                  group: t("editor.group.basic"),
                  icon: <Table2 className="size-4" />,
                  onItemClick: () => void insertInlineDatabase(),
                },
                {
                  title: t("editor.item.linkDb.title"),
                  subtext: t("editor.item.linkDb.subtext"),
                  aliases: ["database", "base", "link", "existing", "db"],
                  group: t("editor.group.basic"),
                  icon: <Table2 className="size-4" />,
                  onItemClick: () => {
                    setLinkTarget(editor.getTextCursorPosition().block.id);
                    setLinkKind("db");
                    setLinkOpen(true);
                  },
                },
                ...getDefaultReactSlashMenuItems(editor),
              ],
              query,
            )
          }
        />
      </BlockNoteView>
      <PresenceCursors awareness={awareness} />
      {/* Connection cut after sync (network or access revoked): keystrokes
          are no longer synchronized → invite to reload. */}
      {lost && (
        <div className="sticky bottom-4 z-30 mx-auto w-fit rounded-full border bg-background/95 px-4 py-2 text-sm shadow-lg backdrop-blur">
          {t("editor.err.disconnected")}{" "}
          <button
            className="font-medium underline underline-offset-2"
            onClick={() => window.location.reload()}
          >
            {t("editor.reload")}
          </button>
        </div>
      )}
      <PageLinkDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        excludeId={itemId}
        dbOnly={linkKind === "db"}
        onPick={(p) => {
          if (linkTarget) {
            editor.updateBlock(
              linkTarget,
              linkKind === "db"
                ? { type: "dbview", props: { itemId: p.id } }
                : { type: "page", props: { itemId: p.id, title: p.title ?? "" } },
            );
          }
          setLinkOpen(false);
        }}
      />
    </div>
  );
}
