import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { connectSync } from "./sync";

/** Sockets opened during a test, newest last. */
let sockets: FakeSocket[] = [];

/** A WebSocket that goes nowhere and does exactly what it is told.
 *
 * The reconnection logic is the part of this module worth pinning: it decides
 * when to give up, when not to, and whether a page that went offline ever comes
 * back. None of that needs a network — only a socket that can be made to fail. */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = "";
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;

  constructor(public url: string) {
    sockets.push(this);
  }
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  /** The server accepted the connection. */
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** A first document frame arrives — what the client counts as "synced". */
  deliverDoc(doc: Y.Doc) {
    const update = Y.encodeStateAsUpdate(doc);
    const framed = new Uint8Array(update.length + 1);
    framed[0] = 0; // TAG_DOC
    framed.set(update, 1);
    this.onmessage?.({ data: framed.buffer as ArrayBuffer });
  }
  /** The connection drops. */
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "example.test" });
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function room() {
  const doc = new Y.Doc();
  return { doc, awareness: new Awareness(doc) };
}

describe("connectSync", () => {
  it("reports a sync on every connection, not only the first", () => {
    const { doc, awareness } = room();
    const onSynced = vi.fn();
    const stop = connectSync(doc, awareness, "item-1", { onSynced });

    sockets[0].accept();
    sockets[0].deliverDoc(new Y.Doc());
    expect(onSynced).toHaveBeenCalledTimes(1);

    // A drop, a retry, and a second successful connection.
    sockets[0].drop();
    vi.advanceTimersByTime(1_000);
    sockets[1].accept();
    sockets[1].deliverDoc(new Y.Doc());
    // Without this second call the interface would keep showing "offline" after
    // the connection came back.
    expect(onSynced).toHaveBeenCalledTimes(2);

    stop();
  });

  it("backs off between attempts instead of hammering a server that is down", () => {
    const { doc, awareness } = room();
    const stop = connectSync(doc, awareness, "item-1");
    sockets[0].accept();
    sockets[0].deliverDoc(new Y.Doc());

    sockets[0].drop();
    expect(sockets).toHaveLength(1); // not immediately
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2); // 1s

    sockets[1].drop();
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3); // 2s

    sockets[2].drop();
    vi.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(4); // 5s

    stop();
  });

  it("keeps trying after a long outage rather than giving up", () => {
    const { doc, awareness } = room();
    const stop = connectSync(doc, awareness, "item-1");
    sockets[0].accept();
    sockets[0].deliverDoc(new Y.Doc());

    // Twenty failures — a laptop shut for the night.
    for (let i = 0; i < 20; i++) {
      sockets[sockets.length - 1].drop();
      vi.advanceTimersByTime(30_000);
    }
    expect(sockets.length).toBe(21);

    // And the backoff is capped, not exponential forever: the last wait is still
    // 30s, so coming back online is noticed within half a minute.
    const before = sockets.length;
    sockets[sockets.length - 1].drop();
    vi.advanceTimersByTime(30_000);
    expect(sockets.length).toBe(before + 1);

    stop();
  });

  it("starts short again once a connection has worked", () => {
    const { doc, awareness } = room();
    const stop = connectSync(doc, awareness, "item-1");
    sockets[0].accept();
    sockets[0].deliverDoc(new Y.Doc());

    // Climb the backoff.
    sockets[0].drop();
    vi.advanceTimersByTime(1_000);
    sockets[1].drop();
    vi.advanceTimersByTime(2_000);
    // This one succeeds.
    sockets[2].accept();
    sockets[2].deliverDoc(new Y.Doc());

    // The next drop must wait 1s again, not 5s.
    sockets[2].drop();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(4);

    stop();
  });

  it("stops for good when the caller disconnects", () => {
    const { doc, awareness } = room();
    const onClosed = vi.fn();
    const stop = connectSync(doc, awareness, "item-1", { onClosed });
    sockets[0].accept();
    sockets[0].deliverDoc(new Y.Doc());

    stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1); // no reconnection after leaving the page
    expect(onClosed).not.toHaveBeenCalled(); // and it is not reported as a drop
  });

  it("cancels a retry that was already scheduled when the caller leaves", () => {
    const { doc, awareness } = room();
    const stop = connectSync(doc, awareness, "item-1");
    sockets[0].accept();
    sockets[0].deliverDoc(new Y.Doc());

    sockets[0].drop(); // a retry is now pending
    stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  /// Edits made while the socket is down have to survive to the next one.
  it("sends the whole document state on every connection", () => {
    const { doc, awareness } = room();
    const stop = connectSync(doc, awareness, "item-1");
    sockets[0].accept();
    sockets[0].deliverDoc(new Y.Doc());
    sockets[0].drop();

    // Typing with no connection.
    doc.getXmlFragment("document-store").push([new Y.XmlText("written offline")]);

    vi.advanceTimersByTime(1_000);
    sockets[1].accept();

    // The first frame of the new socket carries the full state, so the server
    // merges the offline edit rather than never hearing about it.
    const first = sockets[1].sent[0];
    expect(first[0]).toBe(0); // TAG_DOC
    const replayed = new Y.Doc();
    Y.applyUpdate(replayed, first.subarray(1));
    expect(replayed.getXmlFragment("document-store").toString()).toContain("written offline");

    stop();
  });

  it("reports an outright failure to connect, then retries anyway", () => {
    const { doc, awareness } = room();
    const onError = vi.fn();
    const stop = connectSync(doc, awareness, "item-1", { onError });

    sockets[0].drop(); // never opened, never synced
    expect(onError).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);

    stop();
  });
});
