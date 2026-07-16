import {
  applyAwarenessUpdate,
  type Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";

/**
 * Name of the root fragment shared with the server (cf. `projection::FRAGMENT`).
 */
export const FRAGMENT = "document-store";

/** Origin marking frames received from the network, so as not to send them back. */
const REMOTE_ORIGIN = "remote";

/** Multiplexing tags (must match `sync::TAG_*` on the server side). */
const TAG_DOC = 0;
const TAG_AWARENESS = 1;

export type SyncHandlers = {
  onSynced?: () => void;
  onError?: () => void;
  /** Socket closed AFTER a successful sync and outside a voluntary disconnect:
   * network drop or access revocation (server kick). */
  onClosed?: () => void;
};

function frame(tag: number, payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(payload.length + 1);
  f[0] = tag;
  f.set(payload, 1);
  return f;
}

/**
 * CRDT sync + presence provider: binary WebSocket to
 * `/api/v1/items/{id}/sync`, multiplexed by a tag byte (doc vs awareness).
 * The document is persisted server-side; the awareness (cursors, presence) is
 * relayed ephemerally. Returns a disconnect function.
 */
export function connectSync(
  ydoc: Y.Doc,
  awareness: Awareness,
  itemId: string,
  { onSynced, onError, onClosed }: SyncHandlers = {},
): () => void {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/api/v1/items/${itemId}/sync`);
  ws.binaryType = "arraybuffer";

  let closing = false; // true = voluntary disconnect (unmount), not a drop
  const pending: Uint8Array[] = [];
  let firstMessage = true;

  const send = (f: Uint8Array) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(f);
    else pending.push(f);
  };

  ws.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
    const data = new Uint8Array(ev.data);
    if (data.length === 0) return;
    const tag = data[0];
    const payload = data.subarray(1);
    if (tag === TAG_DOC) {
      Y.applyUpdate(ydoc, payload, REMOTE_ORIGIN);
      if (firstMessage) {
        firstMessage = false;
        onSynced?.();
      }
    } else if (tag === TAG_AWARENESS) {
      applyAwarenessUpdate(awareness, payload, REMOTE_ORIGIN);
    }
  };

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return;
    send(frame(TAG_DOC, update));
  };
  ydoc.on("update", onDocUpdate);

  const onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE_ORIGIN) {
      // A new peer just appeared. The server relay does not replay
      // history: without this, our state (avatar, cursor) already emitted before
      // its arrival would never reach it → one-way presence. We
      // re-broadcast it to it. Guard on `added` (not `updated`) → no loop: an
      // already-known peer retriggers nothing.
      const newcomer = changes.added.some((id) => id !== ydoc.clientID);
      if (newcomer) {
        send(frame(TAG_AWARENESS, encodeAwarenessUpdate(awareness, [ydoc.clientID])));
      }
      return;
    }
    const clients = [...changes.added, ...changes.updated, ...changes.removed];
    send(frame(TAG_AWARENESS, encodeAwarenessUpdate(awareness, clients)));
  };
  awareness.on("update", onAwarenessUpdate);

  ws.onopen = () => {
    ws.send(frame(TAG_DOC, Y.encodeStateAsUpdate(ydoc)));
    // Push our initial presence state.
    ws.send(frame(TAG_AWARENESS, encodeAwarenessUpdate(awareness, [ydoc.clientID])));
    for (const f of pending) ws.send(f);
    pending.length = 0;
  };

  ws.onerror = () => onError?.();
  ws.onclose = () => {
    if (firstMessage) onError?.();
    else if (!closing) onClosed?.();
  };

  return () => {
    closing = true;
    ydoc.off("update", onDocUpdate);
    awareness.off("update", onAwarenessUpdate);
    // Cleanly remove our presence for the other clients.
    removeAwarenessStates(awareness, [ydoc.clientID], "local");
    ws.onmessage = null;
    ws.onopen = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close();
  };
}
