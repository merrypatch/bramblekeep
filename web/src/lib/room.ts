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
export type Room = { doc: Y.Doc; awareness: Awareness; refs: number; disposeTimer?: number };

const rooms = new Map<string, Room>();

/** Gets (or creates) an item's room and increments its ref counter. */
export function acquireRoom(itemId: string): Room {
  let room = rooms.get(itemId);
  if (!room) {
    const doc = new Y.Doc();
    room = { doc, awareness: new Awareness(doc), refs: 0 };
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
      room.awareness.destroy();
      room.doc.destroy();
      rooms.delete(itemId);
    }
  }, 1000);
}
