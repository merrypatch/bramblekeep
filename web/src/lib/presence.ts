import { type RefObject, useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";

import { acquireRoom, releaseRoom } from "@/lib/room";
import { connectSync } from "@/lib/sync";

/** Position of a pointer, in editor-column coordinates (px). */
export type Pointer = { x: number; y: number };

/** A participant present on the page (derived from the Yjs awareness). */
export type PresentUser = {
  clientId: number;
  name: string;
  color: string;
  /** Avatar JSON config (react-nice-avatar) broadcast by the peer; null = derived from name. */
  avatar: string | null;
  pointer: Pointer | null;
  isSelf: boolean;
  /** Item where the participant is (e.g. db row), if broadcast. */
  location: string | null;
  /** Participant's active view (e.g. db view id), if broadcast. */
  view: string | null;
};

/** Stable color derived from the name (HSL hue). Shared editor/presence. */
export function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 70% 55%)`;
}

/**
 * Reactive list of present participants, read from the relayed awareness.
 * The `user` field (name/color) is set by the BlockNote collaboration; the
 * `pointer` field is ours (cf. `useBroadcastPointer`).
 */
export function usePresence(awareness: Awareness | null): PresentUser[] {
  const [users, setUsers] = useState<PresentUser[]>([]);

  useEffect(() => {
    if (!awareness) return;
    // Signature WITHOUT the pointer or the text cursor: the list only changes
    // (and thus re-renders) on join/leave, rename, view change or location
    // change — not on every keystroke or mouse move. This is what avoids
    // continuously re-rendering the whole editor (cf. usePointers for cursors).
    let sig = "";
    const read = () => {
      const local = awareness.clientID;
      const out: PresentUser[] = [];
      awareness.getStates().forEach((state, clientId) => {
        const user = state.user as { name?: string; color?: string } | undefined;
        if (!user?.name) return; // state not yet initialized by BlockNote
        out.push({
          clientId,
          name: user.name,
          color: user.color ?? "#888888",
          avatar: (state.avatar as string | null | undefined) ?? null,
          pointer: null,
          isSelf: clientId === local,
          location: (state.location as string | undefined) ?? null,
          view: (state.view as string | undefined) ?? null,
        });
      });
      // Self first, then stable order by clientId.
      out.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.clientId - b.clientId);
      const nextSig = out
        .map((u) => `${u.clientId}:${u.name}:${u.color}:${u.avatar}:${u.view}:${u.location}:${u.isSelf}`)
        .join("|");
      if (nextSig === sig) return;
      sig = nextSig;
      setUsers(out);
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [awareness]);

  return users;
}

/**
 * Remote mouse cursors only (`pointer` field). Hook separate from
 * `usePresence` so that mouse/cursor movements only re-render the cursor
 * overlay, never the editor or the page.
 */
export function usePointers(awareness: Awareness | null): PresentUser[] {
  const [pointers, setPointers] = useState<PresentUser[]>([]);

  useEffect(() => {
    if (!awareness) return;
    const read = () => {
      const local = awareness.clientID;
      const out: PresentUser[] = [];
      awareness.getStates().forEach((state, clientId) => {
        const user = state.user as { name?: string; color?: string } | undefined;
        const p = state.pointer as Pointer | null | undefined;
        if (!user?.name || clientId === local || !p) return;
        out.push({
          clientId,
          name: user.name,
          color: user.color ?? "#888888",
          avatar: (state.avatar as string | null | undefined) ?? null,
          pointer: p,
          isSelf: false,
          location: (state.location as string | undefined) ?? null,
          view: (state.view as string | undefined) ?? null,
        });
      });
      setPointers(out);
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [awareness]);

  return pointers;
}

/**
 * Broadcasts our mouse position in the awareness, in coordinates relative to
 * `ref` (the editor column, fixed width + same content across all clients →
 * coordinates map 1:1). Throttled to the display rate (rAF). The field is set
 * to `null` when the mouse leaves the area.
 */
export function useBroadcastPointer(
  awareness: Awareness | null,
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!awareness || !enabled || !el) return;

    let raf = 0;
    const onMove = (e: MouseEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rect = el.getBoundingClientRect();
        awareness.setLocalStateField("pointer", {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        } satisfies Pointer);
      });
    };
    const onLeave = () => awareness.setLocalStateField("pointer", null);

    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
      awareness.setLocalStateField("pointer", null);
    };
  }, [awareness, ref, enabled]);
}

/**
 * Connects an item's room (outside the editor) to broadcast presence there, and
 * returns the list of participants. `location` (optional) signals where we
 * are (e.g. the current db row) — read by the parent database's view.
 * `itemId` null → inactive (no connection).
 */
export function useLivePresence(
  itemId: string | null,
  userName: string,
  avatar: string | null,
  location?: string,
): PresentUser[] {
  const [awareness, setAwareness] = useState<Awareness | null>(null);
  useEffect(() => {
    if (!itemId) {
      setAwareness(null);
      return;
    }
    const room = acquireRoom(itemId);
    room.awareness.setLocalState({
      user: { name: userName, color: colorFromName(userName) },
      avatar,
      ...(location ? { location } : {}),
    });
    setAwareness(room.awareness);
    const disconnect = connectSync(room.doc, room.awareness, itemId, {});
    return () => {
      disconnect();
      releaseRoom(itemId);
      setAwareness(null);
    };
  }, [itemId, userName, avatar, location]);
  return usePresence(awareness);
}
