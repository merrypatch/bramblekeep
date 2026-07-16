/** Database schema types + property values. The backend stores these shapes
 * as opaque JSON (db_schema/properties columns); the structure lives here. */

import i18n from "@/i18n";

export type ColumnType =
  | "text"
  | "number"
  | "checkbox"
  | "select"
  | "multiselect"
  | "status"
  | "date"
  | "phone"
  | "email"
  | "url"
  | "files"
  | "relation"
  | "rollup"
  | "formula"
  // Read-only meta columns (derived from the item, not from properties).
  | "created_time"
  | "created_by"
  | "last_edited_time"
  | "last_edited_by";

/** Column types computed from item metadata (read-only). */
export const META_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>([
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
]);

/** An attached file (`files` type): addressed by hash + original name. */
export type FileRef = { hash: string; name: string };

/** Hash of the first image in a file-column value, otherwise null. */
export function fileImageHash(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const f of value as FileRef[]) {
    if (f?.hash && typeof f.name === "string" && /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(f.name)) {
      return f.hash;
    }
  }
  return null;
}

/** Value of a `date` column. `start`/`end` = "YYYY-MM-DD" or
 * "YYYY-MM-DDTHH:mm". Without an end, the stored value is the bare `start`
 * string (backward-compat); with an end, an object `{start, end}`. */
export type DateValue = { start: string; end?: string | null };

/** Normalizes the stored value (legacy string or object) into a DateValue. */
export function parseDateValue(v: unknown): DateValue | null {
  if (typeof v === "string") return v ? { start: v } : null;
  if (v && typeof v === "object") {
    const o = v as { start?: unknown; end?: unknown };
    if (typeof o.start === "string" && o.start) {
      return { start: o.start, end: typeof o.end === "string" && o.end ? o.end : null };
    }
  }
  return null;
}

export type DbColumn = {
  id: string;
  name: string;
  type: ColumnType;
  /** Options for a `select`. */
  options?: string[];
  /** Color (palette name) per `select` option. Absent = default color. */
  optionColors?: Record<string, string>;
  /** `status`: group (id) per option — cf. STATUS_GROUPS. Default = 1st group. */
  optionGroups?: Record<string, string>;
  /** `status`: default option (new rows take it; never empty). */
  defaultOption?: string;
  /** Width in px (resizable). Absent = auto width. */
  width?: number;
  /** Number of decimals displayed for a `number`. Absent = auto (as-is). */
  decimals?: number;
  /** `number`: target value (goal). Plotted as a "Cible" series in a chart. */
  target?: number;
  /** `text`: wrap lines instead of a truncated single line. */
  wrap?: boolean;
  /** `date`: include an end date (range). */
  dateEnd?: boolean;
  /** `date`: include the time (otherwise date only). */
  dateTime?: boolean;
  /** `relation`: id of the source database (values = its rows only). */
  relationDb?: string;
  /** `relation`: allow only a single link (otherwise several). */
  relationSingle?: boolean;
  /** `relation`: sync a mirror column in the target database. */
  relationBidirectional?: boolean;
  /** `relation`: id of the reciprocal column in the target database (if bidir). */
  relationReciprocal?: string;
  /** `rollup`: id of the relation column (on THIS database) whose targets are aggregated. */
  rollupRelation?: string;
  /** `rollup`: column aggregated on the linked database ("__title" = row title). */
  rollupTarget?: string;
  /** `rollup`: aggregate applied to the linked rows' values. */
  rollupAgg?: "count" | "sum" | "avg" | "min" | "max" | "values";
  /** `formula`: expression (column refs via prop("Name")), evaluated per row. */
  formula?: string;
};

/** Fixed groups of a `status` column, in order. The label
 * is localized via `statusGroupLabel` (the `id` stays the stored value). */
export const STATUS_GROUPS: { id: string; color: string }[] = [
  { id: "todo", color: "gray" },
  { id: "doing", color: "blue" },
  { id: "done", color: "green" },
];

/** Localized label of a status group (todo | doing | done). */
export function statusGroupLabel(id: string): string {
  return i18n.t(`db.statusGroup.${id}` as "db.statusGroup.todo");
}

export type ViewType = "table" | "board" | "calendar" | "grid" | "chart";
/** Display mode of a calendar view. */
export type CalMode = "month" | "week" | "day";
/** Card size of a grid view. */
export type GridSize = "s" | "m" | "l";
/** Chart type of a chart view. */
export type ChartKind = "bar" | "line" | "area" | "pie" | "radar" | "radial";
/** Aggregate of a chart view. */
export type ChartAgg = "count" | "sum" | "avg" | "min" | "max";
/** Transformation applied to the aggregated values (along the sorted X axis).
 * `burndown` = special case: total of ALL rows − cumulative sum of "done"
 * rows (see `chartDoneCol`), a single descending curve. */
export type ChartTransform = "none" | "cumulative" | "remaining" | "burndown";
/** Temporal grouping of the X axis when the grouping column is a date. */
export type ChartBucket = "day" | "week" | "month";
/** A view of a database. `groupBy` = select column (board) or date (calendar). */
export type DbView = {
  id: string;
  name: string;
  type: ViewType;
  groupBy?: string;
  /** Ids of columns hidden in this view (values preserved). */
  hidden?: string[];
  /** Collapsed kanban categories (option keys). */
  collapsed?: string[];
  /** `calendar`: default display mode (month if absent). */
  calMode?: CalMode;
  /** `grid`: card size (medium if absent). */
  gridSize?: GridSize;
  /** `grid`: image source — "cover" (default), "none", or the id of a
   * file column (first image of the column). */
  gridImage?: string;
  /** `chart`: chart type (bars if absent). X axis = `groupBy`. */
  chartKind?: ChartKind;
  /** `chart`: Y-axis aggregate (row count if absent). */
  chartAgg?: ChartAgg;
  /** `chart`: id of the aggregated number column (if `chartAgg !== "count"`). */
  chartValueCol?: string;
  /** `chart`: column splitting into multiple series (stacked / multi-line). */
  chartSeries?: string;
  /** `chart`: temporal grouping when the X axis is a date (day if absent). */
  chartBucket?: ChartBucket;
  /** `chart`: value transformation (none, cumulative, remaining = total-cumulative). */
  chartTransform?: ChartTransform;
  /** `chart`: X-axis sort — "x" (value/chronological, default) or "value". */
  chartSort?: "x" | "value";
  /** `chart`: stack the series (bars). */
  chartStacked?: boolean;
  /** `chart` (burndown transform): `status` column whose "done" group
   * marks a row as finished (decrements the remaining). */
  chartDoneCol?: string;
  /** `chart` (burndown transform): show the ideal line (total → 0). */
  chartIdeal?: boolean;
  /** Default template specific to this view (overrides `schema.defaultTemplate`). */
  defaultTemplate?: string;
  /** Persistent sort of the view (table). */
  sort?: { key: string; dir: "asc" | "desc" };
  /** Persistent filters of the view (table): AND substring per column. */
  filters?: { id: string; key: string; query: string }[];
};

export type DbSchema = {
  columns: DbColumn[];
  views: DbView[];
  /** Manual row order (ids). Missing rows follow (by creation). */
  rowOrder?: string[];
  /** Column footer aggregate (calc id) per column key (or __title). */
  calc?: Record<string, string>;
  /** Columns hidden on a row's page (applies to all rows). */
  pageHidden?: string[];
  /** Row templates: ids of hidden child items (excluded from views), instantiated
   * (duplicated) when a row is created. Title/icon read live from
   * the item (renaming the template updates the menu). */
  templates?: string[];
  /** Id of the template applied by default when clicking "New row". */
  defaultTemplate?: string;
};

/** Property values of a row, indexed by column id. */
export type PropValues = Record<string, unknown>;

/** A loaded row (child page): title + icon + property values +
 * item metadata (for the created/edited columns). */
export type Row = {
  id: string;
  title: string | null;
  icon: string | null;
  /** Hash of the cover file (page header image), if set. */
  cover: string | null;
  props: PropValues;
  createdTs?: number | null;
  createdBy?: string | null;
  updatedTs?: number | null;
  updatedBy?: string | null;
};

const DEFAULT_VIEW: DbView = { id: "table", name: "Table", type: "table" };

/** Bootstrap schema of a fresh database: one text column + the table view.
 * Avoids the empty "titles only" screen on creation. */
export function starterSchema(): DbSchema {
  return { columns: [{ id: newColumnId(), name: "Notes", type: "text" }], views: [DEFAULT_VIEW] };
}

export function parseSchema(json: string | null | undefined): DbSchema {
  if (!json) return { columns: [], views: [DEFAULT_VIEW] };
  try {
    const s = JSON.parse(json) as {
      columns?: unknown;
      views?: unknown;
      rowOrder?: unknown;
      calc?: unknown;
      pageHidden?: unknown;
      templates?: unknown;
      defaultTemplate?: unknown;
    };
    const columns = Array.isArray(s.columns) ? (s.columns as DbColumn[]) : [];
    const views =
      Array.isArray(s.views) && s.views.length > 0 ? (s.views as DbView[]) : [DEFAULT_VIEW];
    const rowOrder = Array.isArray(s.rowOrder) ? (s.rowOrder as string[]) : undefined;
    const calc =
      s.calc && typeof s.calc === "object" ? (s.calc as Record<string, string>) : undefined;
    const pageHidden = Array.isArray(s.pageHidden) ? (s.pageHidden as string[]) : undefined;
    // Backward-compat: old shape [{id,name}] → keep only the ids.
    const templates = Array.isArray(s.templates)
      ? (s.templates as unknown[]).map((t) => (typeof t === "string" ? t : ((t as { id?: string })?.id ?? ""))).filter(Boolean)
      : undefined;
    const defaultTemplate = typeof s.defaultTemplate === "string" ? s.defaultTemplate : undefined;
    return { columns, views, rowOrder, calc, pageHidden, templates, defaultTemplate };
  } catch {
    return { columns: [], views: [DEFAULT_VIEW] };
  }
}

/** Sorts the rows by `rowOrder`; missing ones follow in their initial order
 * (creation, via UUIDv7). Stable and tolerant of stale ids / new rows. */
export function orderRows(rows: Row[], order?: string[]): Row[] {
  if (!order || order.length === 0) return rows;
  const pos = new Map(order.map((id, i) => [id, i]));
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const pa = pos.get(a.r.id) ?? Infinity;
      const pb = pos.get(b.r.id) ?? Infinity;
      return pa === pb ? a.i - b.i : pa - pb;
    })
    .map((x) => x.r);
}

export function parseProps(json: string | null | undefined): PropValues {
  if (!json) return {};
  try {
    const p = JSON.parse(json) as unknown;
    return p && typeof p === "object" ? (p as PropValues) : {};
  } catch {
    return {};
  }
}

/** Column types offered at creation, in menu order. */
export const COLUMN_TYPES: ColumnType[] = [
  "text",
  "number",
  "checkbox",
  "select",
  "multiselect",
  "status",
  "date",
  "phone",
  "email",
  "url",
  "files",
  "relation",
  "rollup",
  "formula",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
];

/** Localized label of a column type. */
export function columnTypeLabel(type: ColumnType): string {
  return i18n.t(`db.columnType.${type}` as "db.columnType.text");
}

let seq = 0;
/** Unique id (column or view), stable within the session. */
export function newId(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}
export const newColumnId = () => newId("c");
export const newViewId = () => newId("v");
