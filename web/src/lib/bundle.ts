//! Multi-database bundle (ZIP) export/import — the reverse of a single-table CSV,
//! for a whole relation graph. Export walks the transitive closure of relation
//! columns from a root database and writes one CSV per database plus a
//! `manifest.json` carrying the schemas (types, relationDb, options, views) — a
//! plain CSV alone cannot reconstruct those. Import re-creates every database,
//! remaps relation targets (old ids → new ids) and re-links relations by title
//! within the imported set.
//!
//! Databases only: no editor page bodies, no file blobs. All writes go through
//! the plain item API (schema/properties are opaque JSON) — no CRDT.

import {
  createDatabase,
  createItem,
  getItem,
  listRows,
  patchItem,
  updateProperties,
  updateSchema,
  type RowMeta,
} from "@/lib/api";
import { parseSchema, type ColumnType, type DbColumn, type DbSchema, type PropValues } from "@/lib/db";
import { dbRowsToCsv, downloadBlob, safeName } from "@/lib/export";
import { coerceCell } from "@/lib/csvImport";
import { parseCsv } from "@/lib/csv";
import { unzip, zipStore, type ZipEntry } from "@/lib/zip";

const norm = (s: string): string => s.trim().toLowerCase();

const BUNDLE_VERSION = 1;

/** A column whose value is stored (importable/exportable). Computed, meta and
 * file columns are excluded (files are not bundled); relation columns ARE stored
 * (exported/imported as linked-row titles). */
function isStoredColumn(c: DbColumn): boolean {
  return (
    c.type !== "formula" &&
    c.type !== "rollup" &&
    c.type !== "files" &&
    c.type !== "created_time" &&
    c.type !== "created_by" &&
    c.type !== "last_edited_time" &&
    c.type !== "last_edited_by"
  );
}

/** Columns written to a database's CSV: stored values only. */
function dataColumns(schema: DbSchema): DbColumn[] {
  return schema.columns.filter(isStoredColumn);
}

type ManifestDb = { id: string; title: string; schema: DbSchema; csv: string };
type Manifest = { version: number; app: string; root: string; dbs: ManifestDb[] };

/** Exports a database and the transitive closure of its relations as a ZIP:
 * one CSV per database + a manifest.json with the schemas. */
export async function exportDbBundle(rootId: string): Promise<void> {
  type Loaded = { id: string; title: string; schema: DbSchema; rows: RowMeta[] };
  const loaded = new Map<string, Loaded>();
  const rootMeta = await getItem(rootId);
  const queue = [rootId];

  // BFS over relationDb edges.
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (loaded.has(id)) continue;
    const meta = id === rootId ? rootMeta : await getItem(id);
    if (meta.db_schema == null) continue; // not a database — skip
    const schema = parseSchema(meta.db_schema);
    const templates = new Set(schema.templates ?? []);
    const rows = (await listRows(id)).filter((r) => !templates.has(r.id));
    loaded.set(id, { id, title: meta.title ?? "", schema, rows });
    for (const c of schema.columns) {
      if (c.type === "relation" && c.relationDb && !loaded.has(c.relationDb)) queue.push(c.relationDb);
    }
  }

  // Global id → title map for relation export across every loaded database.
  const linkTitles = new Map<string, string>();
  for (const db of loaded.values()) for (const r of db.rows) if (r.title) linkTitles.set(r.id, r.title);

  const dbs: ManifestDb[] = [];
  const files: ZipEntry[] = [];
  let idx = 0;
  for (const db of loaded.values()) {
    idx++;
    const csvName = `db-${idx}-${safeName(db.title)}.csv`;
    files.push({ name: csvName, text: dbRowsToCsv(dataColumns(db.schema), db.rows, linkTitles) });
    dbs.push({ id: db.id, title: db.title, schema: db.schema, csv: csvName });
  }
  const manifest: Manifest = { version: BUNDLE_VERSION, app: "bramblekeep", root: rootId, dbs };
  files.unshift({ name: "manifest.json", text: JSON.stringify(manifest, null, 2) });

  downloadBlob(`${safeName(rootMeta.title)}.bundle.zip`, zipStore(files));
}

export type BundleImportResult = { dbs: number; rows: number; rootId: string | null };

/** Imports a bundle ZIP: re-creates every database (fresh ids), remaps relation
 * targets and re-links relations by title. `parentId` optionally nests the new
 * databases under a page. Returns counts + the new root database id. */
export async function importDbBundle(file: File, parentId?: string): Promise<BundleImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = unzip(bytes);
  const manifestEntry = entries.find((e) => e.name === "manifest.json");
  if (!manifestEntry) throw new Error("bundle: manifest.json missing");
  const manifest = JSON.parse(manifestEntry.text) as Manifest;
  const csvByName = new Map(entries.map((e) => [e.name, e.text]));

  // Phase 0: create every database (empty), record old → new ids.
  const dbIdMap = new Map<string, string>();
  for (const d of manifest.dbs) dbIdMap.set(d.id, await createDatabase(parentId));

  // Phase 1: write remapped schemas (relationDb → new ids; drop volatile refs
  // that point at old row/child ids: rowOrder, templates, defaultTemplate).
  for (const d of manifest.dbs) {
    const newId = dbIdMap.get(d.id) as string;
    const columns = d.schema.columns.map((c) => {
      if (c.type !== "relation" || !c.relationDb) return { ...c };
      const remapped = dbIdMap.get(c.relationDb);
      // Drop the target if it points outside the bundle.
      return { ...c, relationDb: remapped, relationReciprocal: remapped ? c.relationReciprocal : undefined };
    });
    const schema: DbSchema = {
      ...d.schema,
      columns,
      rowOrder: undefined,
      templates: undefined,
      defaultTemplate: undefined,
    };
    await updateSchema(newId, JSON.stringify(schema));
  }

  // Phase 2: create rows (non-relation props + title), record title → new row id.
  type Pending = { newRowId: string; props: PropValues; relCells: Map<string, string> };
  const perDb = new Map<string, { titleToId: Map<string, string>; pending: Pending[] }>();
  let rowCount = 0;

  for (const d of manifest.dbs) {
    const newId = dbIdMap.get(d.id) as string;
    const grid = parseCsv(csvByName.get(d.csv) ?? "");
    const headers = (grid[0] ?? []).map((h) => h.trim());
    const dataRows = grid.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
    const byName = new Map(d.schema.columns.map((c) => [norm(c.name), c]));

    // Status defaults for status columns not present as a CSV header.
    const headerNames = new Set(headers.slice(1).map(norm));
    const statusDefaults: PropValues = {};
    for (const c of d.schema.columns) {
      if (c.type === "status" && c.defaultOption && !headerNames.has(norm(c.name))) {
        statusDefaults[c.id] = c.defaultOption;
      }
    }

    const titleToId = new Map<string, string>();
    const pending: Pending[] = [];
    for (const r of dataRows) {
      const props: PropValues = { ...statusDefaults };
      const relCells = new Map<string, string>();
      let title = "";
      for (let i = 0; i < headers.length; i++) {
        const cell = r[i] ?? "";
        if (i === 0) {
          title = cell.trim();
          continue;
        }
        const col = byName.get(norm(headers[i]));
        if (!col) continue;
        if (col.type === "relation") {
          relCells.set(col.id, cell);
          continue;
        }
        const v = coerceCell(col.type, cell);
        if (v !== undefined) props[col.id] = v;
      }
      const newRowId = await createItem(newId);
      if (title) {
        await patchItem(newRowId, { title });
        if (!titleToId.has(norm(title))) titleToId.set(norm(title), newRowId);
      }
      pending.push({ newRowId, props, relCells });
      rowCount++;
    }
    perDb.set(d.id, { titleToId, pending });
  }

  // Phase 3: resolve relation titles → new row ids (using the TARGET database's
  // map), merge into props, write once per row.
  for (const d of manifest.dbs) {
    const state = perDb.get(d.id);
    if (!state) continue;
    const colById = new Map(d.schema.columns.map((c) => [c.id, c]));
    for (const p of state.pending) {
      for (const [colId, cell] of p.relCells) {
        const col = colById.get(colId);
        if (!col || col.type !== "relation" || !col.relationDb) continue;
        const target = perDb.get(col.relationDb);
        if (!target) continue; // relation points outside the bundle
        const ids = cell
          .split(",")
          .map((s) => target.titleToId.get(norm(s.trim())))
          .filter((x): x is string => x !== undefined);
        if (ids.length > 0) p.props[colId] = ids;
      }
      if (Object.keys(p.props).length > 0) await updateProperties(p.newRowId, JSON.stringify(p.props));
    }
  }

  return { dbs: manifest.dbs.length, rows: rowCount, rootId: dbIdMap.get(manifest.root) ?? null };
}

// ── Merge import: root INTO an existing database ────────────────────────────
//
// The `+ add` flavour above re-creates EVERY database (root included) as a new
// item. This flavour is triggered from a database's own Options menu: the
// bundle's ROOT table is MERGED into that current database (its rows appended,
// its columns matched by name / added — like a CSV import), while the related
// tables are still created as fresh databases alongside it. A preview is
// computed first (`planBundleImport`) and shown for confirmation before any
// write (`applyBundleImport`).

/** Number of non-empty data rows in a CSV (excludes the header). */
function csvRowCount(text: string): number {
  const grid = parseCsv(text);
  return grid.slice(1).filter((r) => r.some((c) => c.trim() !== "")).length;
}

export type ParsedBundle = { manifest: Manifest; csvByName: Map<string, string> };

/** Parses a bundle ZIP into its manifest + CSVs. No writes. */
export function readBundle(bytes: Uint8Array): ParsedBundle {
  const entries = unzip(bytes);
  const manifestEntry = entries.find((e) => e.name === "manifest.json");
  if (!manifestEntry) throw new Error("bundle: manifest.json missing");
  const manifest = JSON.parse(manifestEntry.text) as Manifest;
  const csvByName = new Map(entries.map((e) => [e.name, e.text]));
  return { manifest, csvByName };
}

/** A dry-run description of a merge import, shown for confirmation. Pure: no I/O,
 * no writes — computed from the parsed bundle and the target database's schema. */
export type BundleImportPlan = {
  manifest: Manifest;
  csvByName: Map<string, string>;
  /** Title of the bundle's root table (the one merged into the current db). */
  rootTitle: string;
  /** Rows that would be appended to the current database. */
  rootRowCount: number;
  /** Root columns with no name match in the current db — they would be added. */
  addedColumns: { name: string; type: ColumnType }[];
  /** Root columns matched onto an existing column of the current db (by name). */
  reusedColumnNames: string[];
  /** Related tables that would be created as fresh databases. */
  linkedDbs: { title: string; rowCount: number }[];
};

/** Computes what a merge import would do to `currentSchema`, without any write:
 * which root columns reuse an existing column (matched by name) vs. get added,
 * and the related databases that would be created fresh. Throws if the bundle
 * has no root database. */
export function planBundleImport(
  currentSchema: DbSchema,
  { manifest, csvByName }: ParsedBundle,
): BundleImportPlan {
  const root = manifest.dbs.find((d) => d.id === manifest.root);
  if (!root) throw new Error("bundle: root database missing from manifest");

  const existingByName = new Set(currentSchema.columns.map((c) => norm(c.name)));
  const addedColumns: { name: string; type: ColumnType }[] = [];
  const reusedColumnNames: string[] = [];
  for (const c of dataColumns(root.schema)) {
    if (existingByName.has(norm(c.name))) reusedColumnNames.push(c.name);
    else addedColumns.push({ name: c.name, type: c.type });
  }

  const linkedDbs = manifest.dbs
    .filter((d) => d.id !== manifest.root)
    .map((d) => ({ title: d.title, rowCount: csvRowCount(csvByName.get(d.csv) ?? "") }));

  return {
    manifest,
    csvByName,
    rootTitle: root.title,
    rootRowCount: csvRowCount(csvByName.get(root.csv) ?? ""),
    addedColumns,
    reusedColumnNames,
    linkedDbs,
  };
}

/** Applies a merge import: the root table is merged into `currentDbId` (rows
 * appended, columns matched by name or added — existing rows untouched); the
 * related tables are created as fresh databases parented alongside the current
 * one. Relations are re-linked by title across the whole imported set (the root
 * side pointing at the freshly created tables, and back). Returns the count of
 * NEW databases created and rows written.
 *
 * Limitation: a root column whose name collides with an existing column of the
 * current db always reuses that column (its type wins). If the existing column
 * is not a relation but the root column is, that relation is not imported. */
export async function applyBundleImport(
  currentDbId: string,
  { manifest, csvByName }: ParsedBundle,
): Promise<BundleImportResult> {
  const currentMeta = await getItem(currentDbId);
  const currentSchema = parseSchema(currentMeta.db_schema);
  // Related tables land next to the current database (same parent page).
  const linkedParent = currentMeta.parent_item_id ?? undefined;

  // old → new db id. Root reuses the current database; others are fresh.
  const dbIdMap = new Map<string, string>();
  for (const d of manifest.dbs) {
    dbIdMap.set(d.id, d.id === manifest.root ? currentDbId : await createDatabase(linkedParent));
  }

  // Effective schema per source db: column ids are the REAL write targets, and
  // column names drive CSV-header matching.
  const effective = new Map<string, DbSchema>();

  for (const d of manifest.dbs) {
    const newId = dbIdMap.get(d.id) as string;
    // Remap relation targets to the new db ids; drop out-of-bundle targets.
    const remapped = d.schema.columns.map((c) => {
      if (c.type !== "relation" || !c.relationDb) return { ...c };
      const target = dbIdMap.get(c.relationDb);
      return { ...c, relationDb: target, relationReciprocal: target ? c.relationReciprocal : undefined };
    });

    if (d.id === manifest.root) {
      // Merge remapped root columns INTO the current schema: a name match reuses
      // the existing column (its type wins, values coerced); otherwise the root
      // column is appended (keeping its id). Existing rows/order are untouched.
      const columns = currentSchema.columns.map((c) => ({ ...c }));
      const byName = new Map(columns.map((c) => [norm(c.name), c]));
      for (const rc of remapped) {
        if (!isStoredColumn(rc)) continue;
        if (byName.has(norm(rc.name))) continue;
        const col = { ...rc };
        columns.push(col);
        byName.set(norm(col.name), col);
      }
      const merged: DbSchema = { ...currentSchema, columns };
      await updateSchema(currentDbId, JSON.stringify(merged));
      effective.set(d.id, merged);
    } else {
      const schema: DbSchema = {
        ...d.schema,
        columns: remapped,
        rowOrder: undefined,
        templates: undefined,
        defaultTemplate: undefined,
      };
      await updateSchema(newId, JSON.stringify(schema));
      effective.set(d.id, schema);
    }
  }

  // Phase 2: create rows (non-relation props + title), record title → new row id.
  // The root's rows are appended to the current database; only these new rows go
  // into the title map (existing current rows are not part of the relation set).
  type Pending = { newRowId: string; props: PropValues; relCells: Map<string, string> };
  const perDb = new Map<string, { titleToId: Map<string, string>; pending: Pending[] }>();
  let rowCount = 0;

  for (const d of manifest.dbs) {
    const newId = dbIdMap.get(d.id) as string;
    const schema = effective.get(d.id) as DbSchema;
    const grid = parseCsv(csvByName.get(d.csv) ?? "");
    const headers = (grid[0] ?? []).map((h) => h.trim());
    const dataRows = grid.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
    const byName = new Map(schema.columns.map((c) => [norm(c.name), c]));

    // Status defaults for status columns not present as a CSV header.
    const headerNames = new Set(headers.slice(1).map(norm));
    const statusDefaults: PropValues = {};
    for (const c of schema.columns) {
      if (c.type === "status" && c.defaultOption && !headerNames.has(norm(c.name))) {
        statusDefaults[c.id] = c.defaultOption;
      }
    }

    const titleToId = new Map<string, string>();
    const pending: Pending[] = [];
    for (const r of dataRows) {
      const props: PropValues = { ...statusDefaults };
      const relCells = new Map<string, string>();
      let title = "";
      for (let i = 0; i < headers.length; i++) {
        const cell = r[i] ?? "";
        if (i === 0) {
          title = cell.trim();
          continue;
        }
        const col = byName.get(norm(headers[i]));
        if (!col) continue;
        if (col.type === "relation") {
          relCells.set(col.id, cell);
          continue;
        }
        const v = coerceCell(col.type, cell);
        if (v !== undefined) props[col.id] = v;
      }
      const newRowId = await createItem(newId);
      if (title) {
        await patchItem(newRowId, { title });
        if (!titleToId.has(norm(title))) titleToId.set(norm(title), newRowId);
      }
      pending.push({ newRowId, props, relCells });
      rowCount++;
    }
    perDb.set(d.id, { titleToId, pending });
  }

  // Phase 3: resolve relation titles → new row ids (target db's map), write once.
  for (const d of manifest.dbs) {
    const state = perDb.get(d.id);
    if (!state) continue;
    const schema = effective.get(d.id) as DbSchema;
    const colById = new Map(schema.columns.map((c) => [c.id, c]));
    for (const p of state.pending) {
      for (const [colId, cell] of p.relCells) {
        const col = colById.get(colId);
        if (!col || col.type !== "relation" || !col.relationDb) continue;
        // Find the source db whose new id is this column's target.
        let target: { titleToId: Map<string, string> } | undefined;
        for (const [oldId, newId] of dbIdMap) {
          if (newId === col.relationDb) {
            target = perDb.get(oldId);
            break;
          }
        }
        if (!target) continue; // relation points outside the bundle
        const ids = cell
          .split(",")
          .map((s) => target.titleToId.get(norm(s.trim())))
          .filter((x): x is string => x !== undefined);
        if (ids.length > 0) p.props[colId] = ids;
      }
      if (Object.keys(p.props).length > 0) await updateProperties(p.newRowId, JSON.stringify(p.props));
    }
  }

  // Count only the NEW databases created (root reuses the current one).
  return {
    dbs: manifest.dbs.length - 1,
    rows: rowCount,
    rootId: currentDbId,
  };
}
