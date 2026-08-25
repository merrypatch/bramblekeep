//! Writing an imported Notion tree into the workspace.
//!
//! Content goes in through the CRDT, never around it (project invariant #1): a
//! page's body is a Yjs document, and the `blocks` table is only ever a
//! projection of it. So each imported page is written the same way a person
//! writes one — a BlockNote editor bound to the page's Yjs document over the
//! sync socket — rather than by any shortcut that would put rows in the database
//! the server would then treat as authoritative.
//!
//! That makes the import deliberately sequential: one page, one socket, wait for
//! the write to land, next. It is slower than a bulk endpoint would be, and it
//! is the only version that cannot leave the projection disagreeing with the
//! journal.

import { BlockNoteEditor } from "@blocknote/core";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createItem, getBlocks, patchItem } from "@/lib/api";
import { editorSchema } from "@/lib/editorSchema";
import { stripLeadingTitle, type NotionPage } from "@/lib/notionImport";
import { FRAGMENT, connectSync } from "@/lib/sync";

/** How long to wait for one page's socket to sync before giving up on it. */
const SYNC_TIMEOUT_MS = 15_000;

/** How long to wait for a page's content to come back from the server. */
const FLUSH_TIMEOUT_MS = 10_000;

export type ImportProgress = { done: number; total: number; title: string };

export type ImportResult = {
  created: number;
  /** Pages that were created but whose body could not be written. */
  failed: { title: string; reason: string }[];
  rootIds: string[];
};

/** Writes `markdown` into the page's CRDT document, then leaves.
 *
 * The editor here is never mounted: it exists to turn markdown into blocks with
 * the same parser the app uses everywhere else, and to write them through the
 * collaboration binding. Reimplementing either would mean owning a second
 * markdown dialect and a second Yjs mapping, both of which would drift. */
async function writeBody(itemId: string, markdown: string): Promise<void> {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  // Held in an object: assigned inside a promise executor, which TypeScript
  // otherwise narrows to `never` at the point it is called.
  const socket: { stop: (() => void) | null } = { stop: null };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error("sync timed out")),
        SYNC_TIMEOUT_MS,
      );
      socket.stop = connectSync(doc, awareness, itemId, {
        onSynced: () => {
          window.clearTimeout(timer);
          resolve();
        },
        onError: () => {
          window.clearTimeout(timer);
          reject(new Error("cannot reach the page"));
        },
      });
    });

    const editor = BlockNoteEditor.create({
      schema: editorSchema,
      collaboration: {
        fragment: doc.getXmlFragment(FRAGMENT),
        user: { name: "import", color: "#a1a1aa" },
        provider: { awareness },
      },
    });

    const blocks = await editor.tryParseMarkdownToBlocks(markdown);
    if (blocks.length === 0) return;
    editor.replaceBlocks(editor.document, blocks);

    // Confirm the write landed instead of assuming it did. Disconnecting after a
    // fixed pause would be a guess, and the failure it invites is the quiet kind:
    // a page created, listed in the tree, and empty when opened. The projection
    // is rebuilt server-side on every CRDT commit, so a non-empty `blocks` read
    // is proof the update was received and applied — not merely sent.
    await confirmLanded(itemId);
  } finally {
    socket.stop?.();
    doc.destroy();
  }
}

/** Polls the page's projection until the server has content for it.
 *
 * The projection is a pure function of the CRDT journal, so anything appearing
 * there is content the server has committed. */
async function confirmLanded(itemId: string): Promise<void> {
  const deadline = Date.now() + FLUSH_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => window.setTimeout(r, 60));
    const blocks = await getBlocks(itemId);
    if (blocks.length > 0) return;
    if (Date.now() > deadline) throw new Error("the content never reached the server");
  }
}

/** Creates one page and its subtree, depth first. Returns the new page's id. */
async function importPage(
  page: NotionPage,
  parentId: string | undefined,
  onProgress: (p: ImportProgress) => void,
  state: { done: number; total: number; failed: ImportResult["failed"] },
): Promise<string> {
  const itemId = await createItem(parentId);
  await patchItem(itemId, { title: page.title });

  const body = stripLeadingTitle(page.markdown, page.title);
  if (body.trim() !== "") {
    try {
      await writeBody(itemId, body);
    } catch (e) {
      // The page exists and is in the right place; only its body is missing.
      // Losing the whole import over one unreadable page would be worse.
      state.failed.push({
        title: page.title,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  state.done += 1;
  onProgress({ done: state.done, total: state.total, title: page.title });

  for (const child of page.children) {
    await importPage(child, itemId, onProgress, state);
  }
  return itemId;
}

/**
 * Creates every page of the plan, under `parentId` if given.
 *
 * Failures are collected rather than thrown: an import of two hundred pages that
 * stops on page ninety leaves the worst possible state — half a workspace, and
 * no way to tell which half.
 */
export async function applyNotionImport(
  roots: NotionPage[],
  parentId: string | undefined,
  onProgress: (p: ImportProgress) => void,
): Promise<ImportResult> {
  const total = (pages: NotionPage[]): number =>
    pages.reduce((n, p) => n + 1 + total(p.children), 0);
  const state = { done: 0, total: total(roots), failed: [] as ImportResult["failed"] };

  const rootIds: string[] = [];
  for (const root of roots) {
    rootIds.push(await importPage(root, parentId, onProgress, state));
  }
  return { created: state.done, failed: state.failed, rootIds };
}
