import { ChevronDown, ChevronRight, Eye, EyeOff, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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
import { Cell, ColumnDialog } from "@/components/DatabaseView";
import {
  columnTypeLabel,
  type DbColumn,
  type DbSchema,
  META_TYPES,
  parseProps,
  parseSchema,
  type PropValues,
} from "@/lib/db";
import { updateProperties, updateSchema } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Properties of a database row displayed at the top of its page.
 * Reuses the typed cells from the table view. Meta columns
 * (created/modified) are omitted. Props can be hidden on the page
 * (schema.pageHidden, applies to all rows of the database). With
 * `canManage`, clicking a property's name edits the column (name/type/
 * options) via the same dialog as the table view.
 */
export function RowProperties({
  rowId,
  dbId,
  dbSchemaJson,
  propertiesJson,
  canEdit,
  canManage,
}: {
  rowId: string;
  dbId: string;
  dbSchemaJson: string | null;
  propertiesJson: string | null;
  canEdit: boolean;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const [schema, setSchema] = useState<DbSchema>(() => parseSchema(dbSchemaJson));
  const [props, setProps] = useState<PropValues>(() => parseProps(propertiesJson));
  const [showHidden, setShowHidden] = useState(false);
  const [editCol, setEditCol] = useState<DbColumn | "new" | null>(null);
  const [confirmDel, setConfirmDel] = useState<DbColumn | null>(null);

  useEffect(() => setProps(parseProps(propertiesJson)), [propertiesJson, rowId]);
  useEffect(() => setSchema(parseSchema(dbSchemaJson)), [dbSchemaJson]);

  const pageHidden = schema.pageHidden ?? [];
  // Is this row a template? → enables dynamic values (duplication date…).
  const isTemplate = (schema.templates ?? []).includes(rowId);
  const cols = schema.columns.filter((c) => !META_TYPES.has(c.type));
  if (cols.length === 0 && !canManage) return null;

  const visible = cols.filter((c) => !pageHidden.includes(c.id));
  const hidden = cols.filter((c) => pageHidden.includes(c.id));

  async function setCell(colId: string, value: unknown) {
    const next = { ...props, [colId]: value };
    setProps(next);
    try {
      await updateProperties(rowId, JSON.stringify(next));
    } catch {
      /* the table will surface the error */
    }
  }

  /** Persists a schema change (columns / hiding) — optimistic. */
  async function persistSchema(next: DbSchema) {
    setSchema(next);
    try {
      await updateSchema(dbId, JSON.stringify(next));
    } catch {
      /* silent */
    }
  }

  function toggleHidden(colId: string) {
    const set = new Set(pageHidden);
    if (set.has(colId)) set.delete(colId);
    else set.add(colId);
    void persistSchema({ ...schema, pageHidden: [...set] });
  }

  function saveColumn(col: DbColumn) {
    const exists = schema.columns.some((c) => c.id === col.id);
    const columns = exists ? schema.columns.map((c) => (c.id === col.id ? col : c)) : [...schema.columns, col];
    setEditCol(null);
    void persistSchema({ ...schema, columns });
  }

  function deleteColumn(id: string) {
    void persistSchema({
      ...schema,
      columns: schema.columns.filter((c) => c.id !== id),
      pageHidden: pageHidden.filter((x) => x !== id),
    });
  }

  const row = (colId: string, name: string, type: string, hiddenRow: boolean, body: React.ReactNode) => {
    const col = schema.columns.find((c) => c.id === colId);
    const editable = canManage && col != null && !META_TYPES.has(col.type);
    return (
      <div key={colId} className="group/prop contents">
        <div className="flex items-center gap-1 truncate py-1 text-muted-foreground" title={name}>
          {editable ? (
            <button className="truncate text-left hover:text-foreground" onClick={() => setEditCol(col)}>
              {name}
            </button>
          ) : (
            <span className="truncate">{name}</span>
          )}
          <span className="text-[10px] opacity-60">{columnTypeLabel(type as never)}</span>
          {canManage && (
            <button
              aria-label={hiddenRow ? t("dbview.prop.show") : t("dbview.prop.hide")}
              className="ml-auto opacity-0 transition-opacity group-hover/prop:opacity-60 hover:!opacity-100"
              onClick={() => toggleHidden(colId)}
            >
              {hiddenRow ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            </button>
          )}
        </div>
        <div className="flex items-center">{body}</div>
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-[54px] max-sm:px-4">
      <div className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 border-y py-3 text-sm">
        {visible.map((c) =>
          row(
            c.id,
            c.name,
            c.type,
            false,
            <Cell col={c} value={props[c.id]} canEdit={canEdit} rowProps={props} columns={schema.columns} templateMode={isTemplate} onChange={(v) => void setCell(c.id, v)} />,
          ),
        )}
      </div>

      {canManage && (
        <button
          className="flex items-center gap-1 py-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setEditCol("new")}
        >
          <Plus className="size-3.5" /> {t("dbview.view.addProperty")}
        </button>
      )}

      {canManage && hidden.length > 0 && (
        <div className="pb-2">
          <button
            className="flex items-center gap-1 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowHidden((s) => !s)}
          >
            {showHidden ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {t("dbview.prop.hidden", { count: hidden.length })}
          </button>
          {showHidden && (
            <div className={cn("grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 pt-1 text-sm opacity-70")}>
              {hidden.map((c) =>
                row(
                  c.id,
                  c.name,
                  c.type,
                  true,
                  <Cell col={c} value={props[c.id]} canEdit={canEdit} rowProps={props} columns={schema.columns} templateMode={isTemplate} onChange={(v) => void setCell(c.id, v)} />,
                ),
              )}
            </div>
          )}
        </div>
      )}

      {editCol && (
        <ColumnDialog
          column={editCol === "new" ? null : editCol}
          columns={schema.columns}
          onClose={() => setEditCol(null)}
          onSave={saveColumn}
          onDelete={
            editCol === "new"
              ? undefined
              : () => {
                  const c = editCol;
                  setEditCol(null);
                  setConfirmDel(c);
                }
          }
        />
      )}

      <AlertDialog open={confirmDel !== null} onOpenChange={(o) => !o && setConfirmDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dbview.dialog.deleteColTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dbview.dialog.deleteColDesc", { name: confirmDel?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dbview.dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDel) deleteColumn(confirmDel.id);
                setConfirmDel(null);
              }}
            >
              {t("dbview.dialog.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
