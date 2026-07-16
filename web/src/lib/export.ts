//! Exports a page's data: Markdown (editor content) and CSV (database rows).
//! Pure on the format side; triggering the download lives here too.

import { type BlockNode, getBlocks, getItem, listRows } from "@/lib/api";
import { type DbColumn, META_TYPES, parseDateValue, parseProps, parseSchema, type PropValues } from "@/lib/db";
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

/** Safe filename derived from a title. */
function safeName(title: string | null | undefined): string {
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

/** Text value of a cell for export (sync; formula/rollup ignored). */
function cellExport(col: DbColumn, raw: unknown): string {
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
      return Array.isArray(raw) ? (raw as string[]).length + " lien(s)" : "";
    case "formula":
    case "rollup":
      return ""; // computed — not exported in v1
    default:
      return String(raw);
  }
}

const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Exports a database's rows as CSV (Name + columns, excluding meta/computed). */
export async function exportCsv(itemId: string): Promise<void> {
  const meta = await getItem(itemId);
  const schema = parseSchema(meta.db_schema);
  const cols = schema.columns.filter((c) => !META_TYPES.has(c.type) && c.type !== "formula" && c.type !== "rollup");
  const rows = await listRows(itemId);
  const header = ["Nom", ...cols.map((c) => c.name)];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    const props: PropValues = parseProps(r.properties);
    const cells = [r.title ?? "", ...cols.map((c) => cellExport(c, props[c.id]))];
    lines.push(cells.map(csvCell).join(","));
  }
  download(`${safeName(meta.title)}.csv`, lines.join("\n"), "text/csv");
}
