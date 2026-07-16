import { FileText, Table2 } from "lucide-react";
import DynamicIcon from "lucide-react/dist/esm/DynamicIcon.js";

/** Prefix distinguishing a Lucide icon (`lucide:rocket`) from a raw emoji. */
export const LUCIDE_PREFIX = "lucide:";

/** Encodes a Lucide icon name into a value storable in `item.icon`. */
export const lucideValue = (name: string) => `${LUCIDE_PREFIX}${name}`;

/** Item type: determines the default icon when `icon` is empty. */
export type ItemKind = "page" | "database";

/**
 * Unified rendering of an item's icon, whatever its form:
 * - `lucide:<name>` → Lucide icon (lazy),
 * - any other string → emoji / text,
 * - empty → default icon based on the type (page → document, database → table).
 */
export function ItemIcon({
  icon,
  kind = "page",
  size = 16,
  className,
}: {
  icon?: string | null;
  kind?: ItemKind;
  size?: number;
  className?: string;
}) {
  if (icon && icon.startsWith(LUCIDE_PREFIX)) {
    return <DynamicIcon name={icon.slice(LUCIDE_PREFIX.length)} size={size} className={className} />;
  }
  if (icon) {
    return (
      <span className={className} style={{ fontSize: size, lineHeight: 1 }}>
        {icon}
      </span>
    );
  }
  const Default = kind === "database" ? Table2 : FileText;
  return <Default size={size} className={className} />;
}
