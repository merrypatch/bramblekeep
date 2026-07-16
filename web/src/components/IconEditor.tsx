import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

import { ItemIcon, type ItemKind } from "@/components/ItemIcon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PickerSkeleton } from "@/components/ui/skeletons";

const IconPicker = lazy(() =>
  import("@/components/IconPicker").then((m) => ({ default: m.IconPicker })),
);

/** An item's icon, clickable to open the picker (emoji / Lucide) when editable.
 * `stopPropagation` on the trigger → doesn't open the surrounding card/row. */
export function IconEditor({
  icon,
  kind,
  size = 16,
  className,
  canEdit,
  onChange,
}: {
  icon?: string | null;
  kind?: ItemKind;
  size?: number;
  className?: string;
  canEdit: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!canEdit) return <ItemIcon icon={icon} kind={kind} size={size} className={className} />;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={t("common.changeIcon")}
          className="shrink-0 rounded p-0.5 hover:bg-accent"
          onClick={(e) => e.stopPropagation()}
        >
          <ItemIcon icon={icon} kind={kind} size={size} className={className} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0" onClick={(e) => e.stopPropagation()}>
        <Suspense fallback={<PickerSkeleton />}>
          <IconPicker
            onPick={(v) => {
              onChange(v);
              setOpen(false);
            }}
            onRemove={
              icon
                ? () => {
                    onChange("");
                    setOpen(false);
                  }
                : undefined
            }
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
