//! CSV → database import (reverse of `exportCsv`). Merges rows into an EXISTING
//! database item: maps each CSV header to a column (existing match, a new
//! inferred column, the row title, or ignored), infers types for new columns,
//! coerces cells to stored property values, and creates one child item per row.
//!
//! Additive only: existing rows are never touched, existing columns keep their
//! type (values are coerced to it). All writes go through the plain item PATCH
//! API (schema/properties are opaque JSON) — no CRDT is involved, since a
//! database row is an ordinary child item, not editor content.

import {
  newColumnId,
  parseProps,
  STATUS_GROUPS,
  type ColumnType,
  type DbColumn,
  type DbSchema,
  type PropValues,
} from "@/lib/db";
import { createItem, getItem, listRows, patchItem, updateProperties, updateSchema } from "@/lib/api";
import { parseCsv } from "@/lib/csv";

const norm = (s: string): string => s.trim().toLowerCase();

/** Truthy tokens for a checkbox cell (FR/EN + common markers). */
const TRUE_TOKENS = new Set(["oui", "yes", "true", "vrai", "1", "x", "✓", "☑", "on"]);
/** Falsy tokens (checkbox); the empty string is handled separately. */
const FALSE_TOKENS = new Set(["non", "no", "false", "faux", "0", "☐", "off"]);
/** Tokens that make a column look boolean (used for type inference). */
const BOOL_TOKENS = new Set([...TRUE_TOKENS, ...FALSE_TOKENS]);

const NUMBER_RE = /^-?\d+(?:[.,]\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
const PHONE_RE = /^[+(]?\d[\d\s().-]{5,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
/** Splits a date-range cell ("start → end", also `->`, en/em dash). */
const DATE_RANGE_RE = /\s*(?:→|->|—|–)\s*/;

/** Header names (normalized) that default to the row title on import. */
const TITLE_NAMES = new Set(["nom", "name", "titre", "title"]);

/** Column types that cannot receive an imported value (computed / meta / files).
 * `relation` IS importable — handled specially (titles resolved to linked ids). */
const NON_IMPORTABLE: ReadonlySet<ColumnType> = new Set<ColumnType>([
  "formula",
  "rollup",
  "files",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
]);

/** Columns of an existing schema that a CSV header may be mapped onto. */
export function importableColumns(schema: DbSchema): DbColumn[] {
  return schema.columns.filter((c) => !NON_IMPORTABLE.has(c.type));
}

/** How one CSV header is imported. */
export type HeaderMapping =
  | { kind: "title" }
  | { kind: "ignore" }
  | { kind: "existing"; columnId: string }
  | { kind: "new"; name: string; type: ColumnType };

/** A parsed CSV + the proposed mapping (one entry per header), editable in the
 * dialog before applying. */
export type ImportPreview = {
  headers: string[];
  rows: string[][];
  mappings: HeaderMapping[];
};

/** Infers a column type from its (trimmed, non-empty) values. Order matters:
 * the most specific type that ALL values satisfy wins. Falls back to text. */
export function inferType(values: string[]): ColumnType {
  const vals = values.map((v) => v.trim()).filter((v) => v !== "");
  if (vals.length === 0) return "text";
  const every = (re: RegExp): boolean => vals.every((v) => re.test(v));

  if (vals.every((v) => BOOL_TOKENS.has(norm(v)))) return "checkbox";
  if (every(NUMBER_RE)) return "number";
  if (every(DATE_RE)) return "date";
  if (every(EMAIL_RE)) return "email";
  if (every(URL_RE)) return "url";
  if (every(PHONE_RE)) return "phone";

  // Comma-bearing categorical values → multiselect.
  const withComma = vals.filter((v) => v.includes(",")).length;
  if (withComma >= Math.max(1, vals.length * 0.3)) return "multiselect";

  // Few distinct values relative to the row count → single select.
  const distinct = new Set(vals);
  const cap = Math.max(1, Math.min(20, Math.floor(vals.length / 2)));
  if (distinct.size <= cap && distinct.size < vals.length) return "select";

  return "text";
}

/** Coerces a raw CSV cell to the value stored for the given column type.
 * Returns `undefined` when the cell is empty or the type is not importable. */
export function coerceCell(type: ColumnType, raw: string): unknown {
  const s = raw.trim();
  switch (type) {
    case "number": {
      if (s === "") return undefined;
      const n = Number(s.replace(",", "."));
      return Number.isFinite(n) ? n : undefined;
    }
    case "checkbox":
      return s === "" ? undefined : TRUE_TOKENS.has(norm(s));
    case "date": {
      if (s === "") return undefined;
      const [start, end] = s.split(DATE_RANGE_RE);
      const st = start?.trim();
      if (!st) return undefined;
      const et = end?.trim();
      // Bare string when there is no end, matching the stored date shape.
      return et ? { start: st, end: et } : st;
    }
    case "multiselect":
      if (s === "") return undefined;
      return s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    case "text":
    case "select":
    case "status":
    case "email":
    case "url":
    case "phone":
      return s === "" ? undefined : s;
    default:
      return undefined; // files / relation / rollup / formula / meta
  }
}

/** Builds the initial preview + auto-mapping from CSV text and the target
 * database schema. First header named like a title (or, failing that, the first
 * header) becomes the row title; a header matching an existing column name maps
 * onto it; otherwise a new column with an inferred type is proposed. */
export function buildPreview(text: string, schema: DbSchema): ImportPreview {
  const grid = parseCsv(text);
  const headers = (grid[0] ?? []).map((h) => h.trim());
  const rows = grid.slice(1).filter((r) => r.some((c) => c.trim() !== ""));

  const byName = new Map(schema.columns.map((c) => [norm(c.name), c]));
  const importableIds = new Set(importableColumns(schema).map((c) => c.id));
  let titleIdx = headers.findIndex((h) => TITLE_NAMES.has(norm(h)));
  if (titleIdx < 0 && headers.length > 0) titleIdx = 0;

  const mappings: HeaderMapping[] = headers.map((h, i) => {
    if (i === titleIdx) return { kind: "title" };
    const match = byName.get(norm(h));
    // Matches an existing column: map onto it if writable, else ignore
    // (relation/files/computed can't be reconstructed from the exported text).
    if (match) {
      return importableIds.has(match.id) ? { kind: "existing", columnId: match.id } : { kind: "ignore" };
    }
    const colVals = rows.map((r) => r[i] ?? "");
    return { kind: "new", name: h || `Column ${i + 1}`, type: inferType(colVals) };
  });

  return { headers, rows, mappings };
}

export type ImportResult = { created: number };

/** Applies the preview to the database: persists any new columns / options,
 * then creates one child item (row) per CSV line. Returns the row count.
 * Rows are created sequentially so their creation order (UUIDv7) matches the
 * CSV order. */
export async function applyImport(
  dbId: string,
  schema: DbSchema,
  preview: ImportPreview,
): Promise<ImportResult> {
  const { headers, rows, mappings } = preview;

  // 1. Resolve the target column of each header (creating new columns).
  const columns = schema.columns.map((c) => ({ ...c }));
  const byId = new Map(columns.map((c) => [c.id, c]));
  const targetColId: (string | null)[] = [];
  const isTitle: boolean[] = [];

  for (let i = 0; i < headers.length; i++) {
    const m = mappings[i];
    if (m.kind === "title") {
      isTitle.push(true);
      targetColId.push(null);
      continue;
    }
    isTitle.push(false);
    if (m.kind === "ignore") {
      targetColId.push(null);
    } else if (m.kind === "existing") {
      targetColId.push(byId.has(m.columnId) ? m.columnId : null);
    } else {
      const col: DbColumn = { id: newColumnId(), name: m.name, type: m.type };
      columns.push(col);
      byId.set(col.id, col);
      targetColId.push(col.id);
    }
  }

  // 2. Merge select/multiselect/status options discovered in the data.
  for (let i = 0; i < headers.length; i++) {
    const colId = targetColId[i];
    if (!colId) continue;
    const col = byId.get(colId);
    if (!col) continue;
    if (col.type !== "select" && col.type !== "multiselect" && col.type !== "status") continue;
    const opts = new Set(col.options ?? []);
    for (const r of rows) {
      const v = coerceCell(col.type, r[i] ?? "");
      if (Array.isArray(v)) for (const x of v) opts.add(String(x));
      else if (typeof v === "string" && v) opts.add(v);
    }
    col.options = [...opts];
    if (col.type === "status") {
      const groups = { ...(col.optionGroups ?? {}) };
      for (const o of col.options) if (!groups[o]) groups[o] = STATUS_GROUPS[0].id;
      col.optionGroups = groups;
      if (!col.defaultOption && col.options.length > 0) col.defaultOption = col.options[0];
    }
  }

  // 3. Persist the schema (new columns / options); other fields untouched.
  await updateSchema(dbId, JSON.stringify({ ...schema, columns }));

  // 4. Status defaults for columns NOT provided by the CSV (mirrors addRow).
  const provided = new Set(targetColId.filter((x): x is string => x !== null));
  const statusDefaults: PropValues = {};
  for (const c of columns) {
    if (c.type === "status" && c.defaultOption && !provided.has(c.id)) {
      statusDefaults[c.id] = c.defaultOption;
    }
  }

  // 4b. Relation resolvers: for each mapped relation column, a title → linked-row
  // id map (of its target database) so exported titles can be re-linked. Titles
  // with no match are dropped. Duplicate target titles: first row wins.
  type RelResolver = { titleToId: Map<string, string>; bidir: boolean; recId?: string };
  const relByCol = new Map<string, RelResolver>();
  for (const colId of provided) {
    const col = byId.get(colId);
    if (!col || col.type !== "relation" || !col.relationDb) continue;
    const titleToId = new Map<string, string>();
    for (const row of await listRows(col.relationDb)) {
      const k = row.title ? norm(row.title) : "";
      if (k && !titleToId.has(k)) titleToId.set(k, row.id);
    }
    relByCol.set(colId, {
      titleToId,
      bidir: !!col.relationBidirectional,
      recId: col.relationReciprocal,
    });
  }

  // 5. Create one row per CSV line.
  let created = 0;
  for (const r of rows) {
    const props: PropValues = { ...statusDefaults };
    let title = "";
    for (let i = 0; i < headers.length; i++) {
      const cell = r[i] ?? "";
      if (isTitle[i]) {
        title = cell.trim();
        continue;
      }
      const colId = targetColId[i];
      if (!colId) continue;
      const col = byId.get(colId);
      if (!col) continue;
      if (col.type === "relation") {
        const res = relByCol.get(colId);
        if (!res) continue;
        const ids = cell
          .split(",")
          .map((s) => res.titleToId.get(norm(s.trim())))
          .filter((x): x is string => x !== undefined);
        if (ids.length > 0) props[colId] = ids;
        continue;
      }
      const v = coerceCell(col.type, cell);
      if (v !== undefined) props[colId] = v;
    }
    const id = await createItem(dbId);
    if (Object.keys(props).length > 0) await updateProperties(id, JSON.stringify(props));
    if (title) await patchItem(id, { title });

    // Mirror bidirectional relations into the linked rows (best-effort).
    for (const [colId, res] of relByCol) {
      const recId = res.recId;
      if (!res.bidir || !recId) continue;
      const ids = props[colId];
      if (!Array.isArray(ids)) continue;
      for (const targetId of ids as string[]) {
        try {
          const item = await getItem(targetId);
          const tProps = parseProps(item.properties);
          const cur = Array.isArray(tProps[recId]) ? (tProps[recId] as string[]) : [];
          if (!cur.includes(id)) {
            await updateProperties(targetId, JSON.stringify({ ...tProps, [recId]: [...cur, id] }));
          }
        } catch {
          // A single mirror failure must not abort the whole import.
        }
      }
    }
    created++;
  }

  return { created };
}
