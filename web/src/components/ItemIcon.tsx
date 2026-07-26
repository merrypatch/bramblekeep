import { FileText, Table2 } from "lucide-react";
import DynamicIcon from "lucide-react/dist/esm/DynamicIcon.js";

import { fileUrl } from "@/lib/api";
import { parseIcon } from "@/lib/icon";

/** Item type: determines the default icon when `icon` is empty. */
export type ItemKind = "page" | "database";

/**
 * Unified rendering of an item's icon, whatever its form (encoding in `lib/icon`):
 * - `lucide:<name>` → Lucide icon (lazy),
 * - `file:sha256:…` → custom image, served by the app,
 * - any other string → emoji / text,
 * - empty → default icon based on the type (page → document, database → table).
 */
export function ItemIcon({
  icon,
  kind = "page",
  size = 16,
  className,
  resolveFile = fileUrl,
}: {
  icon?: string | null;
  kind?: ItemKind;
  size?: number;
  className?: string;
  /** Resolves an image hash into a URL. Overridden by the public page, which
   * serves files through the publication token rather than the session. */
  resolveFile?: (hash: string) => string;
}) {
  const parsed = parseIcon(icon);
  switch (parsed.kind) {
    case "lucide":
      return <DynamicIcon name={parsed.name} size={size} className={className} />;
    case "file":
      return (
        <img
          src={resolveFile(parsed.hash)}
          alt=""
          width={size}
          height={size}
          // Square and cropped: the icon keeps its slot whatever the source ratio.
          className={className}
          style={{ width: size, height: size, objectFit: "cover", borderRadius: size / 8 }}
        />
      );
    case "emoji":
      return (
        <span className={className} style={{ fontSize: size, lineHeight: 1 }}>
          {parsed.text}
        </span>
      );
    case "empty": {
      const Default = kind === "database" ? Table2 : FileText;
      return <Default size={size} className={className} />;
    }
  }
}
