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

export type ViewType = "table" | "board" | "calendar" | "grid" | "chart" | "graph";
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
/** Operators available on a filter condition. The applicable subset depends
 * on the column type — see `operatorsForType` in `filter.ts`. The evaluation
 * (type-aware) also lives in `filter.ts`; only the shapes live here. */
export type FilterOperator =
  // text / phone / email / url / created_by / last_edited_by
  | "contains"
  | "not_contains"
  | "is"
  | "is_not"
  | "starts_with"
  | "ends_with"
  // number
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  // select / multiselect / relation (membership)
  | "any_of"
  | "none_of"
  // checkbox
  | "is_checked"
  | "is_unchecked"
  // date / created_time / last_edited_time
  | "date_is"
  | "date_before"
  | "date_after"
  | "date_on_before"
  | "date_on_after"
  // any type
  | "is_empty"
  | "is_not_empty";

/** A single filter rule: a column, an operator, and (optionally) a value.
 * `columnId` is a column id or `"__title"` for the row title. `value` shape
 * depends on the operator (string, number, date string, or string[]). */
export type FilterCondition = {
  id: string;
  columnId: string;
  operator: FilterOperator;
  value?: unknown;
};

/** A boolean group of rules/sub-groups combined with `and` / `or`.
 * Nesting is used (UI limits it to 2 levels, the engine is recursive). */
export type FilterGroup = {
  id: string;
  op: "and" | "or";
  conditions: (FilterCondition | FilterGroup)[];
};

/** Narrows a filter tree node to a group (vs. a leaf condition). */
export function isFilterGroup(node: FilterCondition | FilterGroup): node is FilterGroup {
  return "conditions" in node;
}

/** A dynamic filter value: resolved at render time from the HOST page (the page
 * a linked-database block is embedded in). `prop` → a property of the host page
 * (parent-db column id); `title` → the host page's title. Lets a template embed
 * a database pre-filtered by each new page's own value. */
export type FilterRef = { ref: "prop"; columnId: string } | { ref: "title" };

/** Narrows a condition `value` to a dynamic host reference. */
export function isFilterRef(v: unknown): v is FilterRef {
  return (
    !!v &&
    typeof v === "object" &&
    (v as { ref?: unknown }).ref === "prop" &&
    typeof (v as { columnId?: unknown }).columnId === "string"
  ) || (!!v && typeof v === "object" && (v as { ref?: unknown }).ref === "title");
}

/** Migrates any persisted filter value to the current tree shape.
 * - `undefined`/empty → `undefined`
 * - legacy flat array `[{id,key,query}]` → an `and` group of `contains` rules
 *   (empty queries dropped, preserving the old "empty = no filter" behavior)
 * - an already-tree object → sanitized recursively (ids backfilled) */
export function migrateFilters(raw: unknown): FilterGroup | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    const conditions: FilterCondition[] = raw
      .filter(
        (f): f is { key: string; query: string } =>
          !!f && typeof (f as { key?: unknown }).key === "string" && typeof (f as { query?: unknown }).query === "string" && (f as { query: string }).query !== "",
      )
      .map((f) => ({ id: newFilterId(), columnId: f.key, operator: "contains" as const, value: f.query }));
    return conditions.length > 0 ? { id: newFilterId(), op: "and", conditions } : undefined;
  }
  if (typeof raw === "object" && "conditions" in (raw as object)) {
    const g = sanitizeGroup(raw as Record<string, unknown>);
    return g.conditions.length > 0 ? g : undefined;
  }
  return undefined;
}

function sanitizeGroup(g: Record<string, unknown>): FilterGroup {
  const conditions = Array.isArray(g.conditions)
    ? (g.conditions as unknown[]).map(sanitizeNode).filter((n): n is FilterCondition | FilterGroup => n !== null)
    : [];
  return { id: typeof g.id === "string" ? g.id : newFilterId(), op: g.op === "or" ? "or" : "and", conditions };
}

function sanitizeNode(n: unknown): FilterCondition | FilterGroup | null {
  if (!n || typeof n !== "object") return null;
  const o = n as Record<string, unknown>;
  if ("conditions" in o) return sanitizeGroup(o);
  if (typeof o.columnId === "string" && typeof o.operator === "string") {
    return {
      id: typeof o.id === "string" ? o.id : newFilterId(),
      columnId: o.columnId,
      operator: o.operator as FilterOperator,
      value: o.value,
    };
  }
  return null;
}

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
  /** Persistent filters of this view (nested AND/OR tree). Combined (AND)
   * with the database-level `DbSchema.filters` at evaluation time. */
  filters?: FilterGroup;
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
  /** Database-level filters applied to ALL views (combined AND with each
   * view's own filters). */
  filters?: FilterGroup;
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
      filters?: unknown;
    };
    const columns = Array.isArray(s.columns) ? (s.columns as DbColumn[]) : [];
    // Migrate each view's filters (legacy flat array → tree) tolerantly.
    const views =
      Array.isArray(s.views) && s.views.length > 0
        ? (s.views as DbView[]).map((v) => ({ ...v, filters: migrateFilters(v.filters) }))
        : [DEFAULT_VIEW];
    const filters = migrateFilters(s.filters);
    const rowOrder = Array.isArray(s.rowOrder) ? (s.rowOrder as string[]) : undefined;
    const calc =
      s.calc && typeof s.calc === "object" ? (s.calc as Record<string, string>) : undefined;
    const pageHidden = Array.isArray(s.pageHidden) ? (s.pageHidden as string[]) : undefined;
    // Backward-compat: old shape [{id,name}] → keep only the ids.
    const templates = Array.isArray(s.templates)
      ? (s.templates as unknown[]).map((t) => (typeof t === "string" ? t : ((t as { id?: string })?.id ?? ""))).filter(Boolean)
      : undefined;
    const defaultTemplate = typeof s.defaultTemplate === "string" ? s.defaultTemplate : undefined;
    return { columns, views, rowOrder, calc, pageHidden, templates, defaultTemplate, filters };
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
export const newFilterId = () => newId("f");
