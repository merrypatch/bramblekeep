import { Filter, Link2, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ColumnType, DbColumn, FilterCondition, FilterGroup, FilterOperator } from "@/lib/db";
import { isFilterGroup, isFilterRef, newFilterId } from "@/lib/db";
import {
  defaultOperator,
  operatorHasValue,
  operatorsForType,
  operatorTakesSet,
} from "@/lib/filter";

/** A column offered in the filter builder (title pseudo-column included). */
export type FilterColumn = { id: string; name: string; type: ColumnType; options?: string[] };

/** Max nesting depth of groups (root + one level of sub-groups, like Notion). */
const MAX_DEPTH = 1;

/** Counts the leaf conditions in a filter tree (for the trigger badge). */
function countRules(group: FilterGroup | undefined): number {
  if (!group) return 0;
  return group.conditions.reduce((n, node) => n + (isFilterGroup(node) ? countRules(node) : 1), 0);
}

/** Localized operator label (dynamic key, cast to a known member). */
function useOpLabel() {
  const { t } = useTranslation();
  return (op: FilterOperator) => t(`dbview.filter.op.${op}` as "dbview.filter.op.contains");
}

/** Host-title sentinel in the dynamic-reference picker. */
const HOST_TITLE = "__title";

/** Value editor for a single condition — typed per column + operator.
 * When `hostColumns` is given, a link toggle switches the value to a dynamic
 * reference to a host-page property (resolved at render time). */
function ValueInput({
  col,
  op,
  value,
  onChange,
  hostColumns,
}: {
  col: FilterColumn;
  op: FilterOperator;
  value: unknown;
  onChange: (v: unknown) => void;
  hostColumns?: DbColumn[];
}) {
  const { t } = useTranslation();
  if (!operatorHasValue(op)) return null;

  const canDynamic = !!hostColumns && hostColumns.length > 0;

  // Dynamic reference: pick a host-page property (or its title).
  if (isFilterRef(value)) {
    const current = value.ref === "title" ? HOST_TITLE : value.columnId;
    return (
      <div className="flex items-center gap-1">
        <Select
          value={current}
          onValueChange={(id) => onChange(id === HOST_TITLE ? { ref: "title" } : { ref: "prop", columnId: id })}
        >
          <SelectTrigger size="sm" className="h-7 min-w-28 text-xs">
            <SelectValue placeholder={t("dbview.filter.selectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={HOST_TITLE} className="text-xs">{t("dbview.view.name")}</SelectItem>
            {hostColumns?.map((c) => (
              <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="secondary"
          size="icon-xs"
          aria-label={t("dbview.filter.staticValue")}
          title={t("dbview.filter.dynamicValue")}
          onClick={() => onChange("")}
        >
          <Link2 className="size-3.5" />
        </Button>
      </div>
    );
  }

  const hasOptions = !!col.options && col.options.length > 0;
  const dynamicToggle = canDynamic ? (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={t("dbview.filter.dynamicValue")}
      title={t("dbview.filter.dynamicValue")}
      className="text-muted-foreground"
      onClick={() => onChange({ ref: "prop", columnId: hostColumns![0].id })}
    >
      <Link2 className="size-3.5" />
    </Button>
  ) : null;

  // Multi-value selection (is any of / is none of) over the column's options.
  if (operatorTakesSet(op) && hasOptions) {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="flex items-center gap-1">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 min-w-24 justify-start text-xs font-normal">
              {selected.length ? selected.join(", ") : t("dbview.filter.selectPlaceholder")}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="max-h-64 w-48 overflow-auto p-1">
            {col.options?.map((opt) => {
              const on = selected.includes(opt);
              return (
                <button
                  key={opt}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
                  onClick={() => onChange(on ? selected.filter((x) => x !== opt) : [...selected, opt])}
                >
                  <span className="flex size-3.5 items-center justify-center rounded border">
                    {on && <X className="size-2.5" />}
                  </span>
                  {opt}
                </button>
              );
            })}
          </PopoverContent>
        </Popover>
        {dynamicToggle}
      </div>
    );
  }

  // Single option pick (select / status / multiselect with is / contains).
  if (hasOptions && !operatorTakesSet(op)) {
    return (
      <div className="flex items-center gap-1">
        <Select value={typeof value === "string" ? value : ""} onValueChange={onChange}>
          <SelectTrigger size="sm" className="h-7 min-w-24 text-xs">
            <SelectValue placeholder={t("dbview.filter.selectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {col.options?.map((opt) => (
              <SelectItem key={opt} value={opt} className="text-xs">
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {dynamicToggle}
      </div>
    );
  }

  const inputType = col.type === "number" ? "number" : col.type === "date" ? "date" : "text";
  return (
    <div className="flex items-center gap-1">
      <Input
        type={inputType}
        value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
        placeholder={t("dbview.filter.value")}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-32 text-xs"
      />
      {dynamicToggle}
    </div>
  );
}

/** One leaf rule: property + operator + value + remove. */
function ConditionRow({
  cond,
  columns,
  onChange,
  onRemove,
  hostColumns,
}: {
  cond: FilterCondition;
  columns: FilterColumn[];
  onChange: (next: FilterCondition) => void;
  onRemove: () => void;
  hostColumns?: DbColumn[];
}) {
  const { t } = useTranslation();
  const opLabel = useOpLabel();
  const col = columns.find((c) => c.id === cond.columnId) ?? columns[0];
  const ops = operatorsForType(col.type);

  return (
    <div className="flex items-center gap-1">
      <Select
        value={cond.columnId}
        onValueChange={(id) => {
          const next = columns.find((c) => c.id === id) ?? columns[0];
          onChange({ ...cond, columnId: id, operator: defaultOperator(next.type), value: undefined });
        }}
      >
        <SelectTrigger size="sm" className="h-7 min-w-24 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {columns.map((c) => (
            <SelectItem key={c.id} value={c.id} className="text-xs">
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={cond.operator}
        onValueChange={(op) => onChange({ ...cond, operator: op as FilterOperator })}
      >
        <SelectTrigger size="sm" className="h-7 min-w-20 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op} className="text-xs">
              {opLabel(op)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <ValueInput
        col={col}
        op={cond.operator}
        value={cond.value}
        onChange={(v) => onChange({ ...cond, value: v })}
        hostColumns={hostColumns}
      />

      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t("dbview.filter.remove")}
        className="text-muted-foreground"
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

/** Recursive group editor (AND/OR). `depth` limits nesting to MAX_DEPTH. */
function GroupEditor({
  group,
  columns,
  depth,
  onChange,
  hostColumns,
}: {
  group: FilterGroup;
  columns: FilterColumn[];
  depth: number;
  onChange: (next: FilterGroup | undefined) => void;
  hostColumns?: DbColumn[];
}) {
  const { t } = useTranslation();

  /** Replaces (node) or removes (undefined) the child at index i; empties → undefined. */
  const setChild = (i: number, node: FilterCondition | FilterGroup | undefined) => {
    const conds = group.conditions.slice();
    if (node === undefined) conds.splice(i, 1);
    else conds[i] = node;
    onChange(conds.length ? { ...group, conditions: conds } : undefined);
  };

  const addRule = () => {
    const col = columns[0];
    const cond: FilterCondition = { id: newFilterId(), columnId: col.id, operator: defaultOperator(col.type) };
    onChange({ ...group, conditions: [...group.conditions, cond] });
  };

  const addGroup = () => {
    const col = columns[0];
    const sub: FilterGroup = {
      id: newFilterId(),
      op: "and",
      conditions: [{ id: newFilterId(), columnId: col.id, operator: defaultOperator(col.type) }],
    };
    onChange({ ...group, conditions: [...group.conditions, sub] });
  };

  /** Connector shown before a child: "Where" (first), an op picker (second),
   * then a static op label — matching the Notion pattern. */
  const connector = (i: number) => {
    if (i === 0) return <span className="w-12 text-xs text-muted-foreground">{t("dbview.filter.where")}</span>;
    if (i === 1)
      return (
        <Select value={group.op} onValueChange={(op) => onChange({ ...group, op: op as "and" | "or" })}>
          <SelectTrigger size="sm" className="h-7 w-12 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="and" className="text-xs">{t("dbview.filter.and")}</SelectItem>
            <SelectItem value="or" className="text-xs">{t("dbview.filter.or")}</SelectItem>
          </SelectContent>
        </Select>
      );
    return <span className="w-12 text-xs text-muted-foreground">{group.op === "or" ? t("dbview.filter.or") : t("dbview.filter.and")}</span>;
  };

  return (
    <div className={depth > 0 ? "rounded-md border bg-muted/30 p-2" : undefined}>
      <div className="flex flex-col gap-1.5">
        {group.conditions.map((node, i) => (
          <div key={isFilterGroup(node) ? node.id : node.id} className="flex items-start gap-1.5">
            <div className="pt-1">{connector(i)}</div>
            {isFilterGroup(node) ? (
              <div className="flex-1">
                <GroupEditor
                  group={node}
                  columns={columns}
                  depth={depth + 1}
                  onChange={(next) => setChild(i, next)}
                  hostColumns={hostColumns}
                />
              </div>
            ) : (
              <ConditionRow
                cond={node}
                columns={columns}
                onChange={(next) => setChild(i, next)}
                onRemove={() => setChild(i, undefined)}
                hostColumns={hostColumns}
              />
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-1">
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground" onClick={addRule}>
          <Plus className="size-3.5" /> {t("dbview.filter.addRule")}
        </Button>
        {depth < MAX_DEPTH && (
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground" onClick={addGroup}>
            <Plus className="size-3.5" /> {t("dbview.filter.addGroup")}
          </Button>
        )}
      </div>
    </div>
  );
}

const emptyGroup = (): FilterGroup => ({ id: "root", op: "and", conditions: [] });

/** Filter builder popover. Edits the view-level filter and (if `onChangeDb`
 * is given) the database-level filter, via two scope tabs. */
export function FilterBuilder({
  columns,
  dbFilter,
  viewFilter,
  onChangeView,
  onChangeDb,
  hostColumns,
}: {
  columns: FilterColumn[];
  dbFilter: FilterGroup | undefined;
  viewFilter: FilterGroup | undefined;
  onChangeView: (next: FilterGroup | undefined) => void;
  /** When provided, a second "All views" tab edits the database-level filter. */
  onChangeDb?: (next: FilterGroup | undefined) => void;
  /** Host-page columns for dynamic values (embedded db in a db-row page). */
  hostColumns?: DbColumn[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"view" | "db">("view");
  const total = countRules(viewFilter) + countRules(dbFilter);

  const active = scope === "db" ? dbFilter : viewFilter;
  const setActive = scope === "db" ? onChangeDb ?? onChangeView : onChangeView;
  const working = useMemo(() => active ?? emptyGroup(), [active]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
          <Filter className="size-3.5" />
          <span className="max-sm:hidden">
            {total > 0 ? t("dbview.filter.ruleCount", { count: total }) : t("dbview.view.filter")}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,32rem)] p-2">
        {onChangeDb && (
          <div className="mb-2 flex gap-1 border-b pb-2">
            {(["view", "db"] as const).map((s) => (
              <Button
                key={s}
                variant={scope === s ? "secondary" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setScope(s)}
              >
                {s === "view" ? t("dbview.filter.scopeView") : t("dbview.filter.scopeAll")}
                {s === "view" && countRules(viewFilter) > 0 ? ` (${countRules(viewFilter)})` : ""}
                {s === "db" && countRules(dbFilter) > 0 ? ` (${countRules(dbFilter)})` : ""}
              </Button>
            ))}
          </div>
        )}

        {working.conditions.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{t("dbview.filter.noFilters")}</p>
        ) : null}

        <GroupEditor group={working} columns={columns} depth={0} onChange={setActive} hostColumns={hostColumns} />

        {active && active.conditions.length > 0 && (
          <div className="mt-2 border-t pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground"
              onClick={() => setActive(undefined)}
            >
              <Trash2 className="size-3.5" /> {t("dbview.filter.delete")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
