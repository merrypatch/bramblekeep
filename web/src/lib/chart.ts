import i18n from "@/i18n";
import { type ChartBucket, type DbColumn, type DbView, parseDateValue, type Row } from "./db";

export type ChartResult = {
  labels: string[];
  datasets: { label: string; data: number[]; dashed?: boolean }[];
  /** true if a single series (pie possible, legend hideable). */
  single: boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Meta date columns → corresponding epoch field on the row. */
const META_DATE_FIELD: Record<string, "createdTs" | "updatedTs"> = {
  created_time: "createdTs",
  last_edited_time: "updatedTs",
};

/** Local "YYYY-MM-DD" from an epoch ms. */
function isoFromEpoch(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** (Sortable) key + display label of a date depending on the bucket. */
function bucketOf(iso10: string, bucket: ChartBucket): { key: string; sort: number; label: string } {
  const [y, m, d] = iso10.split("-").map(Number);
  if (bucket === "month") {
    return { key: `${y}-${pad(m)}`, sort: y * 12 + (m - 1), label: `${pad(m)}/${y}` };
  }
  if (bucket === "week") {
    const dt = new Date(y, m - 1, d);
    const monday = new Date(y, m - 1, d - ((dt.getDay() + 6) % 7));
    return {
      key: `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`,
      sort: monday.getTime(),
      label: `${pad(monday.getDate())}/${pad(monday.getMonth() + 1)}`,
    };
  }
  return { key: iso10, sort: new Date(y, m - 1, d).getTime(), label: `${pad(d)}/${pad(m)}` };
}

/** Fills in the missing buckets between the min and the max (continuous time axis). */
function fillDateBuckets(
  present: Map<string, { sort: number; label: string }>,
  bucket: ChartBucket,
): { key: string; label: string }[] {
  const all = [...present.entries()].map(([key, v]) => ({ key, ...v }));
  // Valid (fillable) date keys vs the rest (e.g. "Sans date"), pushed to the end.
  const items = all.filter((i) => /^\d{4}-\d{2}(-\d{2})?$/.test(i.key));
  const extras = all.filter((i) => !/^\d{4}-\d{2}(-\d{2})?$/.test(i.key)).map((i) => ({ key: i.key, label: i.label }));
  if (items.length === 0) return extras;
  items.sort((a, b) => a.sort - b.sort);
  const first = items[0];
  const out: { key: string; label: string }[] = [];
  const parse = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, (m ?? 1) - 1, d ?? 1);
  };
  let cur = parse(first.key);
  const last = parse(items[items.length - 1].key);
  const seen = new Map(items.map((i) => [i.key, i.label]));
  let guard = 0;
  while (cur.getTime() <= last.getTime() && guard++ < 1000) {
    const b = bucketOf(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`, bucket);
    if (!out.length || out[out.length - 1].key !== b.key) {
      out.push({ key: b.key, label: seen.get(b.key) ?? b.label });
    }
    if (bucket === "month") cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    else if (bucket === "week") cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 7);
    else cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return [...out, ...extras];
}

const reduce = (arr: number[], agg: string): number => {
  if (arr.length === 0) return 0;
  const sum = arr.reduce((a, b) => a + b, 0);
  if (agg === "avg") return Math.round((sum / arr.length) * 100) / 100;
  if (agg === "min") return Math.min(...arr);
  if (agg === "max") return Math.max(...arr);
  return sum; // count | sum
};

/** Builds a chart's labels + series from the rows and the view's config.
 * Pure (no I/O); `label(row, colId)` = text of a cell. */
export function buildChart(
  rows: Row[],
  view: DbView,
  columns: DbColumn[],
  label: (row: Row, colId: string) => string,
): ChartResult {
  const xCol = columns.find((c) => c.id === view.groupBy);
  const metaField = xCol ? META_DATE_FIELD[xCol.type] : undefined;
  const isDate = xCol?.type === "date";
  const timeAxis = isDate || !!metaField;
  const bucket = view.chartBucket ?? "day";
  const seriesId = view.chartSeries;
  const agg = view.chartAgg ?? "count";
  const valueId = view.chartValueCol;
  const transform = view.chartTransform ?? "none";

  // X-axis key/label/sort of a row (date, meta date, or text value).
  const xKeyOf = (r: Row): { key: string; label: string; sort: number } => {
    if (!view.groupBy) return { key: "all", label: i18n.t("chart.all"), sort: 0 };
    if (timeAxis) {
      let iso10: string | null;
      if (metaField) {
        const ts = r[metaField];
        iso10 = ts != null ? isoFromEpoch(ts) : null;
      } else {
        const dv = parseDateValue(r.props[view.groupBy]);
        iso10 = dv ? dv.start.slice(0, 10) : null;
      }
      if (!iso10) return { key: "no-date", label: i18n.t("chart.noDate"), sort: 0 };
      const b = bucketOf(iso10, bucket);
      return { key: b.key, label: b.label, sort: b.sort };
    }
    const v = label(r, view.groupBy) || "Sans valeur";
    return { key: v, label: v, sort: 0 };
  };

  // x -> (series -> raw values). Also memorizes sort/label of date x's.
  const cells = new Map<string, Map<string, number[]>>();
  const xMeta = new Map<string, { sort: number; label: string }>();
  const seriesOrder: string[] = [];

  for (const r of rows) {
    const { key: xKey, label: xLabel, sort: xSort } = xKeyOf(r);
    if (!xMeta.has(xKey)) xMeta.set(xKey, { sort: xSort, label: xLabel });

    const sKey = seriesId ? label(r, seriesId) || "Sans valeur" : "";
    if (seriesId && !seriesOrder.includes(sKey)) seriesOrder.push(sKey);

    const raw = agg === "count" ? 1 : Number(r.props[valueId ?? ""]);
    if (agg !== "count" && (raw == null || Number.isNaN(raw))) continue;

    const bySeries = cells.get(xKey) ?? new Map<string, number[]>();
    cells.set(xKey, bySeries);
    const arr = bySeries.get(sKey) ?? [];
    bySeries.set(sKey, arr);
    arr.push(raw);
  }

  // Order of x's: filled & sorted dates, otherwise alpha (or by value below).
  let xs: { key: string; label: string }[];
  if (timeAxis) {
    xs = fillDateBuckets(xMeta, bucket);
  } else {
    xs = [...xMeta.entries()].map(([key, v]) => ({ key, label: v.label }));
    xs.sort((a, b) => a.label.localeCompare(b.label));
  }

  // Burndown: baseline = total of ALL rows, decremented by the cumulative sum
  // of "done" rows (status in the done group) along the X axis.
  if (transform === "burndown") {
    const valOf = (r: Row) => (agg === "count" ? 1 : Number(r.props[valueId ?? ""]) || 0);
    const doneCol = columns.find((c) => c.id === view.chartDoneCol && c.type === "status");
    const isDone = (r: Row) => {
      if (!doneCol) return false;
      const v = r.props[doneCol.id];
      return typeof v === "string" && doneCol.optionGroups?.[v] === "done";
    };
    const total = rows.reduce((s, r) => s + valOf(r), 0);
    const doneByX = new Map<string, number>();
    for (const r of rows) {
      if (!isDone(r)) continue;
      const k = xKeyOf(r).key;
      doneByX.set(k, (doneByX.get(k) ?? 0) + valOf(r));
    }
    let run = 0;
    const remaining = xs.map(({ key }) => {
      run += doneByX.get(key) ?? 0;
      return Math.round((total - run) * 100) / 100;
    });
    const bdLabels = xs.map((x) => x.label);
    const bdSets: ChartResult["datasets"] = [{ label: i18n.t("chart.remaining"), data: remaining }];
    if (view.chartIdeal) {
      const n = xs.length;
      bdSets.push({
        label: i18n.t("chart.ideal"),
        data: xs.map((_, i) => (n <= 1 ? total : Math.round(((total * (n - 1 - i)) / (n - 1)) * 100) / 100)),
        dashed: true,
      });
    }
    return { labels: bdLabels, datasets: bdSets, single: !view.chartIdeal };
  }

  const seriesKeys = seriesId ? seriesOrder : [""];
  let datasets: ChartResult["datasets"] = seriesKeys.map((s) => ({
    label: s || defaultSeriesLabel(view, columns),
    data: xs.map(({ key }) => reduce(cells.get(key)?.get(s) ?? [], agg)),
  }));

  // Transformation along the X axis (cumulative / remaining), per series.
  if (transform !== "none") {
    datasets = datasets.map((ds) => {
      const total = ds.data.reduce((a, b) => a + b, 0);
      let run = 0;
      return {
        ...ds,
        data: ds.data.map((v) => {
          run += v;
          return transform === "cumulative" ? run : total - run;
        }),
      };
    });
  }

  // Sort by value (single series, no date): reorders labels + data.
  let labels = xs.map((x) => x.label);
  if (view.chartSort === "value" && !timeAxis && datasets.length === 1) {
    const idx = datasets[0].data.map((_, i) => i).sort((a, b) => datasets[0].data[b] - datasets[0].data[a]);
    labels = idx.map((i) => labels[i]);
    datasets = datasets.map((ds) => ({ ...ds, data: idx.map((i) => ds.data[i]) }));
  }

  // Target value of a number column → constant "Cible" series (dashed),
  // on charts with a continuous/polygonal axis (radar, lines, areas).
  const target = columns.find((c) => c.id === view.chartValueCol)?.target;
  const kind = view.chartKind ?? "bar";
  if (
    target != null &&
    transform === "none" &&
    (kind === "radar" || kind === "line" || kind === "area" || kind === "radial")
  ) {
    datasets = [...datasets, { label: i18n.t("chart.target"), data: labels.map(() => target), dashed: true }];
  }

  return { labels, datasets, single: datasets.length === 1 };
}

/** Default label of the single series (depending on the aggregate). */
function defaultSeriesLabel(view: DbView, columns: DbColumn[]): string {
  const agg = view.chartAgg ?? "count";
  if (agg === "count") return i18n.t("chart.rowCount");
  const col = columns.find((c) => c.id === view.chartValueCol)?.name ?? "";
  const verb = agg === "sum" ? "Somme" : agg === "avg" ? "Moyenne" : agg === "min" ? "Min" : "Max";
  return `${verb} de ${col}`;
}
