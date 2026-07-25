/** Filter evaluation engine for database views. Pure + type-aware.
 *
 * The shapes (`FilterGroup`, `FilterCondition`, `FilterOperator`) and the
 * legacy-format migration live in `db.ts`. This module turns a filter tree
 * into a fast row predicate: each condition is compiled ONCE (value parsed,
 * column resolved, closure specialized), so the per-row hot path does no
 * `columns.find`, no re-parse, and short-circuits and/or. */

import type {
  ColumnType,
  DbColumn,
  FilterCondition,
  FilterGroup,
  FilterOperator,
  FilterRef,
  PropValues,
  Row,
} from "./db";
import { isFilterGroup, isFilterRef, parseDateValue } from "./db";

/** Sentinel column id for the row title (kept in sync with DatabaseView). */
export const TITLE_KEY = "__title";

/** Reads a cell value for a row/column. Overridable so callers can inject
 * computed columns (rollup/formula) and the title without touching props. */
export type GetValue = (row: Row, columnId: string) => unknown;

/** Default accessor: title for `__title`, otherwise the raw prop value. */
export const defaultGetValue: GetValue = (row, columnId) =>
  columnId === TITLE_KEY ? row.title : row.props[columnId];

/** A compiled predicate over a single row. */
export type FilterPredicate = (row: Row, getValue: GetValue) => boolean;

// ── value coercion helpers ────────────────────────────────────────────────

/** An option/relation element's string form (option string or `{name}`/id). */
function elementStr(x: unknown): string {
  if (typeof x === "string") return x;
  if (x && typeof x === "object") return String((x as { name?: unknown }).name ?? "");
  return String(x ?? "");
}

/** Flattens any cell value to a string (locale-neutral, for text operators). */
function cellStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map(elementStr).join(" ");
  if (typeof v === "object") {
    const d = parseDateValue(v);
    return d ? `${d.start}${d.end ? ` ${d.end}` : ""}` : "";
  }
  return String(v);
}

/** Numeric value of a cell, or null if not a finite number. */
function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** Day part ("YYYY-MM-DD") of a date cell, or null. */
function cellDay(v: unknown): string | null {
  const d = parseDateValue(v);
  return d ? d.start.slice(0, 10) : null;
}

/** True when the cell holds no meaningful value. */
function isEmpty(v: unknown): boolean {
  if (v == null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return parseDateValue(v) == null;
  return false;
}

/** `contains`: substring match against any array element (options/relation
 * titles) or the flattened cell. Empty needle matches everything. */
function containsVal(v: unknown, needle: string): boolean {
  if (needle === "") return true;
  if (Array.isArray(v)) return v.some((e) => elementStr(e).toLowerCase().includes(needle));
  return cellStr(v).toLowerCase().includes(needle);
}

/** `any_of`: cell intersects the selected set (array or scalar cell). */
function anyOf(v: unknown, set: string[] | null): boolean {
  if (!set || set.length === 0) return false;
  if (Array.isArray(v)) return v.some((e) => set.includes(elementStr(e).toLowerCase()));
  return set.includes(cellStr(v).toLowerCase());
}

// ── compilation ───────────────────────────────────────────────────────────

/** Compiles a leaf condition into a specialized row predicate. */
function compileCondition(cond: FilterCondition): FilterPredicate {
  const { columnId, operator, value } = cond;
  const needle = typeof value === "string" ? value.toLowerCase() : String(value ?? "").toLowerCase();
  const num = toNum(value);
  const day = value != null ? String(value).slice(0, 10) : "";
  const set = Array.isArray(value) ? value.map((x) => String(x).toLowerCase()) : null;

  switch (operator) {
    case "is_empty":
      return (r, gv) => isEmpty(gv(r, columnId));
    case "is_not_empty":
      return (r, gv) => !isEmpty(gv(r, columnId));
    case "contains":
      return (r, gv) => containsVal(gv(r, columnId), needle);
    case "not_contains":
      return (r, gv) => !containsVal(gv(r, columnId), needle);
    case "is":
      return (r, gv) => cellStr(gv(r, columnId)).toLowerCase() === needle;
    case "is_not":
      return (r, gv) => cellStr(gv(r, columnId)).toLowerCase() !== needle;
    case "starts_with":
      return (r, gv) => cellStr(gv(r, columnId)).toLowerCase().startsWith(needle);
    case "ends_with":
      return (r, gv) => cellStr(gv(r, columnId)).toLowerCase().endsWith(needle);
    case "eq":
      return (r, gv) => {
        const n = toNum(gv(r, columnId));
        return n != null && num != null && n === num;
      };
    case "neq":
      return (r, gv) => {
        if (num == null) return false;
        return toNum(gv(r, columnId)) !== num;
      };
    case "gt":
      return (r, gv) => {
        const n = toNum(gv(r, columnId));
        return n != null && num != null && n > num;
      };
    case "lt":
      return (r, gv) => {
        const n = toNum(gv(r, columnId));
        return n != null && num != null && n < num;
      };
    case "gte":
      return (r, gv) => {
        const n = toNum(gv(r, columnId));
        return n != null && num != null && n >= num;
      };
    case "lte":
      return (r, gv) => {
        const n = toNum(gv(r, columnId));
        return n != null && num != null && n <= num;
      };
    case "any_of":
      return (r, gv) => anyOf(gv(r, columnId), set);
    case "none_of":
      return (r, gv) => !anyOf(gv(r, columnId), set);
    case "is_checked":
      return (r, gv) => gv(r, columnId) === true;
    case "is_unchecked":
      return (r, gv) => gv(r, columnId) !== true;
    case "date_is":
      return (r, gv) => cellDay(gv(r, columnId)) === day;
    case "date_before":
      return (r, gv) => {
        const d = cellDay(gv(r, columnId));
        return d != null && d < day;
      };
    case "date_after":
      return (r, gv) => {
        const d = cellDay(gv(r, columnId));
        return d != null && d > day;
      };
    case "date_on_before":
      return (r, gv) => {
        const d = cellDay(gv(r, columnId));
        return d != null && d <= day;
      };
    case "date_on_after":
      return (r, gv) => {
        const d = cellDay(gv(r, columnId));
        return d != null && d >= day;
      };
    default:
      return () => true;
  }
}

/** Compiles a filter tree into a single row predicate (recursive, memo-friendly).
 * An empty group matches all rows. */
export function compileGroup(group: FilterGroup): FilterPredicate {
  const preds = group.conditions.map((node) =>
    isFilterGroup(node) ? compileGroup(node) : compileCondition(node),
  );
  if (preds.length === 0) return () => true;
  if (group.op === "or") return (r, gv) => preds.some((p) => p(r, gv));
  return (r, gv) => preds.every((p) => p(r, gv));
}

/** Combines the database-level and view-level filters (AND) into one predicate.
 * Either may be undefined; both undefined → matches all. */
export function compileFilters(
  dbFilter: FilterGroup | undefined,
  viewFilter: FilterGroup | undefined,
): FilterPredicate {
  const preds = [dbFilter, viewFilter].filter((g): g is FilterGroup => !!g).map(compileGroup);
  if (preds.length === 0) return () => true;
  return (r, gv) => preds.every((p) => p(r, gv));
}

/** Filters rows against a compiled or raw filter tree. Convenience wrapper. */
export function filterRows(
  rows: Row[],
  dbFilter: FilterGroup | undefined,
  viewFilter: FilterGroup | undefined,
  getValue: GetValue = defaultGetValue,
): Row[] {
  const pred = compileFilters(dbFilter, viewFilter);
  return rows.filter((r) => pred(r, getValue));
}

// ── dynamic values (host page reference) ───────────────────────────────────

/** The host page a linked-database block is embedded in: its property values,
 * the parent database's columns (to map/label refs), and its title. */
export type HostContext = { props: PropValues; columns: DbColumn[]; title: string | null };

/** Resolves a dynamic reference against the host page. */
function resolveValue(ref: FilterRef, host: HostContext): unknown {
  return ref.ref === "title" ? (host.title ?? "") : host.props[ref.columnId];
}

/** Replaces dynamic `{ref}` condition values with the host page's actual value.
 * Without a host (e.g. viewing the source database directly), dynamic
 * conditions are dropped so they never hide everything. */
export function resolveFilters(
  group: FilterGroup | undefined,
  host: HostContext | undefined,
): FilterGroup | undefined {
  if (!group) return undefined;
  const walk = (g: FilterGroup): FilterGroup => ({
    ...g,
    conditions: g.conditions
      .map((node) => {
        if (isFilterGroup(node)) return walk(node);
        if (isFilterRef(node.value)) return host ? { ...node, value: resolveValue(node.value, host) } : null;
        return node;
      })
      .filter((n): n is FilterCondition | FilterGroup => n !== null),
  });
  return walk(group);
}

// ── operator catalog (per column type) ─────────────────────────────────────

const TEXT_OPS: FilterOperator[] = [
  "contains",
  "not_contains",
  "is",
  "is_not",
  "starts_with",
  "ends_with",
  "is_empty",
  "is_not_empty",
];
const NUMBER_OPS: FilterOperator[] = ["eq", "neq", "gt", "lt", "gte", "lte", "is_empty", "is_not_empty"];
const SELECT_OPS: FilterOperator[] = ["is", "is_not", "any_of", "none_of", "is_empty", "is_not_empty"];
const MULTI_OPS: FilterOperator[] = ["contains", "not_contains", "any_of", "none_of", "is_empty", "is_not_empty"];
const CHECKBOX_OPS: FilterOperator[] = ["is_checked", "is_unchecked"];
const DATE_OPS: FilterOperator[] = [
  "date_is",
  "date_before",
  "date_after",
  "date_on_before",
  "date_on_after",
  "is_empty",
  "is_not_empty",
];
const EMPTY_ONLY_OPS: FilterOperator[] = ["is_empty", "is_not_empty"];

/** Operators offered for a column type, in menu order. */
export function operatorsForType(type: ColumnType): FilterOperator[] {
  switch (type) {
    case "number":
      return NUMBER_OPS;
    case "checkbox":
      return CHECKBOX_OPS;
    case "select":
    case "status":
      return SELECT_OPS;
    case "multiselect":
    case "relation":
      return MULTI_OPS;
    case "date":
    case "created_time":
    case "last_edited_time":
      return DATE_OPS;
    case "files":
      return EMPTY_ONLY_OPS;
    case "text":
    case "phone":
    case "email":
    case "url":
    case "created_by":
    case "last_edited_by":
    case "rollup":
    case "formula":
      return TEXT_OPS;
    default:
      return TEXT_OPS;
  }
}

/** Whether an operator needs a value input (false for empty/checkbox ops). */
export function operatorHasValue(op: FilterOperator): boolean {
  return op !== "is_empty" && op !== "is_not_empty" && op !== "is_checked" && op !== "is_unchecked";
}

/** Default operator for a column type (first in its list). */
export function defaultOperator(type: ColumnType): FilterOperator {
  return operatorsForType(type)[0];
}

/** Whether a column type filters on a set of options (multi-value input). */
export function operatorTakesSet(op: FilterOperator): boolean {
  return op === "any_of" || op === "none_of";
}

/** Convenience for the UI: the column ids (+ title) that are filterable. */
export function isFilterableColumn(col: DbColumn): boolean {
  return operatorsForType(col.type).length > 0;
}
