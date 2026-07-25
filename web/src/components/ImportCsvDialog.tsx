import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import { toast } from "sonner";

import { getItem } from "@/lib/api";
import { columnTypeLabel, parseSchema, type ColumnType, type DbSchema } from "@/lib/db";
import {
  applyImport,
  buildPreview,
  importableColumns,
  type HeaderMapping,
  type ImportPreview,
} from "@/lib/csvImport";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Column types offered when creating a NEW column from a CSV header. */
const CREATABLE_TYPES: ColumnType[] = [
  "text",
  "number",
  "checkbox",
  "select",
  "multiselect",
  "date",
  "email",
  "url",
  "phone",
];

type Props = {
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful import (parent refreshes the view). */
  onImported: () => void;
};

/** CSV import into an existing database: pick a file, review the per-column
 * mapping (title / existing column / new inferred column / ignore), then merge
 * the rows in. */
export function ImportCsvDialog({ itemId, open, onOpenChange, onImported }: Props) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [schema, setSchema] = useState<DbSchema | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setSchema(null);
    setPreview(null);
    setBusy(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function onPick(file: File) {
    try {
      const [text, meta] = await Promise.all([file.text(), getItem(itemId)]);
      const s = parseSchema(meta.db_schema);
      setSchema(s);
      setPreview(buildPreview(text, s));
    } catch {
      toast.error(t("importCsv.readFailed"));
    }
  }

  function setMapping(index: number, m: HeaderMapping) {
    setPreview((prev) => {
      if (!prev) return prev;
      const mappings = prev.mappings.map((cur, i) => {
        if (i === index) return m;
        // Only one header can feed the title: demote any other title to ignore.
        if (m.kind === "title" && cur.kind === "title") return { kind: "ignore" } as HeaderMapping;
        return cur;
      });
      return { ...prev, mappings };
    });
  }

  async function onImport() {
    if (!preview || !schema) return;
    if (preview.rows.length === 0) {
      toast.error(t("importCsv.empty"));
      return;
    }
    setBusy(true);
    try {
      const { created } = await applyImport(itemId, schema, preview);
      toast.success(t("importCsv.done", { count: created }));
      onImported();
      onOpenChange(false);
      reset();
    } catch {
      toast.error(t("importCsv.failed"));
      setBusy(false);
    }
  }

  const existingCols = schema ? importableColumns(schema) : [];
  const newColCount = preview?.mappings.filter((m) => m.kind === "new").length ?? 0;

  // Encodes a mapping as a <select> value.
  const encode = (m: HeaderMapping): string =>
    m.kind === "existing" ? `existing:${m.columnId}` : m.kind;

  function decode(index: number, value: string): HeaderMapping {
    if (value === "title") return { kind: "title" };
    if (value === "ignore") return { kind: "ignore" };
    if (value.startsWith("existing:")) return { kind: "existing", columnId: value.slice(9) };
    // "new" — re-infer a type from the header name / keep text default.
    const header = preview?.headers[index] ?? "";
    return { kind: "new", name: header || `Column ${index + 1}`, type: "text" };
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("importCsv.title")}</DialogTitle>
          <DialogDescription>{t("importCsv.description")}</DialogDescription>
        </DialogHeader>

        {!preview ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPick(f);
              }}
            />
            <Button variant="outline" onClick={() => fileInput.current?.click()}>
              <Upload className="size-4" /> {t("importCsv.pick")}
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t("importCsv.summary", { rows: preview.rows.length, cols: newColCount })}
            </p>
            <div className="max-h-[50vh] overflow-y-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/60 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t("importCsv.colHeader")}</th>
                    <th className="px-3 py-2 font-medium">{t("importCsv.colTarget")}</th>
                    <th className="px-3 py-2 font-medium">{t("importCsv.colType")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.headers.map((h, i) => {
                    const m = preview.mappings[i];
                    return (
                      <tr key={i} className="border-t">
                        <td className="max-w-[12rem] truncate px-3 py-2 font-medium">
                          {h || `Column ${i + 1}`}
                        </td>
                        <td className="px-3 py-2">
                          <Select
                            value={encode(m)}
                            onValueChange={(v) => setMapping(i, decode(i, v))}
                          >
                            <SelectTrigger size="sm" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="title">{t("importCsv.asTitle")}</SelectItem>
                              <SelectItem value="new">{t("importCsv.asNew")}</SelectItem>
                              <SelectItem value="ignore">{t("importCsv.asIgnore")}</SelectItem>
                              {existingCols.length > 0 && (
                                <SelectGroup>
                                  <SelectLabel>{t("importCsv.existingGroup")}</SelectLabel>
                                  {existingCols.map((c) => (
                                    <SelectItem key={c.id} value={`existing:${c.id}`}>
                                      {c.name}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              )}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {m.kind === "new" ? (
                            <Select
                              value={m.type}
                              onValueChange={(v) =>
                                setMapping(i, { ...m, type: v as ColumnType })
                              }
                            >
                              <SelectTrigger size="sm" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CREATABLE_TYPES.map((ty) => (
                                  <SelectItem key={ty} value={ty}>
                                    {columnTypeLabel(ty)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void onImport()} disabled={!preview || busy}>
            {busy ? t("importCsv.importing") : t("importCsv.import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
