import {
  ArrowDown,
  ArrowLeftRight,
  FunctionSquare,
  Repeat,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  AtSign,
  Calendar as CalendarIcon,
  CalendarClock,
  CalendarPlus,
  Check,
  ChevronDown,
  Copy,
  FileText,
  ChevronRight,
  Circle,
  CircleDot,
  ExternalLink,
  Eye,
  EyeOff,
  Filter,
  GripVertical,
  Hash,
  Info,
  Link as LinkIcon,
  ListChecks,
  type LucideIcon,
  Maximize2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Star,
  Phone,
  Plus,
  Rows3,
  Search,
  Settings2,
  SquareCheck,
  Trash2,
  Type,
  UserPen,
  WrapText,
  UserPlus,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { BoardView } from "@/components/db/BoardView";
import { CalendarView } from "@/components/db/CalendarView";
import { ChartView } from "@/components/db/ChartView";
import { FormulaEditor } from "@/components/db/FormulaEditor";
import { GridView, imageColumns } from "@/components/db/GridView";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { toast } from "sonner";

import { buildChart } from "@/lib/chart";
import { DATE_TOKEN_RE, isoDay, resolveTokens, type TokenCtx } from "@/lib/templateTokens";
import {
  evalFormula,
  FormulaError,
  type FormulaValue,
  formatFormulaValue,
  parseFormula,
} from "@/lib/formula";
import { ColorPicker, OptionBadge } from "@/components/db/OptionBadge";
import { IconEditor } from "@/components/IconEditor";
import { ItemIcon } from "@/components/ItemIcon";
import { PresenceAvatars } from "@/components/PresenceAvatars";
import { PresenceCursors } from "@/components/PresenceCursors";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { Editor } from "@/components/Editor";
import { PageHeader } from "@/components/PageHeader";
import { acquireRoom, releaseRoom, type Room } from "@/lib/room";
import { colorFromName, type PresentUser, useBroadcastPointer } from "@/lib/presence";
import { connectSync } from "@/lib/sync";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ApiError,
  createItem,
  duplicateItem,
  deleteItem,
  fileUrl,
  getItem,
  getItemCached,
  type ItemMeta,
  type MetaPatch,
  listItems,
  listRows,
  patchItem,
  updateProperties,
  updateSchema,
  uploadFile,
  type RowMeta,
} from "@/lib/api";
import {
  type CalMode,
  type ChartKind,
  columnTypeLabel,
  COLUMN_TYPES,
  type ColumnType,
  type DbColumn,
  type DbSchema,
  type DbView,
  fileImageHash,
  type FileRef,
  type GridSize,
  META_TYPES,
  newColumnId,
  parseDateValue,
  newViewId,
  orderRows,
  parseProps,
  parseSchema,
  type PropValues,
  type Row,
  STATUS_GROUPS,
  statusGroupLabel,
  type ViewType,
} from "@/lib/db";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

const toRow = (r: RowMeta): Row => ({
  id: r.id,
  title: r.title,
  icon: r.icon,
  cover: r.cover,
  props: parseProps(r.properties),
  createdTs: r.ts,
  createdBy: r.created_by,
  updatedTs: r.updated_ts,
  updatedBy: r.updated_by,
});

/** Key of the Name column (the page title), distinct from the schema columns. */
const TITLE_KEY = "__title";

/** Calendar year bounds for date fields. Wide enough for historical dates
 * (year 1 AD) up to a comfortable future. Year 1 needs setFullYear: the
 * `new Date(1, 0)` constructor maps 0–99 to 1900–1999. The paged year picker
 * (see calendar.tsx) keeps this range navigable without a giant native list. */
const CAL_MIN_MONTH = (() => {
  const d = new Date(1, 0, 1);
  d.setFullYear(1);
  return d;
})();
const CAL_MAX_MONTH = new Date(2200, 11, 31);

/** Column types used as a time axis in a chart (date + meta dates). */
const CHART_TIME_TYPES = new Set(["date", "created_time", "last_edited_time"]);

type SortState = { key: string; dir: "asc" | "desc" };
type FilterState = { id: string; key: string; query: string };

/** Cleans an input to keep only a valid number: digits, a single decimal
 * point (comma converted), minus sign at the start only.
 * `allowDot=false` → integer only (no decimals). */
function sanitizeNumericInput(s: string, allowDot = true): string {
  let out = s.replace(/,/g, ".").replace(allowDot ? /[^0-9.-]/g : /[^0-9-]/g, "");
  out = out.replace(/(?!^)-/g, ""); // minus only in the first position
  if (allowDot) {
    const dot = out.indexOf(".");
    if (dot !== -1) out = out.slice(0, dot + 1) + out.slice(dot + 1).replace(/\./g, "");
  }
  return out;
}

/** Cleans a phone input: digits, +, spaces, ( ) - . (no letters). */
function sanitizePhoneInput(s: string): string {
  return s.replace(/[^0-9+()\-.\s]/g, "");
}

/** Text representation of a cell (for filtering + non-numeric sorting). */
function cellText(row: Row, key: string): string {
  if (key === TITLE_KEY) return row.title ?? "";
  const v = row.props[key];
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (Array.isArray(v))
    return v.map((x) => (typeof x === "string" ? x : ((x as { name?: string })?.name ?? ""))).join(" ");
  if (typeof v === "object") {
    const d = v as { start?: unknown; end?: unknown };
    if (typeof d.start === "string") return `${d.start} ${typeof d.end === "string" ? d.end : ""}`.trim();
    return "";
  }
  return String(v);
}

/** Short localized label of a column-footer aggregate (spreadsheet-style "Calculate"). */
function aggLabel(agg: string): string {
  return i18n.t(`dbview.agg.${agg}` as "dbview.agg.count");
}

/** Computes a column's aggregate over the displayed rows. */
function computeAgg(rows: Row[], key: string, agg: string): string {
  const total = rows.length;
  const texts = rows.map((r) => cellText(r, key));
  const filled = texts.filter((t) => t !== "").length;
  switch (agg) {
    case "count":
      return String(total);
    case "count_values":
      return String(filled);
    case "count_empty":
      return String(total - filled);
    case "count_unique":
      return String(new Set(texts.filter((t) => t !== "")).size);
    case "percent_filled":
      return total ? `${Math.round((filled / total) * 100)} %` : "0 %";
    case "percent_empty":
      return total ? `${Math.round(((total - filled) / total) * 100)} %` : "0 %";
    case "checked":
      return String(rows.filter((r) => r.props[key] === true).length);
    case "unchecked":
      return String(rows.filter((r) => r.props[key] !== true).length);
    case "percent_checked": {
      const c = rows.filter((r) => r.props[key] === true).length;
      return total ? `${Math.round((c / total) * 100)} %` : "0 %";
    }
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const nums = rows
        .map((r) => r.props[key])
        .filter((v) => v != null && v !== "")
        .map((v) => Number(v))
        .filter((n) => !Number.isNaN(n));
      if (nums.length === 0) return "—";
      if (agg === "sum") return String(nums.reduce((a, b) => a + b, 0));
      if (agg === "avg") return String(Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100);
      if (agg === "min") return String(Math.min(...nums));
      return String(Math.max(...nums));
    }
    default:
      return "";
  }
}

/** Applies filters (AND, case-insensitive substring) then sorting. */
function applyView(rows: Row[], filters: FilterState[], sort: SortState | null, columns: DbColumn[]): Row[] {
  let out = rows.filter((r) =>
    filters.every((f) => !f.query || cellText(r, f.key).toLowerCase().includes(f.query.toLowerCase())),
  );
  if (sort) {
    const col = columns.find((c) => c.id === sort.key);
    const numeric = col?.type === "number";
    out = [...out].sort((a, b) => {
      let cmp: number;
      if (numeric) {
        const na = a.props[sort.key];
        const nb = b.props[sort.key];
        const va = na == null || na === "" ? Infinity : Number(na);
        const vb = nb == null || nb === "" ? Infinity : Number(nb);
        cmp = (Number.isNaN(va) ? Infinity : va) - (Number.isNaN(vb) ? Infinity : vb);
      } else {
        cmp = cellText(a, sort.key).localeCompare(cellText(b, sort.key));
      }
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }
  return out;
}

/** Column header: sort (everyone) + insert/edit/delete (editing).
 * The trigger takes the full width of the column. */
function HeaderMenu({
  label,
  sublabel,
  keyId,
  sort,
  onSort,
  onInsertLeft,
  onInsertRight,
  onEdit,
  onHide,
  onToggleWrap,
  wrapOn,
  onDelete,
}: {
  label: string;
  sublabel?: string;
  keyId: string;
  sort: SortState | null;
  onSort: (dir: "asc" | "desc") => void;
  onInsertLeft?: () => void;
  onInsertRight?: () => void;
  onEdit?: () => void;
  onHide?: () => void;
  onToggleWrap?: () => void;
  wrapOn?: boolean;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center gap-1 hover:text-foreground/70">
          <span className="truncate">{label}</span>
          {sublabel && <span className="text-[10px] font-normal text-muted-foreground">{sublabel}</span>}
          {sort?.key === keyId &&
            (sort.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onSort("asc")}>
          <ArrowUp className="size-3.5" /> {t("dbview.header.sortAsc")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSort("desc")}>
          <ArrowDown className="size-3.5" /> {t("dbview.header.sortDesc")}
        </DropdownMenuItem>
        {(onInsertLeft || onInsertRight) && <DropdownMenuSeparator />}
        {onInsertLeft && (
          <DropdownMenuItem onSelect={onInsertLeft}>
            <ArrowLeftToLine className="size-3.5" /> {t("dbview.header.insertLeft")}
          </DropdownMenuItem>
        )}
        {onInsertRight && (
          <DropdownMenuItem onSelect={onInsertRight}>
            <ArrowRightToLine className="size-3.5" /> {t("dbview.header.insertRight")}
          </DropdownMenuItem>
        )}
        {(onEdit || onHide || onDelete) && <DropdownMenuSeparator />}
        {onEdit && (
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="size-3.5" /> {t("dbview.header.edit")}
          </DropdownMenuItem>
        )}
        {onToggleWrap && (
          <DropdownMenuItem onSelect={onToggleWrap}>
            <WrapText className="size-3.5" /> {t("dbview.header.wrap")}
            {wrapOn && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        )}
        {onHide && (
          <DropdownMenuItem onSelect={onHide}>
            <EyeOff className="size-3.5" /> {t("dbview.header.hideInView")}
          </DropdownMenuItem>
        )}
        {onDelete && (
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 className="size-3.5" /> {t("dbview.header.delete")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Table view of a database: typed columns + rows (child pages). */
export function DatabaseView({
  dbId,
  schemaJson,
  canEdit,
  canCreate = false,
  canDelete = false,
  userName = "",
  avatar = null,
  presence = [],
  doc = null,
  awareness = null,
  hiddenViews,
  onSetHiddenViews,
  viewState,
  onSetViewState,
}: {
  dbId: string;
  schemaJson: string | null;
  /** Edit the data (cells) — editor+. */
  canEdit: boolean;
  /** Create rows + manage the schema (columns, views, order) — creator+. */
  canCreate?: boolean;
  /** Delete rows — admin+. */
  canDelete?: boolean;
  userName?: string;
  /** Current user's avatar JSON config, broadcast to peers (null = derived from the name). */
  avatar?: string | null;
  presence?: PresentUser[];
  doc?: Y.Doc | null;
  awareness?: Awareness | null;
  /** "Linked database" mode: ids of hidden views SPECIFIC to this block (not the schema). */
  hiddenViews?: string[];
  /** Linked mode: hide/re-show a view locally (instead of deleting it). */
  onSetHiddenViews?: (ids: string[]) => void;
  /** Linked mode: sort/filters SPECIFIC to this block, per view (don't affect the schema). */
  viewState?: Record<string, { sort?: SortState | null; filters?: FilterState[] }>;
  onSetViewState?: (next: Record<string, { sort?: SortState | null; filters?: FilterState[] }>) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  useBroadcastPointer(awareness, rootRef, !!awareness);
  const [schema, setSchema] = useState<DbSchema>(() => parseSchema(schemaJson));
  const [rows, setRows] = useState<Row[]>([]);
  const [colDialog, setColDialog] = useState<DbColumn | "new" | null>(null);
  // Insertion index of a new column (null = append at the end).
  const [newColAt, setNewColAt] = useState<number | null>(null);
  const [sort, setSort] = useState<SortState | null>(null);
  const [filters, setFilters] = useState<FilterState[]>([]);
  const [search, setSearch] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  // Active view restored from the URL (?view=) on refresh; falls back to the
  // first view if the parameter is absent or unknown.
  const [activeViewId, setActiveViewId] = useState<string>(() => {
    const views = parseSchema(schemaJson).views;
    const fromUrl = searchParams.get("view");
    return (fromUrl && views.some((v) => v.id === fromUrl) ? fromUrl : views[0]?.id) ?? "";
  });
  /** Changes the active view and reflects it in the URL (without polluting history). */
  const selectView = (id: string) => {
    setActiveViewId(id);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("view", id);
        else next.delete("view");
        return next;
      },
      { replace: true },
    );
  };
  const [addViewOpen, setAddViewOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);
  const [confirmDeleteCol, setConfirmDeleteCol] = useState<DbColumn | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  // Template awaiting a "default" scope choice (all views / this view).
  const [defaultScopeFor, setDefaultScopeFor] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [peekRow, setPeekRow] = useState<string | null>(null);
  const [peekMeta, setPeekMeta] = useState<ItemMeta | null>(null);
  const [renamingView, setRenamingView] = useState<{ id: string; name: string } | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overRow, setOverRow] = useState<string | null>(null);

  // Schema mirror to read the latest value in the resize listeners
  // (stale closure otherwise).
  const schemaRef = useRef(schema);
  useEffect(() => {
    schemaRef.current = schema;
  });

  // Sort/filters persisted PER VIEW. In a linked database (onSetViewState
  // provided): in the block, specific to this embed. Otherwise: in the db
  // schema. Loaded on view change, rewritten debounced; the local state keeps
  // the input reactive and survives reload / template instantiation.
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  useEffect(() => {
    const stored = onSetViewState
      ? viewStateRef.current?.[activeViewId]
      : schemaRef.current.views.find((x) => x.id === activeViewId);
    setSort(stored?.sort ?? null);
    setFilters(stored?.filters ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewId]);
  const fsTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const stored = onSetViewState
      ? viewStateRef.current?.[activeViewId]
      : schemaRef.current.views.find((x) => x.id === activeViewId);
    const same =
      JSON.stringify(stored?.sort ?? null) === JSON.stringify(sort) &&
      JSON.stringify(stored?.filters ?? []) === JSON.stringify(filters);
    if (same) return;
    clearTimeout(fsTimer.current);
    fsTimer.current = window.setTimeout(() => {
      const entry = { sort: sort ?? undefined, filters: filters.length ? filters : undefined };
      if (onSetViewState) {
        onSetViewState({ ...(viewStateRef.current ?? {}), [activeViewId]: entry });
      } else {
        void persistSchema({
          ...schemaRef.current,
          views: schemaRef.current.views.map((x) => (x.id === activeViewId ? { ...x, ...entry } : x)),
        });
      }
    }, 400);
    return () => clearTimeout(fsTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sort, activeViewId]);

  // Available height measured for the table view → the table scrolls internally
  // (sticky header), the page doesn't overflow when there are many rows.
  const viewScrollRef = useRef<HTMLDivElement>(null);
  const [viewMaxH, setViewMaxH] = useState<number | undefined>(undefined);
  useEffect(() => {
    const update = () => {
      const el = viewScrollRef.current;
      if (!el) return;
      const h = Math.max(240, window.innerHeight - el.getBoundingClientRect().top - 40);
      // Anti-loop guard: only re-render on a real delta (the ResizeObserver
      // below would otherwise re-fire on every height adjustment).
      setViewMaxH((prev) => (prev === undefined || Math.abs(prev - h) > 1 ? h : prev));
    };
    update();
    // The top of the table moves when the cover (async image) or the icon
    // are added/loaded: we react to any change in the document size, not just
    // the window resize → the table scrolls internally, the page never
    // overflows on y.
    const ro = new ResizeObserver(update);
    ro.observe(document.body);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [activeViewId]);

  // Locally hidden views (linked database): filtered from the tabs, never from the schema.
  const localHidden = hiddenViews ?? [];
  const visibleViews = schema.views.filter((v) => !localHidden.includes(v.id));
  const activeView = schema.views.find((v) => v.id === activeViewId) ?? visibleViews[0] ?? schema.views[0];

  /** Hides a view in this block (linked database), without removing it from the schema. */
  function hideView(id: string) {
    if (!onSetHiddenViews) return;
    onSetHiddenViews([...localHidden, id]);
    if (activeViewId === id) selectView(visibleViews.find((v) => v.id !== id)?.id ?? "");
  }
  function restoreView(id: string) {
    onSetHiddenViews?.(localHidden.filter((x) => x !== id));
  }
  // Columns displayed in the active view (hidden ones keep their values).
  const hiddenCols = activeView?.hidden ?? [];
  const visibleColumns = schema.columns.filter((c) => !hiddenCols.includes(c.id));

  const keys = useMemo(
    () => [{ key: TITLE_KEY, name: t("dbview.view.name") }, ...schema.columns.map((c) => ({ key: c.id, name: c.name }))],
    [schema.columns],
  );
  const keyName = (key: string) => keys.find((k) => k.key === key)?.name ?? key;
  // Template rows (hidden child items) are excluded from all views.
  const templateIds = useMemo(() => new Set(schema.templates ?? []), [schema.templates]);
  // Templates' metadata (title/icon), read live (getItem, not cached)
  // → the menu reflects template renames.
  const [tplMetas, setTplMetas] = useState<Map<string, ItemMeta>>(new Map());
  const tplKey = (schema.templates ?? []).join(",");
  useEffect(() => {
    const ids = schema.templates ?? [];
    if (ids.length === 0) {
      setTplMetas(new Map());
      return;
    }
    let alive = true;
    Promise.all(ids.map((id) => getItem(id).then((m) => [id, m] as const).catch(() => null))).then((pairs) => {
      if (alive) setTplMetas(new Map(pairs.filter((p): p is readonly [string, ItemMeta] => p != null)));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tplKey]);
  const orderedRows = useMemo(
    () => orderRows(rows.filter((r) => !templateIds.has(r.id)), schema.rowOrder),
    [rows, schema.rowOrder, templateIds],
  );
  // Quick search (all views, client-side, ephemeral): title + all columns
  // via cellText (text/number/select/multi/status/date/checkbox/phone/
  // email/url/files). Relation excluded: stores ids, not titles.
  const searchKeys = useMemo(
    () => [TITLE_KEY, ...schema.columns.filter((c) => c.type !== "relation").map((c) => c.id)],
    [schema.columns],
  );
  const searchedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orderedRows;
    return orderedRows.filter((r) => searchKeys.some((k) => cellText(r, k).toLowerCase().includes(q)));
  }, [orderedRows, search, searchKeys]);
  const view = useMemo(
    () => applyView(searchedRows, filters, sort, schema.columns),
    [searchedRows, filters, sort, schema.columns],
  );

  // Chart data: generic pivot engine (X axis, series, aggregate,
  // transformation, sort) driven by the view's parameters.
  // Computed columns' values (formula / rollup) per row: precomputed
  // (async prefetch of linked pages) then injected into props on the read side
  // (charts, aggregates). Empty if there is no computed column.
  const [derived, setDerived] = useState<Map<string, PropValues>>(new Map());
  useEffect(() => {
    const computed = schema.columns.filter((c) => c.type === "formula" || c.type === "rollup");
    if (computed.length === 0) {
      setDerived(new Map());
      return;
    }
    let alive = true;
    void (async () => {
      // All linked pages (relations) → titles + properties (for rollup).
      const ids = new Set<string>();
      for (const r of rows)
        for (const c of schema.columns)
          if (c.type === "relation" && Array.isArray(r.props[c.id]))
            (r.props[c.id] as string[]).forEach((x) => ids.add(String(x)));
      const items = new Map<string, ItemMeta>();
      await Promise.all(
        [...ids].map((id) =>
          getItemCached(id)
            .then((it) => items.set(id, it))
            .catch(() => {}),
        ),
      );
      const titles = new Map([...items].map(([id, it]) => [id, it.title ?? ""] as const));
      const out = new Map<string, PropValues>();
      for (const r of rows) {
        const rec: PropValues = {};
        for (const c of computed) {
          if (c.type === "formula") {
            try {
              rec[c.id] = evalFormula(parseFormula(c.formula ?? ""), {
                resolve: (n) => colValue(n, schema.columns, r.props, new Set([c.id]), titles),
              });
            } catch {
              rec[c.id] = null;
            }
          } else {
            rec[c.id] = computeRollupValue(c, r.props, items);
          }
        }
        out.set(r.id, rec);
      }
      if (alive) setDerived(out);
    })();
    return () => {
      alive = false;
    };
  }, [rows, schema.columns]);

  const chartData = useMemo(() => {
    if (activeView?.type !== "chart" || !activeView.groupBy) return null;
    // Inject the computed values into the props so the chart reads them.
    const chartRows = searchedRows.map((r) => {
      const d = derived.get(r.id);
      return d ? { ...r, props: { ...r.props, ...d } } : r;
    });
    return buildChart(chartRows, activeView, schema.columns, cellText);
  }, [activeView, searchedRows, schema.columns, derived]);

  useEffect(() => setSchema(parseSchema(schemaJson)), [schemaJson]);

  // Presence on the db: identity + active view in the awareness, then sync
  // connection (the db has no editor to do it). Identity set here (and not
  // in Page) to include `view` without a parent/child ordering overwrite.
  useEffect(() => {
    if (!doc || !awareness) return;
    awareness.setLocalState({
      user: { name: userName, color: colorFromName(userName) },
      avatar,
      view: activeViewId,
    });
    return connectSync(doc, awareness, dbId, {});
    // activeViewId intentionally out of deps: the view is updated by the next
    // effect, without reconnecting the socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, awareness, dbId, userName, avatar]);

  useEffect(() => {
    awareness?.setLocalStateField("view", activeViewId);
  }, [awareness, activeViewId]);

  // Live sync of the CONTENT (rows/schema in SQL, outside the CRDT): a `rev`
  // counter in the db's Yjs doc is incremented on every mutation → the other
  // clients (remote rev) reload rows + schema. The signal travels through the
  // relayed/persisted doc, without moving the data into the CRDT.
  const bumpRev = () => {
    if (!doc) return;
    const m = doc.getMap("dbmeta");
    doc.transact(() => m.set("rev", (((m.get("rev") as number) ?? 0) + 1)), "local-bump");
  };

  useEffect(() => {
    if (!doc) return;
    const m = doc.getMap("dbmeta");
    const onChange = (_e: unknown, tx: { origin: unknown }) => {
      if (tx.origin === "local-bump") return; // our own edit
      Promise.all([listRows(dbId), getItem(dbId)])
        .then(([rs, item]) => {
          setRows(rs.map(toRow));
          setSchema(parseSchema(item.db_schema));
        })
        .catch(() => {});
    };
    m.observe(onChange);
    return () => m.unobserve(onChange);
  }, [doc, dbId]);

  useEffect(() => {
    let alive = true;
    listRows(dbId)
      .then((rs) => alive && setRows(rs.map(toRow)))
      .catch(() => {
        if (alive) {
          setRows([]);
          toast.error(t("dbview.toast.loadRowsFailed"));
        }
      });
    return () => {
      alive = false;
    };
  }, [dbId]);

  // Full meta of the previewed row (for the drawer's icon / cover).
  useEffect(() => {
    if (!peekRow) {
      setPeekMeta(null);
      return;
    }
    let alive = true;
    getItem(peekRow)
      .then((m) => alive && setPeekMeta(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [peekRow]);

  /** Changes a row's icon (from the view). */
  async function setRowIcon(rowId: string, icon: string) {
    setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, icon } : r)));
    try {
      await patchItem(rowId, { icon });
      bumpRev();
    } catch {
      toast.error(t("dbview.toast.iconFailed"));
    }
  }

  /** Applies a meta patch (title/icon/cover) to the previewed row. */
  async function patchPeek(patch: MetaPatch) {
    if (!peekRow) return;
    try {
      const updated = await patchItem(peekRow, patch);
      setPeekMeta(updated);
      setRows((rs) =>
        rs.map((r) =>
          r.id === peekRow ? { ...r, title: updated.title, icon: updated.icon, cover: updated.cover } : r,
        ),
      );
      bumpRev();
    } catch {
      toast.error(t("dbview.toast.updateFailed"));
    }
  }

  async function persistSchema(next: DbSchema) {
    setSchema(next);
    try {
      await updateSchema(dbId, JSON.stringify(next));
      bumpRev();
    } catch {
      toast.error(t("dbview.toast.schemaSaveFailed"));
    }
  }

  async function upsertColumn(col: DbColumn) {
    const exists = schema.columns.some((c) => c.id === col.id);
    const columns = exists
      ? schema.columns.map((c) => (c.id === col.id ? col : c))
      : [...schema.columns, col];
    const next = { ...schema, columns };
    await persistSchema(next);
    await ensureReciprocal(col, next);
  }

  async function deleteColumn(id: string) {
    await persistSchema({ ...schema, columns: schema.columns.filter((c) => c.id !== id) });
  }

  /** Inserts a column at `index` (clamped). `null` → append at the end. */
  async function insertColumn(col: DbColumn, index: number | null) {
    const cols = [...schema.columns];
    cols.splice(index ?? cols.length, 0, col);
    const next = { ...schema, columns: cols };
    await persistSchema(next);
    await ensureReciprocal(col, next);
  }

  /** Creates (if needed) the mirror column in the target database of a
   * bidirectional relation, and links the two columns by their reciprocal id.
   * `base` = up-to-date source schema (already includes `col`) to avoid any overwrite. */
  async function ensureReciprocal(col: DbColumn, base: DbSchema) {
    if (col.type !== "relation" || !col.relationBidirectional || !col.relationDb) return;
    try {
      const target = await getItem(col.relationDb);
      const tSchema = parseSchema(target.db_schema);
      const already = col.relationReciprocal && tSchema.columns.some((c) => c.id === col.relationReciprocal);
      if (already) return;
      const self = await getItem(dbId);
      const recId = newColumnId();
      const recCol: DbColumn = {
        id: recId,
        name: self.title || "Relation",
        type: "relation",
        relationDb: dbId,
        relationBidirectional: true,
        relationReciprocal: col.id,
      };
      await updateSchema(col.relationDb, JSON.stringify({ ...tSchema, columns: [...tSchema.columns, recCol] }));
      // Links our column (already present in `base`) to the created reciprocal.
      await persistSchema({
        ...base,
        columns: base.columns.map((c) => (c.id === col.id ? { ...c, relationReciprocal: recId } : c)),
      });
    } catch {
      toast.error(t("dbview.toast.reciprocalCreateFailed"));
    }
  }

  /** Propagates a bidirectional relation change to the linked rows. */
  async function syncReciprocal(rowId: string, col: DbColumn, oldIds: string[], newIds: string[]) {
    const recId = col.relationReciprocal;
    if (!recId) return;
    const added = newIds.filter((x) => !oldIds.includes(x));
    const removed = oldIds.filter((x) => !newIds.includes(x));
    for (const t of [...added, ...removed]) {
      try {
        const isAdd = added.includes(t);
        const item = await getItem(t);
        const props = parseProps(item.properties);
        const cur = Array.isArray(props[recId]) ? (props[recId] as string[]) : [];
        const has = cur.includes(rowId);
        if (isAdd === has) continue; // already in the desired state
        const next = isAdd ? [...cur, rowId] : cur.filter((x) => x !== rowId);
        await updateProperties(t, JSON.stringify({ ...props, [recId]: next }));
      } catch {
        toast.error(i18n.t("dbview.toast.reciprocalSyncFailed"));
      }
    }
  }

  /** Opens the "new column" dialog targeting an insertion position. */
  function openNewColumn(at: number | null) {
    setNewColAt(at);
    setColDialog("new");
  }

  /** Sets the grouping column of the active view (undefined = none). */
  function setGroupBy(colId: string | undefined) {
    if (!activeView) return;
    void persistSchema({
      ...schema,
      views: schema.views.map((v) => (v.id === activeView.id ? { ...v, groupBy: colId } : v)),
    });
  }

  /** Sets the display mode of a calendar view (persisted). */
  function setCalMode(m: CalMode) {
    if (!activeView) return;
    void persistSchema({
      ...schema,
      views: schema.views.map((v) => (v.id === activeView.id ? { ...v, calMode: m } : v)),
    });
  }

  /** Applies a grid view parameter (size or image source). */
  function setGridParam(patch: Pick<DbView, "gridSize" | "gridImage">) {
    if (!activeView) return;
    void persistSchema({
      ...schema,
      views: schema.views.map((v) => (v.id === activeView.id ? { ...v, ...patch } : v)),
    });
  }

  /** URL of a row's image according to the source configured by the grid view. */
  const gridImageUrl = (r: Row): string | null => {
    const src = activeView?.gridImage ?? "cover";
    if (src === "none") return null;
    if (src === "cover") return r.cover ? fileUrl(r.cover) : null;
    const hash = fileImageHash(r.props[src]);
    return hash ? fileUrl(hash) : null;
  };

  /** Applies one or more chart view parameters. */
  function setChartParam(
    patch: Pick<
      DbView,
      | "chartKind"
      | "chartAgg"
      | "chartValueCol"
      | "groupBy"
      | "chartSeries"
      | "chartBucket"
      | "chartTransform"
      | "chartSort"
      | "chartStacked"
      | "chartDoneCol"
      | "chartIdeal"
    >,
  ) {
    if (!activeView) return;
    void persistSchema({
      ...schema,
      views: schema.views.map((v) => (v.id === activeView.id ? { ...v, ...patch } : v)),
    });
  }

  /** Hides / shows a column in the active view (value preserved). */
  function toggleColumnHidden(colId: string) {
    if (!activeView) return;
    const hidden = new Set(activeView.hidden ?? []);
    if (hidden.has(colId)) hidden.delete(colId);
    else hidden.add(colId);
    void persistSchema({
      ...schema,
      views: schema.views.map((v) => (v.id === activeView.id ? { ...v, hidden: [...hidden] } : v)),
    });
  }

  /** Sets / removes a column's footer aggregate (persisted in the schema). */
  async function setCalc(key: string, agg: string) {
    const calc = { ...(schema.calc ?? {}) };
    if (agg) calc[key] = agg;
    else delete calc[key];
    await persistSchema({ ...schema, calc });
  }

  /** Reorders rows: places `fromId` at `toId`'s position. Persists the full
   * order in `db_schema.rowOrder` (shared by all views). */
  function reorderRow(fromId: string, toId: string) {
    if (fromId === toId) return;
    const ids = orderRows(rows, schema.rowOrder).map((r) => r.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    void persistSchema({ ...schema, rowOrder: ids });
  }

  /** Reorders columns: inserts `fromId` at `toId`'s position. */
  function moveColumn(fromId: string, toId: string) {
    if (fromId === toId) return;
    const cols = [...schema.columns];
    const from = cols.findIndex((c) => c.id === fromId);
    const to = cols.findIndex((c) => c.id === toId);
    if (from < 0 || to < 0) return;
    const [moved] = cols.splice(from, 1);
    cols.splice(to, 0, moved);
    void persistSchema({ ...schema, columns: cols });
  }

  /** Resizes a column: live update during the drag, persisted on release. */
  function startResize(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.target as HTMLElement).closest("th");
    const startW = th?.offsetWidth ?? 160;
    const startX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      const width = Math.max(80, Math.round(startW + (ev.clientX - startX)));
      setSchema((s) => ({ ...s, columns: s.columns.map((c) => (c.id === id ? { ...c, width } : c)) }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      void persistSchema(schemaRef.current);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  async function addView(v: DbView) {
    await persistSchema({ ...schema, views: [...schema.views, v] });
    selectView(v.id);
  }

  async function deleteView(id: string) {
    const views = schema.views.filter((v) => v.id !== id);
    await persistSchema({ ...schema, views });
    selectView(views[0]?.id ?? "");
  }

  /** Reorders views: places `fromId` at `toId`'s position. */
  function moveView(fromId: string, toId: string) {
    if (fromId === toId) return;
    const views = [...schema.views];
    const fi = views.findIndex((v) => v.id === fromId);
    const ti = views.findIndex((v) => v.id === toId);
    if (fi < 0 || ti < 0) return;
    const [m] = views.splice(fi, 1);
    views.splice(ti, 0, m);
    void persistSchema({ ...schema, views });
  }

  async function renameView(id: string, name: string) {
    const trimmed = name.trim();
    setRenamingView(null);
    const view = schema.views.find((v) => v.id === id);
    if (!trimmed || !view || trimmed === view.name) return;
    await persistSchema({
      ...schema,
      views: schema.views.map((v) => (v.id === id ? { ...v, name: trimmed } : v)),
    });
  }

  async function addRow(preset?: PropValues, atTop = false) {
    try {
      const id = await createItem(dbId);
      // Status columns get their default value (never empty).
      const statusDefaults: PropValues = {};
      for (const c of schema.columns) {
        if (c.type === "status" && c.defaultOption) statusDefaults[c.id] = c.defaultOption;
      }
      const props = { ...statusDefaults, ...preset };
      if (Object.keys(props).length > 0) await updateProperties(id, JSON.stringify(props));
      const fresh = (await listRows(dbId)).map(toRow);
      setRows(fresh);
      if (atTop) {
        // Places the new row at the head of the shared order.
        const ids = orderRows(fresh, schema.rowOrder)
          .map((r) => r.id)
          .filter((x) => x !== id);
        await persistSchema({ ...schema, rowOrder: [id, ...ids] });
      }
      bumpRev();
    } catch {
      toast.error(t("dbview.toast.rowCreateFailed"));
    }
  }

  /** Creates a row by instantiating a template (duplication without suffix), placed
   * at the head. `preset` overrides properties (kanban column, date…). */
  async function applyTemplate(templateId: string, preset?: PropValues) {
    try {
      const id = await duplicateItem(templateId, { bare: true });
      let fresh = (await listRows(dbId)).map(toRow);
      const row = fresh.find((r) => r.id === id);
      // Resolution of dynamic variables (title + text props + dates).
      const ctx: TokenCtx = {
        now: new Date(),
        seq: fresh.filter((r) => !templateIds.has(r.id) && r.id !== id).length + 1,
        user: userName,
      };
      // Props: dates → today if token, otherwise substitution in the texts.
      const resolvedProps: PropValues = {};
      for (const [k, v] of Object.entries(row?.props ?? {})) {
        const col = schema.columns.find((c) => c.id === k);
        if (typeof v === "string") {
          if (col?.type === "date" && DATE_TOKEN_RE.test(v)) resolvedProps[k] = isoDay(ctx.now);
          else resolvedProps[k] = resolveTokens(v, ctx);
        } else resolvedProps[k] = v;
      }
      const merged = { ...resolvedProps, ...preset };
      await updateProperties(id, JSON.stringify(merged));
      // Title: token substitution.
      const newTitle = resolveTokens(row?.title ?? "", ctx);
      if (newTitle !== (row?.title ?? "")) await patchItem(id, { title: newTitle });
      fresh = fresh.map((r) => (r.id === id ? { ...r, props: merged, title: newTitle } : r));
      setRows(fresh);
      const ids = orderRows(fresh, schema.rowOrder)
        .map((r) => r.id)
        .filter((x) => x !== id);
      await persistSchema({ ...schema, rowOrder: [id, ...ids] });
      bumpRev();
    } catch {
      toast.error(t("dbview.toast.templateCreateFailed"));
    }
  }

  /** Effective default template for the active view (view override, else db). */
  const effectiveDefaultTemplate =
    activeView?.defaultTemplate ?? schema.defaultTemplate;

  /** Creates a row: from the effective default template (with `preset` as an
   * override) if it exists, otherwise an empty row (+ Status defaults). Used by
   * all add entry points (toolbar, kanban, calendar, grid). */
  function createRow(preset?: PropValues) {
    if (effectiveDefaultTemplate && (schema.templates ?? []).includes(effectiveDefaultTemplate)) {
      void applyTemplate(effectiveDefaultTemplate, preset);
    } else {
      void addRow(preset, true);
    }
  }

  /** Creates a template (hidden child item) and opens its page to edit it. */
  async function createTemplate() {
    try {
      const id = await createItem(dbId);
      // Status columns defaults (never empty), like a normal row.
      const statusDefaults: PropValues = {};
      for (const c of schema.columns) {
        if (c.type === "status" && c.defaultOption) statusDefaults[c.id] = c.defaultOption;
      }
      if (Object.keys(statusDefaults).length > 0) await updateProperties(id, JSON.stringify(statusDefaults));
      await persistSchema({ ...schema, templates: [...(schema.templates ?? []), id] });
      navigate(`/p/${id}`);
    } catch {
      toast.error(t("dbview.toast.templateSaveFailed"));
    }
  }

  /** Sets the default template, at the db scale or the active view scale. */
  function setDefaultTemplate(id: string, scope: "all" | "view") {
    if (scope === "all") {
      void persistSchema({ ...schema, defaultTemplate: id });
    } else if (activeView) {
      void persistSchema({
        ...schema,
        views: schema.views.map((v) => (v.id === activeView.id ? { ...v, defaultTemplate: id } : v)),
      });
    }
  }

  /** Removes this template from the defaults (db + active view). */
  function clearDefaultTemplate(id: string) {
    void persistSchema({
      ...schema,
      defaultTemplate: schema.defaultTemplate === id ? undefined : schema.defaultTemplate,
      views: schema.views.map((v) => (v.defaultTemplate === id ? { ...v, defaultTemplate: undefined } : v)),
    });
  }

  /** Duplicates a template (stays a template). */
  async function duplicateTemplate(id: string) {
    try {
      const copy = await duplicateItem(id);
      await persistSchema({ ...schema, templates: [...(schema.templates ?? []), copy] });
    } catch {
      toast.error(t("dbview.toast.templateDuplicateFailed"));
    }
  }

  async function deleteTemplate(id: string) {
    const templates = (schema.templates ?? []).filter((t) => t !== id);
    const defaultTemplate = schema.defaultTemplate === id ? undefined : schema.defaultTemplate;
    const views = schema.views.map((v) => (v.defaultTemplate === id ? { ...v, defaultTemplate: undefined } : v));
    await persistSchema({ ...schema, templates, defaultTemplate, views });
    try {
      await deleteItem(id);
    } catch {
      /* the template item may already be deleted */
    }
  }

  async function deleteRow(rowId: string) {
    try {
      await deleteItem(rowId);
      setRows((rs) => rs.filter((r) => r.id !== rowId));
      bumpRev();
    } catch (e) {
      toast.error(
        e instanceof ApiError && e.status === 403
          ? t("dbview.toast.rowDeleteForbidden")
          : t("dbview.toast.rowDeleteFailed"),
      );
    }
  }

  /** Deletes the selected rows (best-effort; keeps the ones that failed). */
  async function bulkDelete() {
    const ids = [...selected];
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          await deleteItem(id);
          return id;
        } catch {
          return null;
        }
      }),
    );
    const ok = new Set(results.filter((x): x is string => x !== null));
    setRows((rs) => rs.filter((r) => !ok.has(r.id)));
    setSelected(new Set());
    if (ok.size > 0) bumpRev();
    const failed = ids.length - ok.size;
    if (failed > 0) toast.error(t("dbview.toast.rowsDeleteFailed", { count: failed }));
  }

  async function bulkDuplicate() {
    const ids = [...selected];
    try {
      for (const id of ids) await duplicateItem(id);
      const fresh = (await listRows(dbId)).map(toRow);
      setRows(fresh);
      setSelected(new Set());
      bumpRev();
    } catch {
      toast.error(t("dbview.toast.duplicateFailed"));
    }
  }

  function toggleRow(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function setTitle(rowId: string, title: string) {
    setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, title } : r)));
    try {
      await patchItem(rowId, { title });
      bumpRev();
    } catch {
      toast.error(t("dbview.toast.rowRenameFailed"));
    }
  }

  async function setCell(rowId: string, colId: string, value: unknown) {
    setRows((rs) =>
      rs.map((r) => (r.id === rowId ? { ...r, props: { ...r.props, [colId]: value } } : r)),
    );
    const row = rows.find((r) => r.id === rowId);
    const oldVal = row?.props[colId];
    const next = { ...(row?.props ?? {}), [colId]: value };
    try {
      await updateProperties(rowId, JSON.stringify(next));
      bumpRev();
    } catch {
      toast.error(t("dbview.toast.cellUpdateFailed"));
      return;
    }
    const col = schema.columns.find((c) => c.id === colId);
    if (col?.type === "relation" && col.relationBidirectional && col.relationReciprocal) {
      const asIds = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
      void syncReciprocal(rowId, col, asIds(oldVal), asIds(value));
    }
  }

  const groupCol = schema.columns.find((c) => c.id === activeView?.groupBy);

  // Grouping of the TABLE view: rows grouped by the value of `groupCol`.
  const tableGroups = useMemo(() => {
    if (activeView?.type !== "table" || !groupCol) return null;
    const map = new Map<string, Row[]>();
    for (const r of view) {
      const key = cellText(r, groupCol.id);
      const arr = map.get(key);
      if (arr) arr.push(r);
      else map.set(key, [r]);
    }
    // Order: select/status options first, then others, "no value" at the end.
    const ordered: { key: string; label: string; rows: Row[] }[] = [];
    const seen = new Set<string>();
    for (const opt of groupCol.options ?? []) {
      if (map.has(opt)) {
        ordered.push({ key: opt, label: opt, rows: map.get(opt)! });
        seen.add(opt);
      }
    }
    for (const [key, rowsIn] of map) {
      if (key === "" || seen.has(key)) continue;
      ordered.push({ key, label: key, rows: rowsIn });
    }
    if (map.has("")) ordered.push({ key: "", label: "No value", rows: map.get("")! });
    return ordered;
  }, [activeView?.type, groupCol, view]);

  const colCount = visibleColumns.length + 1 + (canDelete ? 1 : 0) + (canCreate || canDelete ? 1 : 0);

  const toggleGroup = (key: string) =>
    setCollapsedGroups((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderRow = (r: Row) => (
    <tr
      key={r.id}
      onDragOver={dragRow ? (e) => { e.preventDefault(); setOverRow(r.id); } : undefined}
      onDragLeave={() => setOverRow((o) => (o === r.id ? null : o))}
      onDrop={
        dragRow
          ? (e) => {
              e.preventDefault();
              const from = e.dataTransfer.getData("text/plain");
              if (from) reorderRow(from, r.id);
              setDragRow(null);
              setOverRow(null);
            }
          : undefined
      }
      className={cn(
        "group border-b last:border-0 hover:bg-muted/20",
        overRow === r.id && dragRow !== r.id && "border-t-2 border-t-primary",
        dragRow === r.id && "opacity-50",
        selected.has(r.id) && "bg-primary/5",
      )}
    >
      {(canDelete || canCreate) && (
        <td className="px-2 py-1.5 align-middle">
          <Checkbox
            aria-label={t("dbview.view.selectRow")}
            checked={selected.has(r.id)}
            onCheckedChange={() => toggleRow(r.id)}
            className="opacity-0 transition-opacity group-hover:opacity-100 data-[state=checked]:opacity-100"
          />
        </td>
      )}
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          {canCreate && !sort && (
            <span
              aria-label={t("dbview.view.reorderRow")}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", r.id);
                setDragRow(r.id);
              }}
              onDragEnd={() => {
                setDragRow(null);
                setOverRow(null);
              }}
              className="-ml-1 shrink-0 cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover:opacity-40 hover:opacity-100 active:cursor-grabbing"
            >
              <GripVertical className="size-3.5" />
            </span>
          )}
          <IconEditor
            icon={r.icon}
            size={16}
            className="shrink-0"
            canEdit={canEdit}
            onChange={(v) => void setRowIcon(r.id, v)}
          />
          {canEdit ? (
            <LiveInput
              value={r.title ?? ""}
              placeholder={t("common.untitled")}
              className="min-w-0 flex-1 bg-transparent font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground/50"
              onCommit={(nv) => {
                if (nv !== (r.title ?? "")) void setTitle(r.id, nv);
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate font-medium">{r.title || "Untitled"}</span>
          )}
          {presence.some((u) => !u.isSelf && u.location === r.id) && (
            <PresenceAvatars users={presence.filter((u) => !u.isSelf && u.location === r.id)} />
          )}
          <button
            aria-label={t("dbview.view.open")}
            className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-60 hover:opacity-100"
            onClick={() => setPeekRow(r.id)}
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      </td>
      {visibleColumns.map((c) => (
        <td key={c.id} className="px-2 py-1">
          {META_TYPES.has(c.type) ? (
            <MetaCell type={c.type} row={r} />
          ) : (
            <Cell
              col={c}
              value={r.props[c.id]}
              canEdit={canEdit}
              rowProps={r.props}
              columns={schema.columns}
              onChange={(v) => void setCell(r.id, c.id, v)}
            />
          )}
        </td>
      ))}
      {(canCreate || canDelete) && (
        <td className="px-1 py-1 text-right">
          {canDelete && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("dbview.act.rowActions")}
                  className="opacity-40 hover:opacity-100"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(r)}>
                  <Trash2 className="size-3.5" /> {t("dbview.act.deleteRow")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </td>
      )}
    </tr>
  );

  // Column edit/delete dialogs, rendered either at the top level, or in the
  // drawer (see below) to avoid closing the dialog also closing the Sheet.
  // Only one location is active at a time (depending on `peekRow`).
  const colDialogsNode = (
    <>
      {colDialog && (
        <ColumnDialog
          column={colDialog === "new" ? null : colDialog}
          columns={schema.columns}
          onClose={() => {
            setColDialog(null);
            setNewColAt(null);
          }}
          onSave={(c) => {
            if (colDialog === "new") void insertColumn(c, newColAt);
            else void upsertColumn(c);
            setColDialog(null);
            setNewColAt(null);
          }}
          onDelete={
            colDialog === "new"
              ? undefined
              : () => {
                  const c = colDialog;
                  setColDialog(null);
                  setConfirmDeleteCol(c);
                }
          }
        />
      )}
      <AlertDialog open={confirmDeleteCol !== null} onOpenChange={(o) => !o && setConfirmDeleteCol(null)}>
        <AlertDialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dbview.dialog.deleteColTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dbview.dialog.deleteColDesc", { name: confirmDeleteCol?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dbview.dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDeleteCol) void deleteColumn(confirmDeleteCol.id);
                setConfirmDeleteCol(null);
              }}
            >
              {t("dbview.dialog.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return (
    <div ref={rootRef} className="relative mx-auto w-full min-w-0 max-w-7xl px-4 py-6">
      <PresenceCursors awareness={awareness} match={(u) => !u.location && u.view === activeViewId} />
      {/* View selector */}
      <div className="mb-3 flex flex-wrap items-center gap-1 border-b">
        {visibleViews.map((v) => (
          <button
            key={v.id}
            draggable={canCreate}
            onDragStart={(e) => e.dataTransfer.setData("text/view", v.id)}
            onDragOver={canCreate ? (e) => e.preventDefault() : undefined}
            onDrop={
              canCreate
                ? (e) => {
                    e.preventDefault();
                    const from = e.dataTransfer.getData("text/view");
                    if (from) moveView(from, v.id);
                  }
                : undefined
            }
            onClick={() => selectView(v.id)}
            onDoubleClick={() => canCreate && setRenamingView({ id: v.id, name: v.name })}
            className={cn(
              "flex items-center gap-1 border-b-2 px-3 py-1.5 text-sm",
              canCreate && "cursor-grab active:cursor-grabbing",
              v.id === activeView?.id
                ? "border-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {renamingView?.id === v.id ? (
              <input
                autoFocus
                value={renamingView.name}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenamingView({ id: v.id, name: e.target.value })}
                onBlur={() => void renameView(v.id, renamingView.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void renameView(v.id, renamingView.name);
                  if (e.key === "Escape") setRenamingView(null);
                }}
                className="w-24 bg-transparent outline-none"
              />
            ) : (
              <span title={canCreate ? t("dbview.view.renameHint") : undefined}>{v.name}</span>
            )}
            {/* Linked mode: hide locally; otherwise: remove from the schema. */}
            {((onSetHiddenViews ? true : canCreate) &&
              visibleViews.length > 1 &&
              v.id === activeView?.id &&
              renamingView?.id !== v.id) && (
              <span
                role="button"
                aria-label={onSetHiddenViews ? t("dbview.view.hideViewHere") : t("dbview.view.deleteView")}
                title={onSetHiddenViews ? t("dbview.view.hideViewHint") : t("dbview.view.deleteView")}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onSetHiddenViews) hideView(v.id);
                  else void deleteView(v.id);
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </span>
            )}
          </button>
        ))}
        {canCreate && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => setAddViewOpen(true)}
          >
            <Plus className="size-3.5" /> {t("dbview.view.newView")}
          </Button>
        )}
        {onSetHiddenViews && localHidden.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground">
                <EyeOff className="size-3.5" /> {t("dbview.view.hiddenViews", { count: localHidden.length })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {localHidden.map((id) => {
                const v = schema.views.find((x) => x.id === id);
                if (!v) return null;
                return (
                  <DropdownMenuItem key={id} onSelect={() => restoreView(id)}>
                    <Eye className="size-3.5" /> {v.name}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="mb-1 ml-auto flex items-center gap-1">
          <div className="relative">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              placeholder={t("dbview.view.search")}
              className="h-7 w-32 pl-7 text-xs sm:w-44"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {canCreate &&
            (schema.columns.length > 0 ||
              activeView?.type === "calendar" ||
              activeView?.type === "grid" ||
              activeView?.type === "chart") && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                  <Settings2 className="size-3.5" /> <span className="max-sm:hidden">{t("dbview.view.settings")}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {activeView?.type === "chart" && (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      {t("dbview.chart.type")}
                    </DropdownMenuLabel>
                    {(["bar", "line", "area", "pie", "radar", "radial"] as ChartKind[]).map((k) => (
                      <MenuRadio
                        key={k}
                        label={t(`dbview.chart.kind.${k}`)}
                        active={(activeView.chartKind ?? "bar") === k}
                        onPick={() => setChartParam({ chartKind: k })}
                      />
                    ))}
                    {activeView.chartKind === "bar" && activeView.chartSeries && (
                      <MenuRadio
                        label={t("dbview.chart.stack")}
                        active={!!activeView.chartStacked}
                        onPick={() => setChartParam({ chartStacked: !activeView.chartStacked })}
                      />
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">{t("dbview.chart.axisX")}</DropdownMenuLabel>
                    <MenuRadio
                      label={t("dbview.chart.byName")}
                      active={activeView.groupBy === TITLE_KEY}
                      onPick={() => setChartParam({ groupBy: TITLE_KEY })}
                    />
                    {schema.columns
                      .filter(
                        (c) =>
                          c.type === "select" ||
                          c.type === "status" ||
                          c.type === "date" ||
                          c.type === "text" ||
                          c.type === "created_time" ||
                          c.type === "last_edited_time" ||
                          c.type === "formula" ||
                          c.type === "rollup",
                      )
                      .map((c) => (
                        <MenuRadio
                          key={c.id}
                          label={c.name}
                          active={activeView.groupBy === c.id}
                          onPick={() => setChartParam({ groupBy: c.id })}
                        />
                      ))}
                    {CHART_TIME_TYPES.has(
                      schema.columns.find((c) => c.id === activeView.groupBy)?.type ?? "",
                    ) && (
                      <>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("dbview.chart.groupDates")}</DropdownMenuLabel>
                        {(["day", "week", "month"] as NonNullable<DbView["chartBucket"]>[]).map(
                          (b) => (
                            <MenuRadio
                              key={b}
                              label={t(`dbview.chart.bucket.${b}`)}
                              active={(activeView.chartBucket ?? "day") === b}
                              onPick={() => setChartParam({ chartBucket: b })}
                            />
                          ),
                        )}
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">{t("dbview.chart.splitSeries")}</DropdownMenuLabel>
                    <MenuRadio
                      label={t("dbview.chart.none")}
                      active={!activeView.chartSeries}
                      onPick={() => setChartParam({ chartSeries: undefined })}
                    />
                    {schema.columns
                      .filter((c) => c.type === "select" || c.type === "status" || c.type === "formula")
                      .map((c) => (
                        <MenuRadio
                          key={c.id}
                          label={c.name}
                          active={activeView.chartSeries === c.id}
                          onPick={() => setChartParam({ chartSeries: c.id })}
                        />
                      ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">{t("dbview.chart.calc")}</DropdownMenuLabel>
                    {(["count", "sum", "avg", "min", "max"] as NonNullable<DbView["chartAgg"]>[]).map(
                      (a) => (
                        <MenuRadio
                          key={a}
                          label={t(`dbview.chart.agg.${a}`)}
                          active={(activeView.chartAgg ?? "count") === a}
                          onPick={() => setChartParam({ chartAgg: a })}
                        />
                      ),
                    )}
                    {(activeView.chartAgg ?? "count") !== "count" && (
                      <>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("dbview.chart.colNumber")}</DropdownMenuLabel>
                        {schema.columns
                          .filter((c) => c.type === "number" || c.type === "formula" || c.type === "rollup")
                          .map((c) => (
                            <MenuRadio
                              key={c.id}
                              label={c.name}
                              active={activeView.chartValueCol === c.id}
                              onPick={() => setChartParam({ chartValueCol: c.id })}
                            />
                          ))}
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">{t("dbview.chart.transform")}</DropdownMenuLabel>
                    {(
                      ["none", "cumulative", "remaining", "burndown"] as NonNullable<
                        DbView["chartTransform"]
                      >[]
                    ).map((tr) => (
                      <MenuRadio
                        key={tr}
                        label={t(`dbview.chart.transformKind.${tr}`)}
                        active={(activeView.chartTransform ?? "none") === tr}
                        onPick={() => setChartParam({ chartTransform: tr })}
                      />
                    ))}
                    {activeView.chartTransform === "burndown" && (
                      <>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">
                          {t("dbview.chart.doneCol")}
                        </DropdownMenuLabel>
                        {schema.columns
                          .filter((c) => c.type === "status")
                          .map((c) => (
                            <MenuRadio
                              key={c.id}
                              label={c.name}
                              active={activeView.chartDoneCol === c.id}
                              onPick={() => setChartParam({ chartDoneCol: c.id })}
                            />
                          ))}
                        <MenuRadio
                          label={t("dbview.chart.ideal")}
                          active={!!activeView.chartIdeal}
                          onPick={() => setChartParam({ chartIdeal: !activeView.chartIdeal })}
                        />
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">{t("dbview.chart.sortX")}</DropdownMenuLabel>
                    <MenuRadio
                      label={t("dbview.chart.sortByAxis")}
                      active={(activeView.chartSort ?? "x") === "x"}
                      onPick={() => setChartParam({ chartSort: "x" })}
                    />
                    <MenuRadio
                      label={t("dbview.chart.sortByValue")}
                      active={activeView.chartSort === "value"}
                      onPick={() => setChartParam({ chartSort: "value" })}
                    />
                  </>
                )}
                {activeView?.type === "grid" && (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      {t("dbview.grid.size")}
                    </DropdownMenuLabel>
                    {(["s", "m", "l"] as GridSize[]).map((sz) => (
                      <DropdownMenuItem
                        key={sz}
                        onSelect={(e) => {
                          e.preventDefault();
                          setGridParam({ gridSize: sz });
                        }}
                      >
                        <span className="flex-1">{t(`dbview.grid.${sz}`)}</span>
                        {(activeView?.gridSize ?? "m") === sz && <Check className="size-3.5" />}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      {t("dbview.view.image")}
                    </DropdownMenuLabel>
                    {[
                      { id: "cover", name: t("dbview.view.imageCover") },
                      ...imageColumns(schema.columns).map((c) => ({ id: c.id, name: c.name })),
                      { id: "none", name: t("dbview.view.imageNone") },
                    ].map((opt) => (
                      <DropdownMenuItem
                        key={opt.id}
                        onSelect={(e) => {
                          e.preventDefault();
                          setGridParam({ gridImage: opt.id });
                        }}
                      >
                        <span className="flex-1 truncate">{opt.name}</span>
                        {(activeView?.gridImage ?? "cover") === opt.id && <Check className="size-3.5" />}
                      </DropdownMenuItem>
                    ))}
                    {schema.columns.length > 0 && <DropdownMenuSeparator />}
                  </>
                )}
                {activeView?.type === "calendar" && (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      {t("dbview.calMode.display")}
                    </DropdownMenuLabel>
                    {(["month", "week", "day"] as CalMode[]).map((m) => {
                      const active = (activeView?.calMode ?? "month") === m;
                      return (
                        <DropdownMenuItem
                          key={m}
                          onSelect={(e) => {
                            e.preventDefault();
                            setCalMode(m);
                          }}
                        >
                          <span className="flex-1">{t(`dbview.calMode.${m}`)}</span>
                          {active && <Check className="size-3.5" />}
                        </DropdownMenuItem>
                      );
                    })}
                    {schema.columns.length > 0 && <DropdownMenuSeparator />}
                  </>
                )}
                {schema.columns.length > 0 && activeView?.type !== "chart" && (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      {activeView?.type === "table" ? t("dbview.viewCols.table") : t("dbview.viewCols.card")}
                    </DropdownMenuLabel>
                    {schema.columns.map((c) => {
                      const shown = !hiddenCols.includes(c.id);
                      return (
                        <DropdownMenuItem
                          key={c.id}
                          onSelect={(e) => {
                            e.preventDefault();
                            toggleColumnHidden(c.id);
                          }}
                        >
                          {shown ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5 opacity-50" />}
                          <span className={cn("flex-1 truncate", !shown && "text-muted-foreground")}>
                            {c.name}
                          </span>
                        </DropdownMenuItem>
                      );
                    })}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canCreate && activeView?.type !== "chart" && (
            <div className="flex">
              <Button size="sm" className="h-7 gap-1 rounded-r-none text-xs" onClick={() => createRow()}>
                <Plus className="size-3.5" /> <span className="max-sm:hidden">{t("dbview.view.newRow")}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="h-7 rounded-l-none border-l border-primary-foreground/20 px-1">
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">{t("dbview.view.templates")}</DropdownMenuLabel>
                  {(schema.templates ?? []).map((tid) => {
                    const m = tplMetas.get(tid);
                    const isDefault = effectiveDefaultTemplate === tid;
                    const isViewDefault = activeView?.defaultTemplate === tid;
                    return (
                      <div key={tid} className="flex items-center gap-1 pr-1">
                        {/* Clicking the template = create a row from it. */}
                        <DropdownMenuItem className="flex-1" onSelect={() => void applyTemplate(tid)}>
                          <ItemIcon icon={m?.icon ?? null} size={16} className="shrink-0" />
                          <span className="flex-1 truncate">{m?.title || t("dbview.view.templateFallback")}</span>
                          {isDefault && (
                            <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                              {isViewDefault ? t("dbview.view.defaultView") : t("dbview.view.default")}
                            </span>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger className="[&>svg:last-child]:hidden rounded px-1 py-1">
                            <MoreHorizontal className="size-3.5" />
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuItem
                              onSelect={() => (isDefault ? clearDefaultTemplate(tid) : setDefaultScopeFor(tid))}
                            >
                              <Star className="size-3.5" />
                              {isDefault ? t("dbview.view.removeDefault") : t("dbview.view.useDefault")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => navigate(`/p/${tid}`)}>
                              <Pencil className="size-3.5" /> {t("dbview.header.edit")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void duplicateTemplate(tid)}>
                              <Copy className="size-3.5" /> {t("dbview.view.duplicate")}
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onSelect={() => void deleteTemplate(tid)}>
                              <Trash2 className="size-3.5" /> {t("dbview.header.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </div>
                    );
                  })}
                  <DropdownMenuItem onSelect={() => void addRow(undefined, true)}>
                    <FileText className="size-3.5" /> {t("dbview.view.emptyRow")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void createTemplate()}>
                    <Plus className="size-3.5" /> {t("dbview.view.newTemplate")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>

      {/* Board (kanban) view */}
      {activeView?.type === "board" &&
        (groupCol?.type === "select" || groupCol?.type === "status" ? (
          <BoardView
            rows={searchedRows}
            column={groupCol}
            cardColumns={visibleColumns.filter((c) => c.id !== groupCol.id && !META_TYPES.has(c.type))}
            columns={schema.columns}
            canEdit={canEdit}
            canCreate={canCreate}
            onOpenRow={(id) => setPeekRow(id)}
            onSetIcon={canEdit ? (id, icon) => void setRowIcon(id, icon) : undefined}
            onSetValue={(rowId, value) => void setCell(rowId, groupCol.id, value)}
            onAddRow={(value) => createRow(value ? { [groupCol.id]: value } : undefined)}
            onDeleteRow={canDelete ? (row) => setConfirmDelete(row) : undefined}
            onReorder={canCreate ? reorderRow : undefined}
            collapsed={activeView?.collapsed ?? []}
            onToggleFold={
              canCreate && activeView
                ? (opt) => {
                    const set = new Set(activeView.collapsed ?? []);
                    if (set.has(opt)) set.delete(opt);
                    else set.add(opt);
                    void persistSchema({
                      ...schema,
                      views: schema.views.map((v) =>
                        v.id === activeView.id ? { ...v, collapsed: [...set] } : v,
                      ),
                    });
                  }
                : undefined
            }
            onReorderColumn={
              canCreate
                ? (from, to) => {
                    const opts = [...(groupCol.options ?? [])];
                    const fi = opts.indexOf(from);
                    const ti = opts.indexOf(to);
                    if (fi < 0 || ti < 0) return;
                    const [m] = opts.splice(fi, 1);
                    opts.splice(ti, 0, m);
                    void upsertColumn({ ...groupCol, options: opts });
                  }
                : undefined
            }
          />
        ) : (
          <ViewHint>{t("dbview.hint.kanbanNeedsSelect")}</ViewHint>
        ))}

      {/* Calendar view */}
      {activeView?.type === "calendar" &&
        (groupCol?.type === "date" ? (
          <CalendarView
            rows={searchedRows}
            column={groupCol}
            cardColumns={visibleColumns.filter((c) => c.id !== groupCol.id && !META_TYPES.has(c.type))}
            columns={schema.columns}
            canCreate={canCreate}
            mode={activeView?.calMode ?? "month"}
            onOpenRow={(id) => setPeekRow(id)}
            onAddRow={(dateIso) => createRow({ [groupCol.id]: dateIso })}
            onDeleteRow={canDelete ? (row) => setConfirmDelete(row) : undefined}
          />
        ) : (
          <ViewHint>{t("dbview.hint.calendarNeedsDate")}</ViewHint>
        ))}

      {/* Grid view (card gallery) */}
      {activeView?.type === "grid" && (
        <div ref={viewScrollRef} style={{ maxHeight: viewMaxH }} className="overflow-auto">
          <GridView
            rows={searchedRows}
            cardColumns={visibleColumns.filter((c) => !META_TYPES.has(c.type))}
            columns={schema.columns}
            size={activeView.gridSize ?? "m"}
            showImage={(activeView.gridImage ?? "cover") !== "none"}
            imageUrl={gridImageUrl}
            canCreate={canCreate}
            onOpenRow={(id) => setPeekRow(id)}
            onAddRow={canCreate ? () => createRow() : undefined}
            onDeleteRow={canDelete ? (row) => setConfirmDelete(row) : undefined}
            onReorder={canCreate ? reorderRow : undefined}
          />
        </div>
      )}

      {/* Chart view */}
      {activeView?.type === "chart" &&
        (chartData ? (
          <ChartView
            kind={activeView.chartKind ?? "bar"}
            stacked={!!activeView.chartStacked}
            result={chartData}
          />
        ) : (
          <ViewHint>{t("dbview.hint.chartNeedsAxis")}</ViewHint>
        ))}

      {addViewOpen && (
        <AddViewDialog
          columns={schema.columns}
          onClose={() => setAddViewOpen(false)}
          onCreate={(v) => {
            void addView(v);
            setAddViewOpen(false);
          }}
        />
      )}

      {activeView?.type !== "table" ? null : (
        <>
      {/* Sort + filters bar (client-side). */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <div key={f.id} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
            <span className="text-muted-foreground">{keyName(f.key)}</span>
            <input
              className="w-24 bg-transparent outline-none"
              placeholder={t("dbview.filter.contains")}
              value={f.query}
              onChange={(e) =>
                setFilters((fs) => fs.map((x) => (x.id === f.id ? { ...x, query: e.target.value } : x)))
              }
            />
            <button
              aria-label={t("dbview.filter.remove")}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setFilters((fs) => fs.filter((x) => x.id !== f.id))}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
              <Filter className="size-3.5" /> <span className="max-sm:hidden">{t("dbview.view.filter")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {keys.map((k) => (
              <DropdownMenuItem
                key={k.key}
                onSelect={() =>
                  setFilters((fs) => [...fs, { id: `f${Date.now()}${fs.length}`, key: k.key, query: "" }])
                }
              >
                {k.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {canCreate && schema.columns.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
                <Rows3 className="size-3.5" /> {groupCol ? t("dbview.view.grouped", { name: groupCol.name }) : t("dbview.view.group")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setGroupBy(undefined)}>
                <span className="flex size-4 items-center justify-center">
                  {!groupCol && <Check className="size-3.5" />}
                </span>
                {t("dbview.view.none")}
              </DropdownMenuItem>
              {schema.columns.map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => setGroupBy(c.id)}>
                  <span className="flex size-4 items-center justify-center">
                    {groupCol?.id === c.id && <Check className="size-3.5" />}
                  </span>
                  {c.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {sort && (
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setSort(null)}>
            {t("dbview.view.sortLabel")} {keyName(sort.key)} {sort.dir === "asc" ? "↑" : "↓"} <X className="size-3" />
          </Button>
        )}
      </div>

      {(canDelete || canCreate) && selected.size > 0 && (
        <div className="mb-2 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
          <span className="font-medium">
            {t("dbview.view.rowsSelected", { count: selected.size })}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-7 gap-1">
                {t("dbview.view.actions")} <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {canCreate && (
                <DropdownMenuItem onSelect={() => void bulkDuplicate()}>
                  <Copy className="size-3.5" /> {t("dbview.view.duplicate")}
                </DropdownMenuItem>
              )}
              {canDelete && (
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmBulk(true)}>
                  <Trash2 className="size-3.5" /> {t("dbview.header.delete")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setSelected(new Set())}>
                <X className="size-3.5" /> {t("dbview.view.clearSelection")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div ref={viewScrollRef} style={{ maxHeight: viewMaxH }} className="overflow-auto rounded-lg border bg-background">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="border-b bg-muted/40">
              {(canDelete || canCreate) && (
                <th className="w-8 px-2 py-2">
                  <Checkbox
                    aria-label={t("dbview.view.selectAll")}
                    checked={
                      view.length > 0 && view.every((r) => selected.has(r.id))
                        ? true
                        : view.some((r) => selected.has(r.id))
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={(v) =>
                      setSelected(v === true ? new Set(view.map((r) => r.id)) : new Set())
                    }
                  />
                </th>
              )}
              <th className="w-64 px-3 py-2 text-left font-medium">
                <HeaderMenu
                  label={t("dbview.view.name")}
                  keyId={TITLE_KEY}
                  sort={sort}
                  onSort={(dir) => setSort({ key: TITLE_KEY, dir })}
                />
              </th>
              {visibleColumns.map((c) => {
                const ci = schema.columns.findIndex((x) => x.id === c.id);
                return (
                <th
                  key={c.id}
                  draggable={canCreate}
                  onDragStart={
                    canCreate
                      ? (e) => {
                          e.dataTransfer.setData("text/plain", c.id);
                          setDragCol(c.id);
                        }
                      : undefined
                  }
                  onDragOver={
                    canCreate
                      ? (e) => {
                          e.preventDefault();
                          setOverCol(c.id);
                        }
                      : undefined
                  }
                  onDragLeave={() => setOverCol((o) => (o === c.id ? null : o))}
                  onDrop={
                    canCreate
                      ? (e) => {
                          e.preventDefault();
                          const from = e.dataTransfer.getData("text/plain");
                          if (from) moveColumn(from, c.id);
                          setDragCol(null);
                          setOverCol(null);
                        }
                      : undefined
                  }
                  onDragEnd={() => {
                    setDragCol(null);
                    setOverCol(null);
                  }}
                  style={c.width ? { width: c.width } : undefined}
                  className={cn(
                    "relative px-3 py-2 text-left font-medium",
                    !c.width && "min-w-40",
                    canCreate && "cursor-grab active:cursor-grabbing",
                    overCol === c.id && "bg-primary/10",
                    dragCol === c.id && "opacity-50",
                  )}
                >
                  <HeaderMenu
                    label={c.name}
                    sublabel={columnTypeLabel(c.type)}
                    keyId={c.id}
                    sort={sort}
                    onSort={(dir) => setSort({ key: c.id, dir })}
                    onInsertLeft={canCreate ? () => openNewColumn(ci) : undefined}
                    onInsertRight={canCreate ? () => openNewColumn(ci + 1) : undefined}
                    onEdit={canCreate ? () => setColDialog(c) : undefined}
                    onHide={canCreate ? () => toggleColumnHidden(c.id) : undefined}
                    onToggleWrap={
                      canCreate && c.type === "text" ? () => void upsertColumn({ ...c, wrap: !c.wrap }) : undefined
                    }
                    wrapOn={c.wrap}
                    onDelete={canCreate ? () => setConfirmDeleteCol(c) : undefined}
                  />
                  {canCreate && (
                    <span
                      role="separator"
                      aria-label={t("dbview.act.resizeCol")}
                      onMouseDown={(e) => startResize(c.id, e)}
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
                    />
                  )}
                </th>
                );
              })}
              {(canCreate || canDelete) && (
                <th className="w-10 px-2 py-2">
                  {canCreate && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t("dbview.act.addColumn")}
                      onClick={() => openNewColumn(null)}
                    >
                      <Plus />
                    </Button>
                  )}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {tableGroups
              ? tableGroups.map((g) => (
                  <Fragment key={`g-${g.key}`}>
                    <tr className="border-b bg-muted/30">
                      <td colSpan={colCount} className="px-2 py-1.5">
                        <button
                          className="flex items-center gap-1.5 text-xs font-medium"
                          onClick={() => toggleGroup(g.key)}
                        >
                          {collapsedGroups.has(g.key) ? (
                            <ChevronRight className="size-3.5" />
                          ) : (
                            <ChevronDown className="size-3.5" />
                          )}
                          {groupCol?.type === "select" || groupCol?.type === "status" ? (
                            g.key ? (
                              <OptionBadge value={g.label} color={groupCol.optionColors?.[g.key]} />
                            ) : (
                              <span className="text-muted-foreground">{t("dbview.act.noValue")}</span>
                            )
                          ) : (
                            <span>{g.label}</span>
                          )}
                          <span className="text-muted-foreground">{g.rows.length}</span>
                        </button>
                      </td>
                    </tr>
                    {!collapsedGroups.has(g.key) && g.rows.map(renderRow)}
                  </Fragment>
                ))
              : view.map(renderRow)}
            {view.length === 0 && (
              <tr>
                <td
                  colSpan={
                    visibleColumns.length + 1 + (canDelete ? 1 : 0) + (canCreate || canDelete ? 1 : 0)
                  }
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  {rows.length === 0
                    ? canCreate
                      ? t("dbview.empty.noRowsCreate")
                      : t("dbview.empty.noRows")
                    : t("dbview.empty.noResults")}
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t bg-muted/10">
              {canDelete && <td />}
              <td className="group/calc px-1">
                <CalcCell
                  colKey={TITLE_KEY}
                  isNumber={false}
                  rows={view}
                  agg={schema.calc?.[TITLE_KEY] ?? ""}
                  canEdit={canCreate}
                  onSet={(a) => void setCalc(TITLE_KEY, a)}
                />
              </td>
              {visibleColumns.map((c) => (
                <td key={c.id} className="group/calc px-1">
                  <CalcCell
                    colKey={c.id}
                    isNumber={c.type === "number"}
                    isCheckbox={c.type === "checkbox"}
                    rows={view}
                    agg={schema.calc?.[c.id] ?? ""}
                    canEdit={canCreate}
                    onSet={(a) => void setCalc(c.id, a)}
                  />
                </td>
              ))}
              {(canCreate || canDelete) && <td />}
            </tr>
          </tfoot>
        </table>
      </div>
        </>
      )}

      {/* Column edit dialogs: at the top level normally, but rendered INSIDE
          the drawer when it's open (nested Radix layers → closing the dialog
          doesn't close the Sheet). See also the end of the component. */}
      {!peekRow && colDialogsNode}

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dbview.dialog.deleteRowTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dbview.dialog.deleteRowDesc", { name: confirmDelete?.title || t("dbview.dialog.untitled") })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dbview.dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDelete) void deleteRow(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              {t("dbview.dialog.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmBulk} onOpenChange={(o) => !o && setConfirmBulk(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("dbview.dialog.bulkTitle", { count: selected.size })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("dbview.dialog.bulkDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dbview.dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void bulkDelete();
                setConfirmBulk(false);
              }}
            >
              {t("dbview.dialog.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={defaultScopeFor !== null} onOpenChange={(o) => !o && setDefaultScopeFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dbview.dialog.defaultTplTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dbview.dialog.defaultTplDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dbview.dialog.cancel")}</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                if (defaultScopeFor) setDefaultTemplate(defaultScopeFor, "view");
                setDefaultScopeFor(null);
              }}
            >
              {t("dbview.dialog.thisView")}
            </Button>
            <AlertDialogAction
              onClick={() => {
                if (defaultScopeFor) setDefaultTemplate(defaultScopeFor, "all");
                setDefaultScopeFor(null);
              }}
            >
              {t("dbview.dialog.allViews")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={peekRow !== null} onOpenChange={(o) => !o && setPeekRow(null)}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          className={cn(
            "dot-grid gap-0 overflow-y-auto p-0",
            isMobile ? "h-[80vh] rounded-t-xl" : "w-full sm:max-w-3xl",
          )}
          // Don't close the drawer when interacting with a column dialog
          // (edit / add / confirm) opened on top, rendered in a portal.
          onInteractOutside={(e) => {
            if (colDialog || confirmDeleteCol) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (colDialog || confirmDeleteCol) e.preventDefault();
          }}
        >
          {(() => {
            const r = rows.find((x) => x.id === peekRow);
            if (!r) return null;
            return (
              <>
                <SheetHeader className="border-b p-0">
                  <SheetTitle className="sr-only">{r.title || t("dbview.view.rowFallback")}</SheetTitle>
                  <div className="flex items-center gap-2 px-4 py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1 text-xs"
                      onClick={() => {
                        navigate(`/p/${r.id}`);
                        setPeekRow(null);
                      }}
                    >
                      <Maximize2 className="size-3.5" /> Ouvrir en pleine page
                    </Button>
                  </div>
                  {peekMeta ? (
                    <PageHeader meta={peekMeta} onChange={patchPeek} readOnly={!canEdit} />
                  ) : (
                    <div className="flex items-center gap-2 px-6 pb-4">
                      <ItemIcon icon={r.icon} size={20} className="shrink-0" />
                      <span className="text-lg font-semibold">{r.title || "Sans titre"}</span>
                    </div>
                  )}
                </SheetHeader>
                <div className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 px-6 py-4 text-sm">
                  {schema.columns.map((c) => (
                    <div key={c.id} className="contents">
                      <div className="flex items-center gap-1 truncate py-1 text-muted-foreground" title={c.name}>
                        {canCreate ? (
                          <button
                            className="truncate text-left hover:text-foreground"
                            onClick={() => setColDialog(c)}
                          >
                            {c.name}
                          </button>
                        ) : (
                          <span className="truncate">{c.name}</span>
                        )}
                      </div>
                      <div className="flex items-center">
                        {META_TYPES.has(c.type) ? (
                          <MetaCell type={c.type} row={r} />
                        ) : (
                          <Cell
                            col={c}
                            value={r.props[c.id]}
                            canEdit={canEdit}
                            rowProps={r.props}
                            columns={schema.columns}
                            onChange={(v) => void setCell(r.id, c.id, v)}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {canCreate && (
                  <div className="px-6 pb-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 text-xs text-muted-foreground"
                      onClick={() => openNewColumn(null)}
                    >
                      <Plus className="size-3.5" /> {t("dbview.view.addProperty")}
                    </Button>
                  </div>
                )}
                <div className="border-t py-2">
                  <PeekEditor itemId={r.id} userName={userName} avatar={avatar} />
                </div>
              </>
            );
          })()}
          {/* Column dialogs rendered INSIDE the drawer → closing the dialog
              doesn't close the Sheet (nested Radix layers). */}
          {peekRow && colDialogsNode}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/**
 * Controlled input for live editing: resyncs to the remote `value` as long as
 * it doesn't have focus (→ others' changes appear without blur), and persists
 * debounced during typing (+ immediate commit on blur).
 */
function LiveInput({
  value,
  onCommit,
  sanitize,
  inputMode,
  className,
  placeholder,
  multiline,
  delay = 400,
}: {
  value: string;
  onCommit: (raw: string) => void;
  sanitize?: (s: string) => string;
  inputMode?: "text" | "decimal" | "numeric" | "tel" | "email" | "url";
  className?: string;
  placeholder?: string;
  /** Textarea (line wrapping) instead of a single-line input. */
  multiline?: boolean;
  delay?: number;
}) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  // Apply the remote value only when not editing (don't overwrite typing).
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);

  const schedule = (nv: string) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onCommit(nv), delay);
  };
  const onChange = (nv: string) => {
    const clean = sanitize ? sanitize(nv) : nv;
    setV(clean);
    schedule(clean);
  };
  const onBlur = () => {
    focused.current = false;
    window.clearTimeout(timer.current);
    onCommit(v);
  };

  if (multiline) {
    return (
      <textarea
        rows={1}
        className={cn("resize-none whitespace-pre-wrap wrap-break-word field-sizing-content", className)}
        placeholder={placeholder}
        value={v}
        onFocus={() => (focused.current = true)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
    );
  }

  return (
    <input
      type="text"
      inputMode={inputMode}
      className={cn("truncate", className)}
      placeholder={placeholder}
      value={v}
      onFocus={() => (focused.current = true)}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => {
        e.currentTarget.scrollLeft = 0; // redisplay from the start (ellipsis at the end)
        onBlur();
      }}
    />
  );
}

/** Column footer: "Calculate" aggregate (spreadsheet-style). */
function CalcCell({
  colKey: _colKey,
  isNumber,
  isCheckbox,
  rows,
  agg,
  canEdit,
  onSet,
}: {
  colKey: string;
  isNumber: boolean;
  isCheckbox?: boolean;
  rows: Row[];
  agg: string;
  canEdit: boolean;
  onSet: (agg: string) => void;
}) {
  const { t } = useTranslation();
  const value = agg ? computeAgg(rows, _colKey, agg) : "";
  const label = (
    <span className="flex w-full items-center justify-end gap-1 px-1 py-1 text-xs text-muted-foreground">
      {agg ? (
        <>
          <span className="opacity-70">{aggLabel(agg)}</span>
          <span className="font-medium text-foreground">{value}</span>
        </>
      ) : canEdit ? (
        <span className="opacity-0 transition-opacity group-hover/calc:opacity-100">
          {t("dbview.calc.calculate")}
        </span>
      ) : null}
    </span>
  );
  if (!canEdit) return label;

  const item = (a: string, text: string) => (
    <DropdownMenuItem key={a} onSelect={() => onSet(a)}>
      <span className="flex size-4 items-center justify-center">
        {agg === a && <Check className="size-3.5" />}
      </span>
      {text}
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="w-full">{label}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {item("", t("dbview.calc.none"))}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{t("dbview.calc.quantity")}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {item("count", t("dbview.calc.countAll"))}
            {item("count_values", t("dbview.calc.countValues"))}
            {item("count_empty", t("dbview.calc.countEmpty"))}
            {item("count_unique", t("dbview.calc.countUnique"))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{t("dbview.calc.percentage")}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {item("percent_filled", t("dbview.calc.percentFilled"))}
            {item("percent_empty", t("dbview.calc.percentEmpty"))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {isNumber && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t("dbview.calc.number")}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {item("sum", t("dbview.calc.sum"))}
              {item("avg", t("dbview.calc.avg"))}
              {item("min", t("dbview.calc.min"))}
              {item("max", t("dbview.calc.max"))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {isCheckbox && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t("dbview.calc.checkbox")}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {item("checked", t("dbview.calc.checked"))}
              {item("unchecked", t("dbview.calc.unchecked"))}
              {item("percent_checked", t("dbview.calc.percentChecked"))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A row's content editor, mounted in the preview drawer (dedicated room). */
function PeekEditor({
  itemId,
  userName,
  avatar,
}: {
  itemId: string;
  userName: string;
  avatar: string | null;
}) {
  const [rt, setRt] = useState<Room | null>(null);
  useEffect(() => {
    setRt(acquireRoom(itemId));
    return () => releaseRoom(itemId);
  }, [itemId]);
  if (!rt) return null;
  return (
    <Editor
      itemId={itemId}
      userName={userName}
      avatar={avatar}
      doc={rt.doc}
      awareness={rt.awareness}
      onTreeChange={() => {}}
    />
  );
}

/** Editable cell depending on the column type. */
export function Cell({
  col,
  value,
  canEdit,
  onChange,
  rowProps,
  columns,
  templateMode,
}: {
  col: DbColumn;
  value: unknown;
  canEdit: boolean;
  onChange: (v: unknown) => void;
  /** All of the row's properties — required for `rollup` / `formula`. */
  rowProps?: PropValues;
  /** Schema columns — required for `formula` (resolves prop("Name")). */
  columns?: DbColumn[];
  /** On a template: enables dynamic values (e.g. duplication date). */
  templateMode?: boolean;
}) {
  const disabled = !canEdit;

  if (col.type === "rollup") {
    return <RollupCell col={col} rowProps={rowProps ?? {}} />;
  }
  if (col.type === "formula") {
    return <FormulaCell col={col} rowProps={rowProps ?? {}} columns={columns ?? []} />;
  }
  if (col.type === "checkbox") {
    return (
      <Checkbox
        checked={value === true}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
      />
    );
  }
  if (col.type === "select" || col.type === "status") {
    return (
      <SelectCell
        col={col}
        value={typeof value === "string" ? value : ""}
        canEdit={canEdit}
        withDot={col.type === "status"}
        onChange={onChange}
      />
    );
  }
  if (col.type === "phone" || col.type === "email" || col.type === "url") {
    return (
      <LinkCell
        kind={col.type}
        value={typeof value === "string" ? value : ""}
        canEdit={canEdit}
        onChange={onChange}
      />
    );
  }
  if (col.type === "files") {
    return (
      <FilesCell
        value={Array.isArray(value) ? (value as FileRef[]) : []}
        canEdit={canEdit}
        onChange={onChange}
      />
    );
  }
  if (col.type === "multiselect") {
    return (
      <MultiSelectCell
        col={col}
        value={Array.isArray(value) ? (value as string[]) : []}
        canEdit={canEdit}
        onChange={onChange}
      />
    );
  }
  if (col.type === "date") {
    return <DateCell col={col} value={value} canEdit={canEdit} onChange={onChange} templateMode={templateMode} />;
  }
  if (col.type === "relation") {
    return (
      <RelationCell
        value={Array.isArray(value) ? (value as string[]) : []}
        canEdit={canEdit}
        relationDb={col.relationDb}
        single={col.relationSingle}
        onChange={onChange}
      />
    );
  }
  if (col.type === "number") {
    const dec = col.decimals;
    const allowDot = dec == null || dec > 0;
    const fmt = (n: number) => (dec == null ? String(n) : n.toFixed(dec));
    if (disabled) {
      return (
        <span className="px-1 text-sm">{typeof value === "number" ? fmt(value) : ""}</span>
      );
    }
    return (
      <LiveInput
        value={typeof value === "number" ? fmt(value) : ""}
        inputMode={allowDot ? "decimal" : "numeric"}
        sanitize={(s) => sanitizeNumericInput(s, allowDot)}
        className="w-full bg-transparent px-1 py-0.5 text-sm outline-none"
        onCommit={(raw) => {
          const t = raw.trim();
          const n = Number(t);
          if (t === "" || Number.isNaN(n)) {
            if (value != null) onChange(null);
            return;
          }
          const rounded = dec == null ? n : Number(n.toFixed(dec));
          if (rounded !== value) onChange(rounded);
        }}
      />
    );
  }
  // text
  if (disabled)
    return (
      <span className={cn("px-1 text-sm", col.wrap ? "whitespace-pre-wrap" : "block truncate")}>
        {value == null ? "" : String(value)}
      </span>
    );
  return (
    <LiveInput
      value={value == null ? "" : String(value)}
      multiline={col.wrap}
      className="w-full bg-transparent px-1 py-0.5 text-sm outline-none"
      onCommit={(nv) => {
        if (nv !== (value == null ? "" : String(value))) onChange(nv);
      }}
    />
  );
}

const fmtDateTime = (ms?: number | null) =>
  ms == null ? "" : new Date(ms).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });

/** Read-only meta cell (created/modified: date or name). */
function MetaCell({ type, row }: { type: ColumnType; row: Row }) {
  const text =
    type === "created_time"
      ? fmtDateTime(row.createdTs)
      : type === "last_edited_time"
        ? fmtDateTime(row.updatedTs)
        : type === "created_by"
          ? (row.createdBy ?? "")
          : (row.updatedBy ?? "");
  return <span className="px-1 text-sm text-muted-foreground">{text || "—"}</span>;
}

/** `select` cell: the value is displayed as a colored badge; editing opens an
 * options menu (badges) + "Empty". */
function SelectCell({
  col,
  value,
  canEdit,
  withDot,
  onChange,
}: {
  col: DbColumn;
  value: string;
  canEdit: boolean;
  withDot?: boolean;
  onChange: (v: unknown) => void;
}) {
  // A Status is never empty: if missing, we show the default option.
  const shown = value || (col.type === "status" ? (col.defaultOption ?? "") : "");
  const badge = shown ? (
    <OptionBadge value={shown} color={col.optionColors?.[shown]} dot={withDot} />
  ) : (
    <span className="text-sm text-muted-foreground">—</span>
  );

  if (!canEdit) return <div className="px-1 py-0.5">{badge}</div>;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center rounded px-1 py-0.5 text-left hover:bg-accent">
          {badge}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {col.type !== "status" && (
          <DropdownMenuItem onSelect={() => onChange("")}>
            <span className="text-muted-foreground">— Empty</span>
          </DropdownMenuItem>
        )}
        {col.type === "status"
          ? STATUS_GROUPS.map((g) => {
              const groupOpts = (col.options ?? []).filter((o) => (col.optionGroups?.[o] ?? "todo") === g.id);
              if (groupOpts.length === 0) return null;
              return (
                <div key={g.id}>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">{statusGroupLabel(g.id)}</DropdownMenuLabel>
                  {groupOpts.map((o) => (
                    <DropdownMenuItem key={o} onSelect={() => onChange(o)}>
                      <OptionBadge value={o} color={col.optionColors?.[o]} dot />
                    </DropdownMenuItem>
                  ))}
                </div>
              );
            })
          : (col.options ?? []).map((o) => (
              <DropdownMenuItem key={o} onSelect={() => onChange(o)}>
                <OptionBadge value={o} color={col.optionColors?.[o]} dot={withDot} />
              </DropdownMenuItem>
            ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `multiselect` cell: multiple color badges; editing via checkable menu
 * (remains open between toggles). */
function MultiSelectCell({
  col,
  value,
  canEdit,
  onChange,
}: {
  col: DbColumn;
  value: string[];
  canEdit: boolean;
  onChange: (v: unknown) => void;
}) {
  const { t } = useTranslation();
  const badges =
    value.length > 0 ? (
      <div className="flex flex-wrap gap-1">
        {value.map((o) => (
          <OptionBadge key={o} value={o} color={col.optionColors?.[o]} />
        ))}
      </div>
    ) : (
      <span className="text-sm text-muted-foreground">—</span>
    );

  if (!canEdit) return <div className="px-1 py-0.5">{badges}</div>;

  const toggle = (o: string) =>
    onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center rounded px-1 py-0.5 text-left hover:bg-accent">
          {badges}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {(col.options ?? []).length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("dbview.act.noOptions")}</div>
        )}
        {(col.options ?? []).map((o) => (
          <DropdownMenuItem
            key={o}
            onSelect={(e) => {
              e.preventDefault();
              toggle(o);
            }}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {value.includes(o) && <Check className="size-3.5" />}
            </span>
            <OptionBadge value={o} color={col.optionColors?.[o]} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const dayOf = (iso: string) => iso.slice(0, 10);
const timeOf = (iso: string, fallback: string) => (iso.includes("T") ? iso.slice(11, 16) : fallback);
const isoToDate = (iso: string) => {
  const [y, m, d] = dayOf(iso).split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
};

/** `date` cell: date (+ optional time and/or end) via a calendar popover. */
function DateCell({
  col,
  value,
  canEdit,
  onChange,
  templateMode,
}: {
  col: DbColumn;
  value: unknown;
  canEdit: boolean;
  onChange: (v: unknown) => void;
  /** On a template: allows the dynamic value "duplication date". */
  templateMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const withTime = !!col.dateTime;
  const withEnd = !!col.dateEnd;
  // Dynamic template value (token): shown separately, not parsed as a date.
  const isToken = typeof value === "string" && DATE_TOKEN_RE.test(value);
  const dv = isToken ? null : parseDateValue(value);
  const startTime = dv ? timeOf(dv.start, "09:00") : "09:00";
  const endTime = dv?.end ? timeOf(dv.end, "10:00") : "10:00";

  const compose = (day: string, time: string) => (withTime ? `${day}T${time}` : day);
  const fmt = (iso: string) =>
    format(isoToDate(iso), "d MMM yyyy", { locale: fr }) + (withTime ? ` ${timeOf(iso, "")}` : "");
  const label = isToken ? (
    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
      <CalendarIcon className="size-3.5" /> Duplication date
    </span>
  ) : dv ? (
    dv.end ? `${fmt(dv.start)} → ${fmt(dv.end)}` : fmt(dv.start)
  ) : null;

  const commit = (start: string | null, end: string | null) => {
    if (!start) return onChange(null);
    onChange(withEnd ? { start, end } : start);
  };

  if (!canEdit) {
    return <span className="px-1 text-sm">{label ?? <span className="text-muted-foreground">—</span>}</span>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm hover:bg-accent">
          {label ?? <span className="text-muted-foreground">—</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        {templateMode && (
          <button
            className={cn(
              "mb-2 flex w-full items-center gap-1 rounded border px-2 py-1 text-left text-sm hover:bg-accent",
              isToken && "border-amber-500/50 text-amber-600 dark:text-amber-400",
            )}
            onClick={() => {
              onChange("{{date}}");
              setOpen(false);
            }}
          >
            <CalendarIcon className="size-3.5" /> Duplication date (dynamic)
          </button>
        )}
        {withEnd ? (
          <Calendar
            mode="range"
            locale={fr}
            captionLayout="dropdown"
            startMonth={CAL_MIN_MONTH}
            endMonth={CAL_MAX_MONTH}
            defaultMonth={dv ? isoToDate(dv.start) : undefined}
            selected={{ from: dv ? isoToDate(dv.start) : undefined, to: dv?.end ? isoToDate(dv.end) : undefined }}
            onSelect={(r) =>
              commit(
                r?.from ? compose(format(r.from, "yyyy-MM-dd"), startTime) : null,
                r?.to ? compose(format(r.to, "yyyy-MM-dd"), endTime) : null,
              )
            }
          />
        ) : (
          <Calendar
            mode="single"
            locale={fr}
            captionLayout="dropdown"
            startMonth={CAL_MIN_MONTH}
            endMonth={CAL_MAX_MONTH}
            defaultMonth={dv ? isoToDate(dv.start) : undefined}
            selected={dv ? isoToDate(dv.start) : undefined}
            onSelect={(d) => commit(d ? compose(format(d, "yyyy-MM-dd"), startTime) : null, null)}
          />
        )}

        {withTime && dv && (
          <div className="mt-2 flex items-center gap-2 border-t pt-2 text-sm">
            <input
              type="time"
              value={startTime}
              className="rounded border bg-background px-2 py-1"
              onChange={(e) =>
                commit(compose(dayOf(dv.start), e.target.value), dv.end ?? null)
              }
            />
            {withEnd && dv.end && (
              <>
                <span className="text-muted-foreground">→</span>
                <input
                  type="time"
                  value={endTime}
                  className="rounded border bg-background px-2 py-1"
                  onChange={(e) => commit(dv.start, compose(dayOf(dv.end as string), e.target.value))}
                />
              </>
            )}
          </div>
        )}

        {dv && (
          <button
            className="mt-2 w-full rounded p-1 text-xs text-muted-foreground hover:bg-accent"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            Clear
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Rollup cell (read-only): aggregates a property of linked rows via
 * a relation column of the same database. Linked rows are fetched (cached)
 * then aggregated. Recalculated on reload (session cache). */
function RollupCell({ col, rowProps }: { col: DbColumn; rowProps: PropValues }) {
  const relId = col.rollupRelation;
  const target = col.rollupTarget;
  const agg = col.rollupAgg ?? "count";
  const ids = relId && Array.isArray(rowProps[relId]) ? (rowProps[relId] as string[]) : [];
  const key = ids.join(",");
  const [text, setText] = useState<string>("…");

  useEffect(() => {
    if (!relId) {
      setText("—");
      return;
    }
    if (agg === "count") {
      setText(String(ids.length));
      return;
    }
    if (!target) {
      setText("—");
      return;
    }
    let alive = true;
    Promise.all(ids.map((id) => getItemCached(id).catch(() => null)))
      .then((items) => {
        if (!alive) return;
        const raw = items
          .filter((it): it is NonNullable<typeof it> => it != null)
          .map((it) => (target === "__title" ? (it.title ?? "") : parseProps(it.properties)[target]));
        if (agg === "values") {
          setText(raw.map((v) => (v == null ? "" : String(v))).filter(Boolean).join(", ") || "—");
          return;
        }
        const nums = raw.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
        if (nums.length === 0) {
          setText("—");
          return;
        }
        const sum = nums.reduce((a, b) => a + b, 0);
        const r =
          agg === "sum"
            ? sum
            : agg === "avg"
              ? Math.round((sum / nums.length) * 100) / 100
              : agg === "min"
                ? Math.min(...nums)
                : Math.max(...nums);
        setText(String(r));
      })
      .catch(() => alive && setText("—"));
    return () => {
      alive = false;
    };
  }, [relId, target, agg, key, ids.length]);

  return <span className="px-1 text-sm">{text}</span>;
}

/** Typed value of a column for a row (resolver for `prop("Name")`).
 * Formula columns are evaluated recursively (cycle guard). */
function colValue(
  name: string,
  columns: DbColumn[],
  rowProps: PropValues,
  visiting: Set<string>,
  titles: Map<string, string>,
): FormulaValue {
  const col = columns.find((c) => c.name === name);
  if (!col) return null;
  if (col.type === "formula") {
    if (visiting.has(col.id)) throw new FormulaError(i18n.t("formula.err.circular"));
    if (!col.formula) return null;
    visiting.add(col.id);
    try {
      return evalFormula(parseFormula(col.formula), {
        resolve: (n) => colValue(n, columns, rowProps, visiting, titles),
      });
    } finally {
      visiting.delete(col.id);
    }
  }
  const raw = rowProps[col.id];
  const arr = Array.isArray(raw) ? (raw as unknown[]) : [];
  switch (col.type) {
    case "number":
      return typeof raw === "number" ? raw : raw == null || raw === "" ? null : Number(raw);
    case "checkbox":
      return raw === true;
    case "date": {
      const dv = parseDateValue(raw);
      return dv ? new Date(dv.start) : null;
    }
    case "relation":
      // Titles of linked pages joined (prefetched by FormulaCell).
      return arr.map((id) => titles.get(String(id)) ?? "").filter(Boolean).join(", ");
    case "multiselect":
      return arr.map((x) => (typeof x === "string" ? x : ((x as { name?: string })?.name ?? ""))).filter(Boolean).join(", ");
    case "files":
      return arr.map((f) => (f as { name?: string })?.name ?? "").filter(Boolean).join(", ");
    case "text":
    case "select":
    case "status":
    case "phone":
    case "email":
    case "url":
      return typeof raw === "string" ? raw : raw == null ? null : String(raw);
    default:
      return null; // rollup / meta columns: not supported in v1
  }
}

/** Value of a rollup for a row, from already loaded linked items. */
function computeRollupValue(col: DbColumn, rowProps: PropValues, items: Map<string, ItemMeta>): FormulaValue {
  const relId = col.rollupRelation;
  const ids = relId && Array.isArray(rowProps[relId]) ? (rowProps[relId] as string[]) : [];
  const agg = col.rollupAgg ?? "count";
  if (agg === "count") return ids.length;
  const target = col.rollupTarget;
  if (!target) return null;
  const vals = ids
    .map((id) => items.get(id))
    .filter((it): it is ItemMeta => it != null)
    .map((it) => (target === "__title" ? (it.title ?? "") : parseProps(it.properties)[target]));
  if (agg === "values") return vals.map((v) => (v == null ? "" : String(v))).filter(Boolean).join(", ");
  const nums = vals.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  if (agg === "sum") return sum;
  if (agg === "avg") return Math.round((sum / nums.length) * 100) / 100;
  if (agg === "min") return Math.min(...nums);
  return Math.max(...nums);
}

/** Formula cell (read-only): evaluates the expression on the row. Relation
 * columns are resolved to titles of linked pages (prefetch). */
function FormulaCell({
  col,
  rowProps,
  columns,
}: {
  col: DbColumn;
  rowProps: PropValues;
  columns: DbColumn[];
}) {
  // IDs of linked pages (all relation columns of the row) -> titles.
  const relIds = useMemo(
    () =>
      columns
        .filter((c) => c.type === "relation")
        .flatMap((c) => (Array.isArray(rowProps[c.id]) ? (rowProps[c.id] as string[]) : [])),
    [columns, rowProps],
  );
  const relKey = relIds.join(",");
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (relIds.length === 0) return;
    let alive = true;
    Promise.all(
      relIds.map((id) =>
        getItemCached(id)
          .then((it) => [id, it.title ?? ""] as const)
          .catch(() => [id, ""] as const),
      ),
    ).then((pairs) => alive && setTitles(new Map(pairs)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relKey]);

  const [text, err] = useMemo<[string, string | null]>(() => {
    if (!col.formula) return ["", null];
    try {
      const v = evalFormula(parseFormula(col.formula), {
        resolve: (n) => colValue(n, columns, rowProps, new Set([col.id]), titles),
      });
      return [formatFormulaValue(v), null];
    } catch (e) {
      return ["", e instanceof Error ? e.message : "Erreur"];
    }
  }, [col, rowProps, columns, titles]);

  if (err) {
    return (
      <span className="px-1 text-sm text-destructive" title={err}>
        ⚠ Erreur
      </span>
    );
  }
  return <span className="px-1 text-sm">{text}</span>;
}

/** Cellule `phone` / `email` / `url` : saisie texte + lien cliquable. */
function LinkCell({
  kind,
  value,
  canEdit,
  onChange,
}: {
  kind: "phone" | "email" | "url";
  value: string;
  canEdit: boolean;
  onChange: (v: unknown) => void;
}) {
  const { t } = useTranslation();
  const href = !value
    ? undefined
    : kind === "email"
      ? `mailto:${value}`
      : kind === "phone"
        ? `tel:${value}`
        : /^https?:\/\//i.test(value)
          ? value
          : `https://${value}`;
  const external = kind === "url";

  if (!canEdit) {
    return value ? (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel="noreferrer"
        className="text-primary underline-offset-2 hover:underline"
      >
        {value}
      </a>
    ) : (
      <span className="text-sm text-muted-foreground">—</span>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <LiveInput
        value={value}
        inputMode={kind === "phone" ? "tel" : kind}
        sanitize={kind === "phone" ? sanitizePhoneInput : undefined}
        placeholder={kind === "email" ? "name@example.com" : kind === "phone" ? "+1…" : "https://…"}
        className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
        onCommit={(nv) => {
          const next = nv.trim();
          if (next !== value) onChange(next);
        }}
      />
      {href && (
        <a
          href={href}
          target={external ? "_blank" : undefined}
          rel="noreferrer"
          aria-label={t("dbview.view.open")}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  );
}

const isImageName = (n: string) => /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(n);

/** `files` cell: multiple upload (content-addressed) + list of links /
 * thumbnails; removal per file. */
function FilesCell({
  value,
  canEdit,
  onChange,
}: {
  value: FileRef[];
  canEdit: boolean;
  onChange: (v: unknown) => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    try {
      const uploaded = await Promise.all(
        files.map(async (f) => ({ hash: await uploadFile(f), name: f.name })),
      );
      onChange([...value, ...uploaded]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((f, i) => (
        <span
          key={`${f.hash}-${i}`}
          className="inline-flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5 text-xs"
        >
          {isImageName(f.name) ? (
            <img src={fileUrl(f.hash)} alt="" className="size-4 rounded object-cover" />
          ) : (
            <Paperclip className="size-3 shrink-0" />
          )}
          <a
            href={fileUrl(f.hash)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="max-w-32 truncate hover:underline"
          >
            {f.name}
          </a>
          {canEdit && (
            <button
              aria-label={`Retirer ${f.name}`}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {canEdit && (
        <>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("dbview.act.addFile")}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Plus />
          </Button>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => void pick(e)} />
        </>
      )}
    </div>
  );
}

/** Relation cell: bullets pointing to linked rows + addition from the source database
 * (`relationDb`). Without source (inherited columns), falls back to all pages. */
function RelationCell({
  value,
  canEdit,
  relationDb,
  single,
  onChange,
}: {
  value: string[];
  canEdit: boolean;
  relationDb?: string;
  single?: boolean;
  onChange: (v: string[]) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pick, setPick] = useState(false);
  const add = (id: string) => {
    if (single) onChange([id]);
    else if (!value.includes(id)) onChange([...value, id]);
    setPick(false);
  };
  // In "single value" mode, the + disappears when a link already exists.
  // "Single value" = display constraint: we truncate to the first link
  // (data may contain more, via bidir sync), without losing them.
  const shown = single ? value.slice(0, 1) : value;
  const showAdd = !single || value.length === 0;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((id) => (
        <RelationChip
          key={id}
          id={id}
          onOpen={() => navigate(`/p/${id}`)}
          onRemove={canEdit ? () => onChange(value.filter((x) => x !== id)) : undefined}
        />
      ))}
      {canEdit &&
        showAdd &&
        (relationDb ? (
          <>
            <Button size="icon-xs" variant="ghost" aria-label={t("dbview.rel.linkRow")} onClick={() => setPick(true)}>
              <Plus />
            </Button>
            <RelationPickDialog
              dbId={relationDb}
              open={pick}
              onOpenChange={setPick}
              excludeIds={value}
              onPick={add}
            />
          </>
        ) : (
          <span className="text-xs text-muted-foreground" title={t("dbview.col.configureSource")}>
            {t("dbview.col.notConfigured")}
          </span>
        ))}
    </div>
  );
}

/** Row selector of a source database (typed relation). */
function RelationPickDialog({
  dbId,
  open,
  onOpenChange,
  excludeIds,
  onPick,
}: {
  dbId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  excludeIds: string[];
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<RowMeta[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    listRows(dbId)
      .then((rs) => alive && setRows(rs))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [dbId, open]);

  const filtered = rows.filter(
    (r) => !excludeIds.includes(r.id) && (r.title ?? "").toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dbview.rel.linkRow")}</DialogTitle>
        </DialogHeader>
        <Input autoFocus value={q} placeholder={t("dbview.view.search")} onChange={(e) => setQ(e.target.value)} />
        <ul className="max-h-72 space-y-0.5 overflow-auto">
          {filtered.length === 0 ? (
            <li className="px-2 py-1 text-sm text-muted-foreground">{t("dbview.empty.noRows")}</li>
          ) : (
            filtered.map((r) => (
              <li key={r.id}>
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => onPick(r.id)}
                >
                  <ItemIcon icon={r.icon} size={16} className="shrink-0" />
                  <span className="truncate">{r.title || "Untitled"}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function RelationChip({ id, onOpen, onRemove }: { id: string; onOpen: () => void; onRemove?: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    getItem(id)
      .then((m) => alive && setTitle(m.title ?? ""))
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
      <button
        className="max-w-32 truncate hover:underline disabled:no-underline"
        disabled={missing}
        onClick={onOpen}
      >
        {missing ? "Page unavailable" : title || "Untitled"}
      </button>
      {onRemove && (
        <button aria-label={t("dbview.view.remove")} onClick={onRemove} className="text-muted-foreground hover:text-foreground">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

/** Icon per column type (modal type selector). Descriptions are localized via
 *  `dbview.typeDesc.*`. */
const TYPE_ICONS: Record<ColumnType, LucideIcon> = {
  text: Type,
  number: Hash,
  checkbox: SquareCheck,
  select: CircleDot,
  multiselect: ListChecks,
  status: Circle,
  date: CalendarIcon,
  phone: Phone,
  email: AtSign,
  url: LinkIcon,
  files: Paperclip,
  relation: ArrowLeftRight,
  rollup: Repeat,
  formula: FunctionSquare,
  created_time: CalendarPlus,
  created_by: UserPlus,
  last_edited_time: CalendarClock,
  last_edited_by: UserPen,
};

/** Small option addition field (Enter or blur validates). */
function AddOptionInput({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => void }) {
  const [v, setV] = useState("");
  const commit = () => {
    const t = v.trim();
    setV("");
    if (t) onAdd(t);
  };
  return (
    <Input
      value={v}
      placeholder={placeholder}
      className="h-7 text-xs"
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      onBlur={commit}
    />
  );
}

/** Add / edit column dialog. */
export function ColumnDialog({
  column,
  columns,
  onClose,
  onSave,
  onDelete,
}: {
  column: DbColumn | null;
  /** Columns of this database (for rollup: choose the source relation). */
  columns: DbColumn[];
  onClose: () => void;
  onSave: (c: DbColumn) => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(column?.name ?? "");
  const [type, setType] = useState<ColumnType>(column?.type ?? "text");
  const [options, setOptions] = useState<string[]>(column?.options ?? []);
  const [optionColors, setOptionColors] = useState<Record<string, string>>(column?.optionColors ?? {});
  const [optionGroups, setOptionGroups] = useState<Record<string, string>>(column?.optionGroups ?? {});
  const [defaultOption, setDefaultOption] = useState<string | undefined>(column?.defaultOption);
  const [decimals, setDecimals] = useState<number | undefined>(column?.decimals);
  const [target, setTarget] = useState<number | undefined>(column?.target);
  const [dateEnd, setDateEnd] = useState(!!column?.dateEnd);
  const [dateTime, setDateTime] = useState(!!column?.dateTime);
  const [relationDb, setRelationDb] = useState<string | undefined>(column?.relationDb);
  const [relationSingle, setRelationSingle] = useState(!!column?.relationSingle);
  const [relationBidirectional, setRelationBidirectional] = useState(!!column?.relationBidirectional);
  const [databases, setDatabases] = useState<ItemMeta[]>([]);
  const [optDraft, setOptDraft] = useState("");
  // Rollup: source relation (on this database) + target column (on the linked database)
  // + aggregate. Target columns are loaded from the linked database.
  const [rollupRelation, setRollupRelation] = useState<string | undefined>(column?.rollupRelation);
  const [rollupTarget, setRollupTarget] = useState<string | undefined>(column?.rollupTarget);
  const [rollupAgg, setRollupAgg] = useState<NonNullable<DbColumn["rollupAgg"]>>(column?.rollupAgg ?? "count");
  const [targetCols, setTargetCols] = useState<DbColumn[]>([]);
  const [formula, setFormula] = useState(column?.formula ?? "");
  // Live validation: parses the expression, shows error message below the field.
  const formulaError = useMemo(() => {
    if (type !== "formula" || !formula.trim()) return null;
    try {
      parseFormula(formula);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid formula";
    }
  }, [type, formula]);

  useEffect(() => {
    if (type !== "relation") return;
    let alive = true;
    listItems()
      .then((items) => alive && setDatabases(items.filter((i) => i.db_schema != null)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [type]);

  // Loads target columns of the linked database chosen by the relation (rollup targets).
  const relCol = columns.find((c) => c.id === rollupRelation && c.type === "relation");
  const relDbId = relCol?.relationDb;
  useEffect(() => {
    if (type !== "rollup" || !relDbId) {
      setTargetCols([]);
      return;
    }
    let alive = true;
    getItem(relDbId)
      .then((it) => alive && setTargetCols(parseSchema(it.db_schema).columns))
      .catch(() => alive && setTargetCols([]));
    return () => {
      alive = false;
    };
  }, [type, relDbId]);
  // In creation, the grid is open (choosing the type = target); in
  // editing, it is collapsed behind a compact line.
  const [showTypeGrid, setShowTypeGrid] = useState(column === null);
  // An already established relation freezes its source database and bidir mode (otherwise links/
  // mirror column orphaned).
  const sourceLocked = !!column?.relationDb;
  const bidirLocked = !!column?.relationBidirectional;
  function selectType(next: ColumnType) {
    setType(next);
    // A fresh "Status" starts with one default option per group (by convention).
    if (next === "status" && options.length === 0) {
      const ns = t("dbview.statusSeed.notStarted");
      const ip = t("dbview.statusSeed.inProgress");
      const dn = t("dbview.statusSeed.done");
      setOptions([ns, ip, dn]);
      setOptionColors({ [ns]: "gray", [ip]: "blue", [dn]: "green" });
      setOptionGroups({ [ns]: "todo", [ip]: "doing", [dn]: "done" });
      setDefaultOption(ns);
    }
    if (column) setShowTypeGrid(false);
  }

  function addOption() {
    const v = optDraft.trim();
    setOptDraft("");
    if (v && !options.includes(v)) setOptions([...options, v]);
  }

  /** Adds an option to a status group (color = group color). */
  function addOptionToGroup(groupId: string, name: string) {
    if (!name || options.includes(name)) return;
    const group = STATUS_GROUPS.find((g) => g.id === groupId);
    setOptions([...options, name]);
    setOptionGroups((gs) => ({ ...gs, [name]: groupId }));
    if (group) setOptionColors((cs) => ({ ...cs, [name]: group.color }));
  }

  function removeOption(o: string) {
    setOptions(options.filter((x) => x !== o));
    setOptionColors((cs) => {
      const { [o]: _c, ...rest } = cs;
      return rest;
    });
    setOptionGroups((gs) => {
      const { [o]: _g, ...rest } = gs;
      return rest;
    });
    setDefaultOption((d) => (d === o ? undefined : d));
  }

  function save() {
    // Only retains colors of options that are still present.
    const colors = Object.fromEntries(options.filter((o) => optionColors[o]).map((o) => [o, optionColors[o]]));
    const col: DbColumn = {
      id: column?.id ?? newColumnId(),
      name: name.trim() || columnTypeLabel(type),
      type,
      ...(type === "select" || type === "multiselect" || type === "status"
        ? { options, optionColors: colors }
        : {}),
      ...(type === "status"
        ? {
            optionGroups: Object.fromEntries(options.filter((o) => optionGroups[o]).map((o) => [o, optionGroups[o]])),
            ...(defaultOption && options.includes(defaultOption)
              ? { defaultOption }
              : options[0]
                ? { defaultOption: options[0] }
                : {}),
          }
        : {}),
      ...(type === "number" && decimals != null ? { decimals } : {}),
      ...(type === "number" && target != null && !Number.isNaN(target) ? { target } : {}),
      ...(type === "date" && dateEnd ? { dateEnd: true } : {}),
      ...(type === "date" && dateTime ? { dateTime: true } : {}),
      ...(type === "relation" && relationDb
        ? {
            relationDb,
            ...(relationSingle ? { relationSingle: true } : {}),
            ...(relationBidirectional ? { relationBidirectional: true } : {}),
            ...(column?.relationReciprocal ? { relationReciprocal: column.relationReciprocal } : {}),
          }
        : {}),
      ...(type === "rollup" && rollupRelation
        ? {
            rollupRelation,
            rollupAgg,
            ...(rollupAgg !== "count" && rollupTarget ? { rollupTarget } : {}),
          }
        : {}),
      ...(type === "formula" && formula.trim() ? { formula: formula.trim() } : {}),
    };
    onSave(col);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Do not return focus on unmount: avoids closing a parent drawer
          (its focusOutside on the Sheet would close it). */}
      <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{column ? "Modify column" : "New column"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input value={name} autoFocus placeholder={t("dbview.col.namePlaceholder")} onChange={(e) => setName(e.target.value)} />

          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("dbview.act.typeLabel")}</span>
            {!showTypeGrid ? (
              <button
                type="button"
                onClick={() => setShowTypeGrid(true)}
                className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                {(() => {
                  const Icon = TYPE_ICONS[type];
                  return <Icon className="size-4 shrink-0 text-muted-foreground" />;
                })()}
                <span className="flex-1 text-left">{columnTypeLabel(type)}</span>
                <span className="text-xs text-muted-foreground">{t("dbview.col.change")}</span>
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </button>
            ) : (
              <TooltipProvider delayDuration={300}>
                <div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto pr-1">
                  {COLUMN_TYPES.map((ct) => {
                    const Icon = TYPE_ICONS[ct];
                    const desc = t(`dbview.typeDesc.${ct}` as "dbview.typeDesc.text");
                    const active = ct === type;
                    return (
                      <div
                        key={ct}
                        role="button"
                        tabIndex={0}
                        onClick={() => selectType(ct)}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && selectType(ct)}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm",
                          active ? "border-primary bg-accent" : "border-transparent hover:bg-accent/50",
                        )}
                      >
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate text-left">{columnTypeLabel(ct)}</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className="shrink-0 text-muted-foreground/60 hover:text-foreground"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Info className="size-3.5" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-52">
                            {desc}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    );
                  })}
                </div>
              </TooltipProvider>
            )}
          </div>
          {type === "number" && (
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("dbview.col.decimals")}</span>
              <select
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                value={decimals ?? "auto"}
                onChange={(e) => setDecimals(e.target.value === "auto" ? undefined : Number(e.target.value))}
              >
                <option value="auto">{t("dbview.col.auto")}</option>
                <option value="0">{t("dbview.col.integer")}</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
              </select>
              <span className="text-xs font-medium text-muted-foreground">{t("dbview.col.targetValue")}</span>
              <Input
                type="number"
                inputMode="decimal"
                placeholder={t("dbview.col.none")}
                value={target ?? ""}
                onChange={(e) => setTarget(e.target.value === "" ? undefined : Number(e.target.value))}
              />
            </div>
          )}
          {type === "relation" && (
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("dbview.col.sourceBase")}</span>
              <select
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                value={relationDb ?? ""}
                disabled={sourceLocked}
                onChange={(e) => setRelationDb(e.target.value || undefined)}
              >
                <option value="">{t("dbview.col.chooseBase")}</option>
                {databases.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title || t("dbview.dialog.untitled")}
                  </option>
                ))}
              </select>
              {sourceLocked ? (
                <p className="text-xs text-muted-foreground">
                  {t("dbview.col.sourceLockedHint")}
                </p>
              ) : (
                !relationDb && (
                  <p className="text-xs text-muted-foreground">
                    {t("dbview.col.chooseBaseHint")}
                  </p>
                )
              )}
              <label className="flex items-center justify-between gap-2 pt-1 text-sm">
                {t("dbview.col.singleValue")}
                <Switch checked={relationSingle} onCheckedChange={setRelationSingle} />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                {t("dbview.col.bidirectional")}
                <Switch
                  checked={relationBidirectional}
                  disabled={bidirLocked}
                  onCheckedChange={setRelationBidirectional}
                />
              </label>
              {relationBidirectional && (
                <p className="text-xs text-muted-foreground">
                  {t("dbview.col.mirrorHint")}
                </p>
              )}
            </div>
          )}
          {type === "rollup" && (
            <div className="space-y-2">
              <span className="text-xs font-medium text-muted-foreground">{t("dbview.col.sourceRelation")}</span>
              <select
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                value={rollupRelation ?? ""}
                onChange={(e) => {
                  setRollupRelation(e.target.value || undefined);
                  setRollupTarget(undefined);
                }}
              >
                <option value="">{t("dbview.col.choose")}</option>
                {columns
                  .filter((c) => c.type === "relation")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              {columns.filter((c) => c.type === "relation").length === 0 && (
                <p className="text-xs text-muted-foreground">{t("dbview.col.addRelationFirst")}</p>
              )}
              <span className="text-xs font-medium text-muted-foreground">{t("dbview.chart.calc")}</span>
              <select
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                value={rollupAgg}
                onChange={(e) => setRollupAgg(e.target.value as NonNullable<DbColumn["rollupAgg"]>)}
              >
                <option value="count">{t("dbview.col.rollupAgg.count")}</option>
                <option value="sum">{t("dbview.col.rollupAgg.sum")}</option>
                <option value="avg">{t("dbview.col.rollupAgg.avg")}</option>
                <option value="min">{t("dbview.col.rollupAgg.min")}</option>
                <option value="max">{t("dbview.col.rollupAgg.max")}</option>
                <option value="values">{t("dbview.col.rollupAgg.values")}</option>
              </select>
              {rollupAgg !== "count" && (
                <>
                  <span className="text-xs font-medium text-muted-foreground">{t("dbview.col.aggregatedProp")}</span>
                  <select
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    value={rollupTarget ?? ""}
                    onChange={(e) => setRollupTarget(e.target.value || undefined)}
                    disabled={!rollupRelation}
                  >
                    <option value="">{t("dbview.col.choose")}</option>
                    <option value="__title">{t("dbview.col.title")}</option>
                    {targetCols.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          )}
          {type === "formula" && (
            <FormulaEditor
              value={formula}
              onChange={setFormula}
              columns={columns}
              selfId={column?.id}
              error={formulaError}
            />
          )}
          {type === "date" && (
            <div className="space-y-2">
              <label className="flex items-center justify-between gap-2 text-sm">
                {t("dbview.col.includeEnd")}
                <Switch checked={dateEnd} onCheckedChange={setDateEnd} />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                {t("dbview.col.includeTime")}
                <Switch checked={dateTime} onCheckedChange={setDateTime} />
              </label>
            </div>
          )}
          {type === "status" && (
            <div className="space-y-3">
              {STATUS_GROUPS.map((g) => {
                const groupOpts = options.filter((o) => (optionGroups[o] ?? "todo") === g.id);
                return (
                  <div key={g.id} className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">{statusGroupLabel(g.id)}</span>
                    {groupOpts.map((o) => (
                      <div key={o} className="flex items-center gap-2">
                        <ColorPicker
                          color={optionColors[o]}
                          onChange={(c) => setOptionColors((cs) => ({ ...cs, [o]: c }))}
                        />
                        <OptionBadge value={o} color={optionColors[o]} className="min-w-0" />
                        <div className="ml-auto flex items-center gap-2">
                          {defaultOption === o ? (
                            <span className="text-[10px] font-medium tracking-wide text-muted-foreground">
                              {t("dbview.col.defaultUpper")}
                            </span>
                          ) : (
                            <button
                              className="text-[10px] text-muted-foreground hover:text-foreground"
                              onClick={() => setDefaultOption(o)}
                            >
                              {t("dbview.col.default")}
                            </button>
                          )}
                          <button
                            aria-label={t("dbview.col.removeOpt", { name: o })}
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => removeOption(o)}
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                    <AddOptionInput
                      placeholder={t("dbview.col.addToGroup", { name: statusGroupLabel(g.id) })}
                      onAdd={(v) => addOptionToGroup(g.id, v)}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {(type === "select" || type === "multiselect") && (
            <div className="space-y-2">
              {options.length > 0 && (
                <div className="space-y-1">
                  {options.map((o) => (
                    <div key={o} className="flex items-center gap-2">
                      <ColorPicker
                        color={optionColors[o]}
                        onChange={(c) => setOptionColors((cs) => ({ ...cs, [o]: c }))}
                      />
                      <OptionBadge value={o} color={optionColors[o]} className="min-w-0" />
                      <button
                        aria-label={t("dbview.col.removeOpt", { name: o })}
                        className="ml-auto text-muted-foreground hover:text-foreground"
                        onClick={() => removeOption(o)}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Input
                value={optDraft}
                placeholder={t("dbview.col.addOption")}
                onChange={(e) => setOptDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addOption();
                  }
                }}
                onBlur={addOption}
              />
            </div>
          )}
        </div>
        <DialogFooter className="flex-row justify-between">
          {onDelete ? (
            <Button variant="ghost" size="sm" className="text-destructive" onClick={onDelete}>
              <Trash2 className="size-4" /> {t("dbview.col.delete")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("dbview.col.cancel")}
            </Button>
            <Button
              onClick={save}
              disabled={
                (type === "relation" && !relationDb) ||
                (type === "rollup" && (!rollupRelation || (rollupAgg !== "count" && !rollupTarget))) ||
                (type === "formula" && (!formula.trim() || formulaError != null))
              }
            >
              {t("dbview.col.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Radio-style menu item (label + checkmark if active). */
function MenuRadio({ label, active, onPick }: { label: string; active: boolean; onPick: () => void }) {
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        onPick();
      }}
    >
      <span className="flex-1 truncate">{label}</span>
      {active && <Check className="size-3.5" />}
    </DropdownMenuItem>
  );
}

/** Message when a board/calendar view has no grouping column. */
function ViewHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** View creation dialog (type + grouping column if needed). */
function AddViewDialog({
  columns,
  onClose,
  onCreate,
}: {
  columns: DbColumn[];
  onClose: () => void;
  onCreate: (v: DbView) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [type, setType] = useState<ViewType>("table");
  const [groupBy, setGroupBy] = useState("");
  const candidates = columns.filter((c) =>
    type === "board"
      ? c.type === "select" || c.type === "status"
      : type === "calendar"
        ? c.type === "date"
        : type === "chart"
          ? c.type === "select" || c.type === "status" || c.type === "date"
          : false,
  );
  const needsCol = type === "board" || type === "calendar" || type === "chart";
  const defaultName = t(`dbview.viewName.${type}`);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dbview.addView.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={name}
            autoFocus
            placeholder={t("dbview.addView.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            value={type}
            onChange={(e) => setType(e.target.value as ViewType)}
          >
            <option value="table">{t("dbview.addView.type.table")}</option>
            <option value="board">{t("dbview.addView.type.board")}</option>
            <option value="calendar">{t("dbview.addView.type.calendar")}</option>
            <option value="grid">{t("dbview.addView.type.grid")}</option>
            <option value="chart">{t("dbview.addView.type.chart")}</option>
          </select>
          {needsCol &&
            (candidates.length ? (
              <select
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
              >
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("dbview.addView.needCol", {
                  type:
                    type === "board"
                      ? t("dbview.addView.colSelect")
                      : type === "calendar"
                        ? t("dbview.addView.colDate")
                        : t("dbview.addView.colSelectOrDate"),
                })}
              </p>
            ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("dbview.addView.cancel")}
          </Button>
          <Button
            disabled={needsCol && candidates.length === 0}
            onClick={() =>
              onCreate({
                id: newViewId(),
                name: name.trim() || defaultName,
                type,
                groupBy: needsCol ? groupBy || candidates[0]?.id : undefined,
              })
            }
          >
            {t("dbview.addView.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
