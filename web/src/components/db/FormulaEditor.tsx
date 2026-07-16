import { Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { type DbColumn } from "@/lib/db";
import { FORMULA_FUNCS, type FormulaFn } from "@/lib/formula";

/**
 * Assisted formula editor: input area + cursor insertion of
 * columns (prop("Name")) and functions (with signature, description,
 * example), search, and validation message.
 */
export function FormulaEditor({
  value,
  onChange,
  columns,
  selfId,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  columns: DbColumn[];
  /** Edited column (excluded from insertions to prevent self-reference). */
  selfId?: string;
  error: string | null;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState<FormulaFn | null>(null);

  /** Inserts at the cursor; places the caret after the first parenthesis (functions) or at the end. */
  const insert = (snippet: string, caret: "paren" | "end") => {
    const ta = ref.current;
    const start = ta ? ta.selectionStart : value.length;
    const end = ta ? ta.selectionEnd : value.length;
    onChange(value.slice(0, start) + snippet + value.slice(end));
    const rel = caret === "paren" && snippet.includes("(") ? snippet.indexOf("(") + 1 : snippet.length;
    const pos = start + rel;
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(pos, pos);
    });
  };

  const cols = columns.filter((c) => c.id !== selfId);
  const funcs = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s
      ? FORMULA_FUNCS.filter(
          (f) =>
            f.name.toLowerCase().includes(s) ||
            t(`formula.fn.${f.name}` as "formula.fn.if").toLowerCase().includes(s),
        )
      : FORMULA_FUNCS;
    const groups: Record<string, FormulaFn[]> = {};
    for (const f of list) (groups[f.group] ??= []).push(f);
    return groups;
  }, [q, t]);

  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-muted-foreground">{t("formula.ui.expression")}</span>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'e.g. round(prop("Number") * 1.2, 2)'}
        spellCheck={false}
        className="min-h-20 w-full resize-y rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("formula.ui.refHintPre")} <code>prop("Nom")</code>
          {t("formula.ui.refHintPost")}
        </p>
      )}

      {cols.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {cols.map((c) => (
            <button
              key={c.id}
              type="button"
              className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => insert(`prop("${c.name}")`, "end")}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-md border">
        <div className="relative border-b">
          <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            placeholder={t("formula.ui.searchPlaceholder")}
            className="h-8 border-0 pl-7 text-xs shadow-none focus-visible:ring-0"
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-[1fr_1fr] gap-0 max-sm:grid-cols-1">
          <div className="max-h-48 overflow-y-auto p-1">
            {Object.entries(funcs).map(([group, list]) => (
              <div key={group}>
                <div className="px-1 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {t(`formula.group.${group}` as "formula.group.logic")}
                </div>
                {list.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    onMouseEnter={() => setActive(f)}
                    onFocus={() => setActive(f)}
                    onClick={() => insert(f.snippet, "paren")}
                    className="block w-full truncate rounded px-1.5 py-1 text-left font-mono text-xs hover:bg-accent"
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            ))}
            {Object.keys(funcs).length === 0 && (
              <p className="p-2 text-xs text-muted-foreground">{t("formula.ui.noFunction")}</p>
            )}
          </div>
          <div className="max-h-48 overflow-y-auto border-l p-2 text-xs max-sm:border-t max-sm:border-l-0">
            {active ? (
              <div className="space-y-1">
                <code className="block font-medium">{active.sig}</code>
                <p className="text-muted-foreground">{t(`formula.fn.${active.name}` as "formula.fn.if")}</p>
                <div>
                  <span className="text-[10px] tracking-wide text-muted-foreground uppercase">{t("formula.ui.example")}</span>
                  <code className="mt-0.5 block rounded bg-muted px-1.5 py-1 break-all">{active.example}</code>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground">{t("formula.ui.hoverHint")}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
