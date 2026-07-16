import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Color palette for `select` options (badge-style, light/dark).
 * Hardcoded classes -> detected by the Tailwind scanner. Readable labels
 * live in i18n (`dbview.color.<name>`). */
export const OPTION_COLORS: Record<string, { badge: string; dot: string }> = {
  gray: {
    badge: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
    dot: "bg-zinc-400",
  },
  red: {
    badge: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    dot: "bg-red-500",
  },
  orange: {
    badge: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  yellow: {
    badge: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
    dot: "bg-yellow-500",
  },
  green: {
    badge: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    dot: "bg-green-500",
  },
  blue: {
    badge: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    dot: "bg-blue-500",
  },
  purple: {
    badge: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    dot: "bg-purple-500",
  },
  pink: {
    badge: "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300",
    dot: "bg-pink-500",
  },
};

export const DEFAULT_OPTION_COLOR = "gray";
export const OPTION_COLOR_NAMES = Object.keys(OPTION_COLORS);

const colorOf = (color?: string) => OPTION_COLORS[color ?? ""] ?? OPTION_COLORS[DEFAULT_OPTION_COLOR];

/** Colored badge representing a `select` value. `dot` adds a color dot
 * at the beginning (for "Status" rendering). */
export function OptionBadge({
  value,
  color,
  dot,
  className,
}: {
  value: string;
  color?: string;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs font-medium",
        colorOf(color).badge,
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 shrink-0 rounded-full", colorOf(color).dot)} />}
      {value}
    </span>
  );
}

/** Color picker (dot + palette menu). */
export function ColorPicker({
  color,
  onChange,
}: {
  color?: string;
  onChange: (color: string) => void;
}) {
  const { t } = useTranslation();
  const active = color ?? DEFAULT_OPTION_COLOR;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("dbview.color.aria")}
          className={cn("size-4 shrink-0 rounded-full ring-1 ring-border", colorOf(color).dot)}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-36">
        {OPTION_COLOR_NAMES.map((name) => (
          <DropdownMenuItem key={name} onSelect={() => onChange(name)}>
            <span className={cn("size-3.5 rounded-full", OPTION_COLORS[name].dot)} />
            <span className="flex-1">{t(`dbview.color.${name}` as "dbview.color.gray")}</span>
            {name === active && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
