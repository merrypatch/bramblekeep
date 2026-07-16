import { Avatar, avatarConfig } from "@/components/Avatar";
import type { PresentUser } from "@/lib/presence";

const MAX_SHOWN = 5;

/** Stack of avatars of present participants (self first). Each peer broadcasts
 * its avatar config via awareness (`u.avatar`) → everyone sees the right
 * visual. `selfAvatar` serves as an immediate fallback for self (before the round-trip). */
export function PresenceAvatars({
  users,
  selfAvatar,
}: {
  users: PresentUser[];
  selfAvatar?: string | null;
}) {
  if (users.length === 0) return null;
  const shown = users.slice(0, MAX_SHOWN);
  const extra = users.length - shown.length;

  return (
    <div className="flex items-center -space-x-2" aria-label={`${users.length} present`}>
      {shown.map((u) => (
        <Avatar
          key={u.clientId}
          name={u.isSelf ? `${u.name} (you)` : u.name}
          config={avatarConfig(u.isSelf ? (selfAvatar ?? u.avatar) : u.avatar)}
        />
      ))}
      {extra > 0 && (
        <span className="inline-flex size-[26px] items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground ring-2 ring-background">
          +{extra}
        </span>
      )}
    </div>
  );
}
