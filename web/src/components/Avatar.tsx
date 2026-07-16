import ReactNiceAvatar, { type AvatarFullConfig, genConfig } from "react-nice-avatar";

import { cn } from "@/lib/utils";

export type { AvatarFullConfig as AvatarConfig };

/** Parses a stored avatar config (JSON); `null` if absent or invalid. */
export function avatarConfig(raw: string | null | undefined): AvatarFullConfig | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AvatarFullConfig;
  } catch {
    return null;
  }
}

/**
 * Illustrated avatar (react-nice-avatar). An explicit `config` is rendered as
 * is; otherwise a deterministic avatar is derived from the name (everyone has
 * their own, stable, with no data to store). `color` is accepted for backward
 * compat but ignored (old calls passed an initial color).
 */
export function Avatar({
  name,
  config,
  size = 26,
  ring = true,
  className,
}: {
  name: string;
  config?: AvatarFullConfig | null;
  size?: number;
  ring?: boolean;
  className?: string;
  /** @deprecated replaced by the illustrated avatar; ignored. */
  color?: string;
}) {
  const cfg = config ?? genConfig(name);
  return (
    <span
      title={name}
      className={cn(
        "inline-flex shrink-0 select-none overflow-hidden rounded-full",
        ring && "ring-2 ring-background",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <ReactNiceAvatar style={{ width: size, height: size }} shape="circle" {...cfg} />
    </span>
  );
}
