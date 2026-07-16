import EmojiPicker, { EmojiStyle, Theme } from "emoji-picker-react";
import { Search } from "lucide-react";
import DynamicIcon, { iconNames } from "lucide-react/dist/esm/DynamicIcon.js";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { lucideValue } from "@/components/ItemIcon";
import { cn } from "@/lib/utils";

/** Max number of icons rendered (each icon = a lazy import → we cap it). */
const MAX_ICONS = 120;

/**
 * Icon picker: emoji tab (full catalog, native rendering = zero CDN) or Lucide
 * icons tab (search + lazy grid). `onPick` receives the ready-to-store value
 * (raw emoji or `lucide:<name>`). `onRemove` clears the icon.
 */
export function IconPicker({
  onPick,
  onRemove,
}: {
  onPick: (value: string) => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"emoji" | "icons">("emoji");

  return (
    <div className="w-[340px] max-w-[90vw] rounded-md border bg-popover shadow-md">
      <div className="flex items-center gap-1 border-b p-1">
        <TabButton active={tab === "emoji"} onClick={() => setTab("emoji")}>
          {t("iconPicker.emoji")}
        </TabButton>
        <TabButton active={tab === "icons"} onClick={() => setTab("icons")}>
          {t("iconPicker.icons")}
        </TabButton>
        {onRemove && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-xs text-muted-foreground"
            onClick={onRemove}
          >
            {t("iconPicker.remove")}
          </Button>
        )}
      </div>

      {tab === "emoji" ? (
        <EmojiPicker
          onEmojiClick={(e) => onPick(e.emoji)}
          emojiStyle={EmojiStyle.NATIVE}
          theme={Theme.AUTO}
          lazyLoadEmojis
          width="100%"
          height={360}
          previewConfig={{ showPreview: false }}
        />
      ) : (
        <IconsTab onPick={(name) => onPick(lucideValue(name))} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded px-3 py-1 text-sm",
        active ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50",
      )}
    >
      {children}
    </button>
  );
}

function IconsTab({ onPick }: { onPick: (name: string) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const src = q ? iconNames.filter((n) => n.includes(q)) : iconNames;
    return src.slice(0, MAX_ICONS);
  }, [query]);

  return (
    <div className="p-2">
      <div className="relative mb-2">
        <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          autoFocus
          placeholder={t("iconPicker.searchPlaceholder")}
          className="h-8 pl-7 text-sm"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="grid max-h-72 grid-cols-8 gap-1 overflow-y-auto">
        {results.map((name) => (
          <button
            key={name}
            title={name}
            className="flex aspect-square items-center justify-center rounded hover:bg-accent"
            onClick={() => onPick(name)}
          >
            <DynamicIcon name={name} size={18} />
          </button>
        ))}
        {results.length === 0 && (
          <p className="col-span-8 py-4 text-center text-xs text-muted-foreground">{t("iconPicker.noIcons")}</p>
        )}
      </div>
    </div>
  );
}
