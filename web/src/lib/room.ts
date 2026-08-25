import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

/**
 * A "room" = the Yjs doc + the awareness of a page, shared between the editor and
 * presence. Cached by itemId and reference-counted.
 *
 * Why a cache outside React: under `React.StrictMode` (dev), a component is
 * mounted → unmounted → remounted immediately. Creating/destroying the doc in
 * an effect or a `useMemo` then leaves a destroyed or emptied awareness → no
 * presence. Here, acquire/release with deferred destruction survives the double
 * mount: the remount reacquires the SAME instance before it is
 * destroyed.
 */
export type Room = {
  doc: Y.Doc;
  awareness: Awareness;
  refs: number;
  disposeTimer?: number;
  /** Local mirror of the document, when a signed-in user owns this session. */
  local?: IndexeddbPersistence;
  /** Resolves once the local mirror has finished loading — whether or not it
   * held anything. Lets a caller show the page without waiting for the network. */
  loaded: Promise<void>;
};

const rooms = new Map<string, Room>();

/** Who the local mirror belongs to. Null = do not mirror at all.
 *
 * IndexedDB is per-origin, so without this a second account signing in on the
 * same browser would read the first one's cached pages — content the server
 * would refuse to serve them. The account id is part of every store name, so
 * the two never meet, and signing out erases the stores rather than trusting
 * that separation alone. */
let scope: string | null = null;

/** Store name for a page's local mirror. */
function storeName(userId: string, itemId: string): string {
  return `bk:${userId}:${itemId}`;
}

/** Names every store opened in this session, so signing out can erase them.
 * `indexedDB.databases()` is not available everywhere, so the list is kept. */
const opened = new Set<string>();

/**
 * Sets (or clears) the account whose pages may be mirrored locally.
 *
 * Called with an id once the session is known, and with `null` on the way out.
 * Rooms already open keep the mirror they were given; the change applies to
 * pages opened afterwards, which is enough — signing out unmounts them all.
 */
export function setLocalScope(userId: string | null): void {
  scope = userId;
}

/** Erases every local mirror this session opened. Called on sign-out: the
 * pages cached here are readable without the server, so leaving them behind
 * would leave one account's content on a browser the next one may use. */
export async function clearLocalMirrors(): Promise<void> {
  const names = [...opened];
  opened.clear();
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
    ),
  );
}

/** Gets (or creates) an item's room and increments its ref counter. */
export function acquireRoom(itemId: string): Room {
  let room = rooms.get(itemId);
  if (!room) {
    const doc = new Y.Doc();
    let local: IndexeddbPersistence | undefined;
    let loaded = Promise.resolve();
    if (scope) {
      const name = storeName(scope, itemId);
      opened.add(name);
      local = new IndexeddbPersistence(name, doc);
      // `whenSynced` is about the LOCAL store, not the server: it resolves once
      // what was cached has been merged into the document.
      loaded = local.whenSynced.then(() => undefined);
    }
    room = { doc, awareness: new Awareness(doc), refs: 0, local, loaded };
    rooms.set(itemId, room);
  }
  if (room.disposeTimer !== undefined) {
    clearTimeout(room.disposeTimer);
    room.disposeTimer = undefined;
  }
  room.refs++;
  return room;
}

/** Releases a reference; destroys the room after a delay if nobody's left. */
export function releaseRoom(itemId: string): void {
  const room = rooms.get(itemId);
  if (!room) return;
  room.refs--;
  if (room.refs > 0) return;
  // Delay: a StrictMode remount reacquires on the next tick.
  room.disposeTimer = window.setTimeout(() => {
    if (room.refs <= 0) {
      // Detach the mirror without deleting it: its whole point is to still be
      // there on the next visit, and offline.
      void room.local?.destroy();
      room.awareness.destroy();
      room.doc.destroy();
      rooms.delete(itemId);
    }
  }, 1000);
}
