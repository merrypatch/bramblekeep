import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Skeleton presets tailored to each loading zone. They mirror the shape of the
// expected content (title + paragraphs, list rows, table…) for a shorter perceived
// load with no layout shift. Deterministic widths (no Math.random) → stable,
// non-distracting rendering.

const LINE_WIDTHS = ["w-full", "w-11/12", "w-10/12", "w-9/12", "w-8/12", "w-7/12"];

/** Block of text lines (paragraph, dialog body…). */
export function TextLinesSkeleton({
  lines = 4,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2.5", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", LINE_WIDTHS[i % LINE_WIDTHS.length])} />
      ))}
    </div>
  );
}

/**
 * Skeleton of a page/editor: title + paragraphs, in the same centered column as
 * the real content (max-w-4xl). `fill` takes up the height under the Shell header
 * (h-14) → stays within the editable area, outside the sidebar.
 */
export function PageSkeleton({ fill = false }: { fill?: boolean }) {
  return (
    <div className={cn("mx-auto w-full max-w-4xl px-2 pt-8", fill && "min-h-[calc(100dvh-3.5rem)]")}>
      <Skeleton className="mb-8 h-9 w-2/3" />
      <div className="space-y-6">
        <TextLinesSkeleton lines={3} />
        <TextLinesSkeleton lines={4} />
        <TextLinesSkeleton lines={2} />
      </div>
    </div>
  );
}

/** Feed/history-style rows: badge (avatar) + two lines of text. */
export function ListRowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="space-y-4">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex gap-2.5">
          <Skeleton className="size-6 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Table skeleton (inline databases / table view): header + rows. */
export function TableSkeleton({
  rows = 5,
  cols = 4,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <div className="w-full space-y-2">
      <div className="flex gap-3 border-b pb-2">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3 py-1.5">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Skeleton of an emoji/icon picker: search bar + grid. */
export function PickerSkeleton() {
  return (
    <div className="w-[340px] max-w-[90vw] space-y-3 p-3">
      <Skeleton className="h-8 w-full" />
      <div className="grid grid-cols-8 gap-1.5">
        {Array.from({ length: 40 }, (_, i) => (
          <Skeleton key={i} className="aspect-square rounded-sm" />
        ))}
      </div>
    </div>
  );
}

/**
 * Full-screen app skeleton: sidebar + header + page. For boot (session check)
 * and Shell loading (lazy).
 */
export function AppShellSkeleton() {
  return (
    <div className="flex min-h-dvh">
      <div className="hidden w-64 shrink-0 flex-col gap-2 border-r p-4 sm:flex">
        <Skeleton className="h-8 w-32" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <Skeleton className="h-6 w-6" />
          <Skeleton className="h-4 w-40" />
        </div>
        <PageSkeleton />
      </div>
    </div>
  );
}
