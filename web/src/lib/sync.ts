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
   * network drop or access revocation (server kick). Followed by retries; a
   * successful one calls `onSynced` again. */
  onClosed?: () => void;
};

/** Backoff between reconnection attempts, in ms. Climbs, then stays: a laptop
 * shut for the night should not come back to a socket that has given up, and
 * an instance that is down should not be hammered while it restarts. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

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
 *
 * Reconnects on its own. A dropped socket used to be terminal — the page said
 * "reload" and meant it — which is tolerable when losing the connection means
 * losing the editor anyway, and wrong once the document survives locally. Yjs
 * makes the reconnection safe: whatever was typed while the socket was down is
 * in the document, and the first frame after reconnecting carries the whole
 * state, so the server merges it. Nothing is queued by hand.
 */
export function connectSync(
  ydoc: Y.Doc,
  awareness: Awareness,
  itemId: string,
  { onSynced, onError, onClosed }: SyncHandlers = {},
): () => void {
  let ws: WebSocket;
  let closing = false; // true = voluntary disconnect (unmount), not a drop
  let firstMessage = true;
  let attempt = 0;
  let retryTimer: number | undefined;
  const pending: Uint8Array[] = [];

  const send = (f: Uint8Array) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(f);
    else pending.push(f);
  };

  // Registered once, on the document — not on the socket. Edits made while
  // disconnected still land here; they simply queue until a socket exists.
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

  // Declared as functions, not consts: `open` needs `wire`, `wire` needs
  // `retry`, and `retry` needs `open`. Hoisting is what lets the cycle close.
  function wire() {
    ws.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      const data = new Uint8Array(ev.data);
      if (data.length === 0) return;
      const tag = data[0];
      const payload = data.subarray(1);
      if (tag === TAG_DOC) {
        Y.applyUpdate(ydoc, payload, REMOTE_ORIGIN);
        firstMessage = false;
        // Fired on every (re)connection, not only the first, so a caller showing
        // an "offline" state has an event that clears it.
        onSynced?.();
      } else if (tag === TAG_AWARENESS) {
        applyAwarenessUpdate(awareness, payload, REMOTE_ORIGIN);
      }
    };

    ws.onopen = () => {
      attempt = 0; // this connection worked; the next drop starts short again
      // The whole local state, every time. After a drop this is what carries the
      // offline edits back, and the server merges rather than overwrites — which
      // is the entire reason reconnecting is safe without a queue of our own.
      ws.send(frame(TAG_DOC, Y.encodeStateAsUpdate(ydoc)));
      ws.send(frame(TAG_AWARENESS, encodeAwarenessUpdate(awareness, [ydoc.clientID])));
      for (const f of pending) ws.send(f);
      pending.length = 0;
    };

    ws.onerror = () => onError?.();

    ws.onclose = () => {
      if (closing) return;
      // Before the first frame ever arrived the caller has nothing to show and
      // wants to know; after it, the document is on screen and a drop is a state
      // to display, not a failure.
      if (firstMessage) onError?.();
      else onClosed?.();
      retry();
    };
  }

  function open() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${location.host}/api/v1/items/${itemId}/sync`);
    ws.binaryType = "arraybuffer";
    wire();
  }

  function retry() {
    if (closing) return;
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    attempt += 1;
    retryTimer = window.setTimeout(open, wait);
  }

  open();

  return () => {
    closing = true;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
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
