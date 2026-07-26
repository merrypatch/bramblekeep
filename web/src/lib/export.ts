//! Exports a page's data: Markdown (editor content) and CSV (database rows).
//! Pure on the format side; triggering the download lives here too.

import { type BlockNode, getBlocks, getItem, listRows } from "@/lib/api";
import { type DbColumn, META_TYPES, parseDateValue, parseProps, parseSchema, type PropValues } from "@/lib/db";
import { countTasks, type TaskTreeNode, taskPercent } from "@/lib/taskProgress";
import i18n from "@/i18n";

/** Triggers the download of a text file in the browser. */
export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Triggers the download of a Blob (e.g. a zip archive). */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Safe filename derived from a title. */
export function safeName(title: string | null | undefined): string {
  return (title || "export").replace(/[^\p{L}\p{N}\-_ ]/gu, "").trim().slice(0, 60) || "export";
}

const textOf = (props: Record<string, unknown> | null): string =>
  props && typeof props.text === "string" ? props.text : "";

/** Converts the blocks (projection) to Markdown, respecting nesting. */
function blocksToMarkdown(blocks: BlockNode[]): string {
  const byParent = new Map<string | null, BlockNode[]>();
  for (const b of blocks) {
    const k = b.parent_id ?? null;
    (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(b);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.seq - b.seq);

  // Nested view of the same blocks, for the `taskProgress` count (which needs
  // siblings + descendants, not the flat projection).
  const toTree = (parent: string | null): TaskTreeNode[] =>
    (byParent.get(parent) ?? []).map((b) => ({
      id: b.id,
      type: b.type,
      props: b.props,
      children: toTree(b.id),
    }));
  const tree = toTree(null);

  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const b of byParent.get(parent) ?? []) {
      const indent = "  ".repeat(depth);
      const t = textOf(b.props);
      switch (b.type) {
        case "heading": {
          const lvl = Math.min(6, Math.max(1, Number((b.props as { level?: number })?.level) || 1));
          lines.push(`${"#".repeat(lvl)} ${t}`);
          break;
        }
        case "bulletListItem":
          lines.push(`${indent}- ${t}`);
          break;
        case "numberedListItem":
          lines.push(`${indent}1. ${t}`);
          break;
        case "checkListItem":
          lines.push(`${indent}- [${(b.props as { checked?: boolean })?.checked ? "x" : " "}] ${t}`);
          break;
        case "quote":
          lines.push(`> ${t}`);
          break;
        case "codeBlock":
          lines.push("```", t, "```");
          break;
        case "page":
        case "dbview":
          lines.push(`${indent}- ${t || i18n.t("common.subItem")}`);
          break;
        case "embed": {
          // The projection keeps the media/embed `url`: export the source link
          // rather than losing the block silently.
          const url = (b.props as { url?: unknown })?.url;
          if (typeof url === "string" && url) lines.push(`${indent}${url}`);
          break;
        }
        case "taskProgress": {
          const scope = (b.props as { scope?: unknown })?.scope === "page" ? "page" : "next";
          const c = countTasks(tree, b.id, scope);
          lines.push(`${indent}**${taskPercent(c)}% — ${c.done}/${c.total}**`);
          break;
        }
        default:
          if (t) lines.push(`${indent}${t}`);
      }
      walk(b.id, b.type.endsWith("ListItem") ? depth + 1 : depth);
    }
  };
  walk(null, 0);
  return lines.join("\n\n").replace(/\n\n(\s*(-|1\.|>|- \[))/g, "\n$1");
}

/** Exports a page's Markdown content (title + blocks). */
export async function exportMarkdown(itemId: string): Promise<void> {
  const [meta, blocks] = await Promise.all([getItem(itemId), getBlocks(itemId)]);
  const md = `# ${meta.title || "Sans titre"}\n\n${blocksToMarkdown(blocks)}\n`;
  download(`${safeName(meta.title)}.md`, md, "text/markdown");
}

/** Text value of a cell for export (sync; formula/rollup ignored).
 * `linkTitles` resolves a linked-row id → its title (for `relation` columns). */
function cellExport(col: DbColumn, raw: unknown, linkTitles: Map<string, string>): string {
  if (raw == null) return "";
  switch (col.type) {
    case "checkbox":
      return raw === true ? "oui" : "non";
    case "date": {
      const dv = parseDateValue(raw);
      return dv ? (dv.end ? `${dv.start} → ${dv.end}` : dv.start) : "";
    }
    case "multiselect":
      return Array.isArray(raw)
        ? (raw as unknown[]).map((x) => (typeof x === "string" ? x : ((x as { name?: string })?.name ?? ""))).filter(Boolean).join(", ")
        : "";
    case "files":
      return Array.isArray(raw) ? (raw as { name?: string }[]).map((f) => f?.name ?? "").filter(Boolean).join(", ") : "";
    case "relation":
      // Linked-row titles (comma-joined) so the export is meaningful and can be
      // re-imported. Missing titles (deleted rows) are dropped.
      return Array.isArray(raw)
        ? (raw as unknown[])
            .map((x) => linkTitles.get(typeof x === "string" ? x : ((x as { id?: string })?.id ?? "")) ?? "")
            .filter(Boolean)
            .join(", ")
        : "";
    case "formula":
    case "rollup":
      return ""; // computed — not exported in v1
    default:
      return String(raw);
  }
}

const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Serializes rows to CSV given the columns to emit: a "Nom" title column then
 * one column per `cols`. `linkTitles` resolves relation ids → titles. Shared by
 * the single-database export and the multi-database bundle. */
export function dbRowsToCsv(
  cols: DbColumn[],
  rows: { title: string | null; properties: string | null }[],
  linkTitles: Map<string, string>,
): string {
  const header = ["Nom", ...cols.map((c) => c.name)];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    const props: PropValues = parseProps(r.properties);
    const cells = [r.title ?? "", ...cols.map((c) => cellExport(c, props[c.id], linkTitles))];
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\n");
}

/** Exports a database's rows as CSV (Name + columns, excluding meta/computed). */
export async function exportCsv(itemId: string): Promise<void> {
  const meta = await getItem(itemId);
  const schema = parseSchema(meta.db_schema);
  const cols = schema.columns.filter((c) => !META_TYPES.has(c.type) && c.type !== "formula" && c.type !== "rollup");
  // Exclude row templates (hidden child items, excluded from views too) — otherwise
  // they export as ordinary rows and re-import as duplicated data rows.
  const templates = new Set(schema.templates ?? []);
  const rows = (await listRows(itemId)).filter((r) => !templates.has(r.id));

  // Resolve linked-row titles for relation columns (id → title across target dbs).
  const linkTitles = new Map<string, string>();
  const relDbs = new Set(
    cols.filter((c) => c.type === "relation" && c.relationDb).map((c) => c.relationDb as string),
  );
  await Promise.all(
    [...relDbs].map(async (dbId) => {
      for (const row of await listRows(dbId)) if (row.title) linkTitles.set(row.id, row.title);
    }),
  );

  download(`${safeName(meta.title)}.csv`, dbRowsToCsv(cols, rows, linkTitles), "text/csv");
}
