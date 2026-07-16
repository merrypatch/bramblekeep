import { Check, ChevronLeft, ChevronRight, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Cell } from "@/components/DatabaseView";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { parseDateValue, type CalMode, type DbColumn, type Row } from "@/lib/db";
import { formatDate, monthLongNames, weekStartsOn, weekdayShortNames } from "@/lib/locale";
import { cn } from "@/lib/utils";

function isoDate(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Calendar view: monthly, weekly or daily grid; rows
 * placed on a date column (placement "all day", time is
 * ignored for positioning). */
export function CalendarView({
  rows,
  column,
  cardColumns,
  columns,
  canCreate,
  mode,
  onOpenRow,
  onAddRow,
  onDeleteRow,
}: {
  rows: Row[];
  column: DbColumn;
  /** Properties displayed below the entry title. */
  cardColumns: DbColumn[];
  /** All columns in the schema (to resolve formulas). */
  columns: DbColumn[];
  /** Add a row when clicking on a day — creator+. */
  canCreate: boolean;
  /** Display mode (persisted by the view). */
  mode: CalMode;
  onOpenRow: (id: string) => void;
  onAddRow: (dateIso: string) => void;
  onDeleteRow?: (row: Row) => void;
}) {
  const { t } = useTranslation();
  const months = monthLongNames();
  const weekdays = weekdayShortNames();
  const ws = weekStartsOn();
  const now = new Date();
  // Reference date: the displayed month (month), the week containing this day
  // (week) or the day itself (day).
  const [cursor, setCursor] = useState(() => new Date(now.getFullYear(), now.getMonth(), now.getDate()));

  const rowsOn = (dt: Date) => {
    const day = isoDate(dt);
    return rows.filter((r) => {
      const dv = parseDateValue(r.props[column.id]);
      return dv != null && dv.start.slice(0, 10) === day;
    });
  };

  /** Shifts the cursor by one unit (month/week/day) according to the mode. */
  const shift = (delta: number) =>
    setCursor((c) => {
      if (mode === "month") return new Date(c.getFullYear(), c.getMonth() + delta, 1);
      if (mode === "week") return new Date(c.getFullYear(), c.getMonth(), c.getDate() + delta * 7);
      return new Date(c.getFullYear(), c.getMonth(), c.getDate() + delta);
    });

  const goToday = () => setCursor(new Date(now.getFullYear(), now.getMonth(), now.getDate()));

  // Available height measured under the bar (month/year/nav) → only cells
  // scroll, the bar remains accessible.
  const contentRef = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState<number | undefined>(undefined);
  useEffect(() => {
    const update = () => {
      const el = contentRef.current;
      if (el) setMaxH(Math.max(240, window.innerHeight - el.getBoundingClientRect().top - 24));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [mode]);

  // Range of selectable years around the current year.
  const years = Array.from({ length: 21 }, (_, i) => cursor.getFullYear() - 10 + i);
  const setMonth = (m: number) => setCursor((c) => new Date(c.getFullYear(), m, 1));
  const setYear = (y: number) => setCursor((c) => new Date(y, c.getMonth(), 1));

  // First day of the week containing the cursor, per the active locale's week start.
  const weekStart = new Date(
    cursor.getFullYear(),
    cursor.getMonth(),
    cursor.getDate() - ((cursor.getDay() - ws + 7) % 7),
  );
  const weekDays = Array.from(
    { length: 7 },
    (_, i) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i),
  );

  const rangeLabel =
    mode === "day"
      ? formatDate(cursor, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : mode === "week"
        ? `${formatDate(weekDays[0], { day: "numeric", month: "short" })} – ${formatDate(weekDays[6], { day: "numeric", month: "short", year: "numeric" })}`
        : null;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="px-2 text-sm font-medium capitalize">
              {months[cursor.getMonth()]}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {months.map((name, m) => (
              <DropdownMenuItem key={m} className="capitalize" onSelect={() => setMonth(m)}>
                {name}
                {m === cursor.getMonth() && <Check className="ml-auto size-3.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="px-2 text-sm font-medium">
              {cursor.getFullYear()}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {years.map((y) => (
              <DropdownMenuItem key={y} onSelect={() => setYear(y)}>
                {y}
                {y === cursor.getFullYear() && <Check className="ml-auto size-3.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon-xs" variant="ghost" aria-label={t("calendar.prev")} onClick={() => shift(-1)}>
          <ChevronLeft />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label={t("calendar.next")} onClick={() => shift(1)}>
          <ChevronRight />
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={goToday}>
          {t("calendar.today")}
        </Button>
        {rangeLabel && <span className="text-sm text-muted-foreground capitalize">{rangeLabel}</span>}
      </div>

      <div ref={contentRef}>
      {mode === "month" && (
        <MonthGrid
          year={cursor.getFullYear()}
          month={cursor.getMonth()}
          now={now}
          rowsOn={rowsOn}
          cardColumns={cardColumns}
          columns={columns}
          canCreate={canCreate}
          maxHeight={maxH}
          onOpenRow={onOpenRow}
          onAddRow={onAddRow}
          onDeleteRow={onDeleteRow}
        />
      )}

      {mode === "week" && (
        <div
          style={{ maxHeight: maxH }}
          className="grid grid-cols-7 gap-px overflow-y-auto rounded-lg border bg-border text-sm"
        >
          {weekdays.map((w) => (
            <div
              key={w}
              className="sticky top-0 z-10 bg-muted/40 px-2 py-1 text-center text-xs text-muted-foreground"
            >
              {w}
            </div>
          ))}
          {weekDays.map((dt, i) => (
            <div key={i} className="group min-h-64 bg-background p-1">
              <DayNumber dt={dt} now={now} onAdd={canCreate ? () => onAddRow(isoDate(dt)) : undefined} />
              <DayEntries
                rows={rowsOn(dt)}
                cardColumns={cardColumns}
                columns={columns}
                onOpenRow={onOpenRow}
                onDeleteRow={onDeleteRow}
              />
            </div>
          ))}
        </div>
      )}

      {mode === "day" && (
        <div style={{ maxHeight: maxH }} className="overflow-y-auto rounded-lg border bg-background p-3">
          {canCreate && (
            <div className="mb-2 flex justify-end">
              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => onAddRow(isoDate(cursor))}>
                <Plus className="size-3.5" /> {t("calendar.add")}
              </Button>
            </div>
          )}
          <DayEntries
            rows={rowsOn(cursor)}
            cardColumns={cardColumns}
            columns={columns}
            large
            onOpenRow={onOpenRow}
            onDeleteRow={onDeleteRow}
          />
          {rowsOn(cursor).length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("calendar.noEntries")}</p>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

/** Monthly grid 7 × N weeks. */
function MonthGrid({
  year,
  month,
  now,
  rowsOn,
  cardColumns,
  columns,
  canCreate,
  maxHeight,
  onOpenRow,
  onAddRow,
  onDeleteRow,
}: {
  year: number;
  month: number;
  now: Date;
  rowsOn: (dt: Date) => Row[];
  cardColumns: DbColumn[];
  columns: DbColumn[];
  canCreate: boolean;
  maxHeight?: number;
  onOpenRow: (id: string) => void;
  onAddRow: (dateIso: string) => void;
  onDeleteRow?: (row: Row) => void;
}) {
  const weekdays = weekdayShortNames();
  const ws = weekStartsOn();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = (first.getDay() - ws + 7) % 7; // days before the 1st, per week start
  const cells: (number | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div
      style={{ maxHeight }}
      className="grid grid-cols-7 gap-px overflow-y-auto rounded-lg border bg-border text-sm"
    >
      {weekdays.map((w) => (
        <div
          key={w}
          className="sticky top-0 z-10 bg-muted/40 px-2 py-1 text-center text-xs text-muted-foreground"
        >
          {w}
        </div>
      ))}
      {cells.map((d, i) => {
        const dt = d ? new Date(year, month, d) : null;
        return (
          <div key={i} className="group min-h-20 bg-background p-1">
            {dt && (
              <>
                <DayNumber dt={dt} now={now} onAdd={canCreate ? () => onAddRow(isoDate(dt)) : undefined} />
                <DayEntries
                  rows={rowsOn(dt)}
                  cardColumns={cardColumns}
                  columns={columns}
                  onOpenRow={onOpenRow}
                  onDeleteRow={onDeleteRow}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Day number (blue dot if today) + "+" add button. */
function DayNumber({ dt, now, onAdd }: { dt: Date; now: Date; onAdd?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
      {sameDay(dt, now) ? (
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-blue-600 font-medium text-white">
          {dt.getDate()}
        </span>
      ) : (
        <span>{dt.getDate()}</span>
      )}
      {onAdd && (
        <button
          aria-label={t("calendar.addEntry")}
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          className="rounded opacity-0 transition-opacity hover:bg-muted group-hover:opacity-70 hover:opacity-100 max-sm:opacity-60"
        >
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** List of day entries (title + delete menu + card properties). */
function DayEntries({
  rows,
  cardColumns,
  columns,
  large,
  onOpenRow,
  onDeleteRow,
}: {
  rows: Row[];
  cardColumns: DbColumn[];
  columns: DbColumn[];
  large?: boolean;
  onOpenRow: (id: string) => void;
  onDeleteRow?: (row: Row) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-0.5">
      {rows.map((r) => (
        <div key={r.id} className="group rounded bg-primary/10 hover:bg-primary/20">
          <div className="flex items-center gap-0.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenRow(r.id);
              }}
              className={cn("min-w-0 flex-1 truncate px-1 py-0.5 text-left", large ? "text-sm" : "text-xs")}
            >
              {r.title || t("common.untitled")}
            </button>
            {onDeleteRow && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("calendar.rowActions")}
                    className="size-4 shrink-0 opacity-0 group-hover:opacity-60 hover:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenuItem variant="destructive" onSelect={() => onDeleteRow(r)}>
                    <Trash2 className="size-3.5" /> {t("calendar.deleteRow")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {cardColumns.length > 0 && (
            <div className="space-y-0.5 px-1 pb-0.5" onClick={(e) => e.stopPropagation()}>
              {cardColumns.map((c) => {
                const v = r.props[c.id];
                if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) return null;
                return (
                  <div key={c.id} className="text-[10px] text-muted-foreground">
                    <Cell col={c} value={v} canEdit={false} rowProps={r.props} columns={columns} onChange={() => {}} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
