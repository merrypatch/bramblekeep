//! Writing an imported page tree into the workspace.
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

import { createItem, fileUrl, getBlocks, patchItem, uploadFile } from "@/lib/api";
import { editorSchema } from "@/lib/editorSchema";
import {
  liftTasksOutOfQuotes,
  linksIn,
  resolveLink,
  stripLeadingTitle,
  type MdPage,
} from "@/lib/mdImport";
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
  /** Attachments uploaded and pointed at from the imported pages. */
  filesImported: number;
  rootIds: string[];
};

/** Archive path → URL it now lives at, so a file referenced from three pages is
 * uploaded once. The store is content-addressed, so a repeat upload would be
 * harmless — only slow, over a link that may be someone's home connection. */
type Uploaded = Map<string, string>;

/** Uploads a page's attachments and points its Markdown at them.
 *
 * Without this an exported image survives as a relative path to a file that
 * exists only inside the archive — which renders as neither an image nor an
 * error, just a stray line of filename. */
async function absorbAttachments(
  markdown: string,
  pagePath: string,
  files: Map<string, Uint8Array>,
  uploaded: Uploaded,
): Promise<{ markdown: string; added: number }> {
  let out = markdown;
  let added = 0;

  for (const link of linksIn(markdown)) {
    const entry = resolveLink(files, pagePath, link);
    if (!entry) continue; // external, absolute, or simply not in the archive

    let url = uploaded.get(entry);
    if (!url) {
      const bytes = files.get(entry);
      if (!bytes) continue;
      const name = entry.split("/").pop() ?? "file";
      try {
        const stored = await uploadFile(new File([bytes as BlobPart], name));
        url = fileUrl(stored.hash);
        uploaded.set(entry, url);
        added += 1;
      } catch {
        // One attachment refused (too large, a MIME the server declines) is not
        // a reason to drop the page it belongs to.
        continue;
      }
    }
    // Replace the target only, leaving the alt text and any title in place.
    out = out.split(`](${link}`).join(`](${url}`);
  }
  return { markdown: out, added };
}

/** Writes `markdown` into the page's CRDT document, then leaves.
 *
 * The editor here is never mounted: it exists to turn markdown into blocks with
 * the same parser the app uses everywhere else, and to write them through the
 * collaboration binding. Reimplementing either would mean owning a second
 * markdown dialect and a second Yjs mapping, both of which would drift. */
async function writeBody(itemId: string, markdown: string): Promise<void> {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  // Only what the cleanup needs: naming BlockNote's generic parameters here
  // would pin this file to the editor schema for no benefit.
  let editor: { unmount: () => void } | null = null;
  let host: HTMLElement | null = null;
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

    const ed = BlockNoteEditor.create({
      schema: editorSchema,
      collaboration: {
        fragment: doc.getXmlFragment(FRAGMENT),
        user: { name: "import", color: "#a1a1aa" },
        provider: { awareness },
      },
    });

    // The editor MUST be mounted, off screen but in the document. y-prosemirror
    // creates its binding — and installs the update hook that pushes changes into
    // the Yjs document — inside the sync plugin's `view()` lifecycle. An editor
    // that is never mounted has no view, so no binding, so every block written
    // into it stays in ProseMirror and reaches nothing. That produced exactly
    // what it sounds like: pages created, titled, and empty.
    host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden";
    document.body.appendChild(host);
    ed.mount(host);
    editor = ed;

    const blocks = await ed.tryParseMarkdownToBlocks(markdown);
    if (blocks.length === 0) {
      // Non-empty markdown that parses to nothing is a case worth hearing about,
      // not one to pass over quietly.
      throw new Error("nothing could be read from this page's Markdown");
    }
    ed.replaceBlocks(ed.document, blocks);

    // Confirm the write landed instead of assuming it did. Disconnecting after a
    // fixed pause would be a guess, and the failure it invites is the quiet kind:
    // a page created, listed in the tree, and empty when opened. The projection
    // is rebuilt server-side on every CRDT commit, so a non-empty `blocks` read
    // is proof the update was received and applied — not merely sent.
    await confirmLanded(itemId);
  } finally {
    editor?.unmount();
    host?.remove();
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
  page: MdPage,
  parentId: string | undefined,
  files: Map<string, Uint8Array>,
  uploaded: Uploaded,
  onProgress: (p: ImportProgress) => void,
  state: {
    done: number;
    total: number;
    failed: ImportResult["failed"];
    filesImported: number;
  },
): Promise<string> {
  const itemId = await createItem(parentId);
  await patchItem(itemId, { title: page.title });

  // Order matters: attachments first, so the Markdown handed to the parser
  // already points at files that exist; then the quote fix, which only moves
  // lines around.
  let body = stripLeadingTitle(page.markdown, page.title);
  if (body.trim() !== "") {
    const absorbed = await absorbAttachments(body, page.path, files, uploaded);
    body = liftTasksOutOfQuotes(absorbed.markdown);
    state.filesImported += absorbed.added;
  }
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
    await importPage(child, itemId, files, uploaded, onProgress, state);
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
export async function applyMdImport(
  roots: MdPage[],
  files: Map<string, Uint8Array>,
  parentId: string | undefined,
  onProgress: (p: ImportProgress) => void,
): Promise<ImportResult> {
  const total = (pages: MdPage[]): number =>
    pages.reduce((n, p) => n + 1 + total(p.children), 0);
  const state = {
    done: 0,
    total: total(roots),
    failed: [] as ImportResult["failed"],
    filesImported: 0,
  };
  const uploaded: Uploaded = new Map();

  const rootIds: string[] = [];
  for (const root of roots) {
    rootIds.push(await importPage(root, parentId, files, uploaded, onProgress, state));
  }
  return {
    created: state.done,
    failed: state.failed,
    filesImported: state.filesImported,
    rootIds,
  };
}
