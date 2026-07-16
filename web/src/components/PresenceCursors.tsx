import type { Awareness } from "y-protocols/awareness";

import { Avatar, avatarConfig } from "@/components/Avatar";
import { type PresentUser, usePointers } from "@/lib/presence";

/**
 * Overlay of remote mouse cursors, positioned within the editor column
 * (the parent must be `position: relative`). Each cursor = colored arrow
 * + label (initial + name). Subscribes to pointers itself (`usePointers`)
 * so that mouse movements only re-render this overlay. `match`
 * restricts to participants of a view / outside a row (databases).
 */
export function PresenceCursors({
  awareness,
  match,
}: {
  awareness: Awareness | null;
  match?: (u: PresentUser) => boolean;
}) {
  const pointers = usePointers(awareness);
  const visible = match ? pointers.filter(match) : pointers;
  if (visible.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {visible.map((u) => (
        <div
          key={u.clientId}
          className="absolute top-0 left-0 will-change-transform"
          // smooth transition: smooths the rAF rate without making the cursor lag.
          style={{
            transform: `translate(${u.pointer!.x}px, ${u.pointer!.y}px)`,
            transition: "transform 80ms linear",
          }}
        >
          <svg width="20" height="22" viewBox="0 0 20 22" fill="none" className="drop-shadow-sm">
            <path
              d="M2 2 L2 18.5 L6.4 14.3 L9.3 20.8 L12 19.6 L9.1 13.3 L15 13.1 Z"
              fill={u.color}
              stroke="white"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
          <div
            className="absolute top-4 left-3 flex items-center gap-1 whitespace-nowrap rounded-full py-0.5 pr-2 pl-0.5 text-xs font-medium text-white shadow-sm"
            style={{ backgroundColor: u.color }}
          >
            <Avatar
              name={u.name}
              config={avatarConfig(u.avatar)}
              color={u.color}
              size={18}
              ring={false}
              className="ring-1 ring-white/40"
            />
            {u.name}
          </div>
        </div>
      ))}
    </div>
  );
}
