import { describe, expect, it } from "vitest";

import { buildChart } from "./chart";
import type { DbColumn, DbView, Row } from "./db";

const COLUMNS: DbColumn[] = [
  { id: "date", name: "Date", type: "date", dateTime: true },
  { id: "temp", name: "Température (°c)", type: "number" },
  { id: "who", name: "Personne", type: "text" },
];

/** A reading: date cell as a date column stores it ("YYYY-MM-DDTHH:mm"). */
function reading(id: string, when: string, temp: number, who = "Neo"): Row {
  return { id, title: id, icon: null, cover: null, props: { date: when, temp, who } };
}

const view = (over: Partial<DbView> = {}): DbView => ({
  id: "chart",
  name: "Chart",
  type: "chart",
  groupBy: "date",
  chartValueCol: "temp",
  ...over,
});

/** Cell text, as DatabaseView passes it (only used for non-date axes/series). */
const text = (row: Row, colId: string) => String(row.props[colId] ?? "");

describe("buildChart — hour bucket", () => {
  it("keeps several readings of the same day apart, in chronological order", () => {
    // The reported case: 8 temperatures taken on a single day. Grouped by day they
    // collapse into one point, which hides exactly what one wants to see.
    const rows = [
      reading("temp-003", "2026-07-19T01:50", 39.1),
      reading("temp-008", "2026-07-19T23:00", 39.9),
      reading("temp-005", "2026-07-19T12:30", 39.2),
    ];
    const r = buildChart(rows, view({ chartBucket: "hour", chartAgg: "avg" }), COLUMNS, text);
    expect(r.labels).toEqual(["19/07 01h", "19/07 12h", "19/07 23h"]);
    expect(r.datasets[0].data).toEqual([39.1, 39.2, 39.9]);
  });

  it("groups readings that fall in the same hour", () => {
    const rows = [
      reading("a", "2026-07-19T17:00", 40.3),
      reading("b", "2026-07-19T17:45", 39.6),
    ];
    const r = buildChart(rows, view({ chartBucket: "hour", chartAgg: "max" }), COLUMNS, text);
    expect(r.labels).toEqual(["19/07 17h"]);
    expect(r.datasets[0].data).toEqual([40.3]);
  });

  it("does not fill the empty hours in between", () => {
    // Filling would put 21 empty slots between these two and make the axis
    // unreadable — the hour axis plots only the hours that carry a row.
    const rows = [
      reading("a", "2026-07-19T01:50", 39.1),
      reading("b", "2026-07-19T23:00", 39.9),
    ];
    const r = buildChart(rows, view({ chartBucket: "hour", chartAgg: "avg" }), COLUMNS, text);
    expect(r.labels).toHaveLength(2);
  });

  it("spans days", () => {
    const rows = [
      reading("a", "2026-07-19T23:00", 39.9),
      reading("b", "2026-07-20T07:35", 38.4),
    ];
    const r = buildChart(rows, view({ chartBucket: "hour", chartAgg: "avg" }), COLUMNS, text);
    expect(r.labels).toEqual(["19/07 23h", "20/07 07h"]);
    expect(r.datasets[0].data).toEqual([39.9, 38.4]);
  });

  it("falls back to midnight for a date column without the time option", () => {
    const cols: DbColumn[] = [{ ...COLUMNS[0], dateTime: false }, COLUMNS[1], COLUMNS[2]];
    const rows = [reading("a", "2026-07-19", 39.1)];
    const r = buildChart(rows, view({ chartBucket: "hour", chartAgg: "avg" }), cols, text);
    expect(r.labels).toEqual(["19/07 00h"]);
  });
});

describe("buildChart — empty buckets", () => {
  const gapRows = [
    reading("a", "2026-07-19T09:00", 39.1),
    reading("c", "2026-07-21T09:00", 38.2), // 20/07 has no reading
  ];

  it("leaves a hole rather than a 0 for an average", () => {
    // A day without a measurement is not a day at 0°C. `0` there used to drag the
    // curve down to the axis.
    const r = buildChart(gapRows, view({ chartBucket: "day", chartAgg: "avg" }), COLUMNS, text);
    expect(r.labels).toEqual(["19/07", "20/07", "21/07"]);
    expect(r.datasets[0].data).toEqual([39.1, null, 38.2]);
  });

  it("does the same for min and max", () => {
    for (const agg of ["min", "max"] as const) {
      const r = buildChart(gapRows, view({ chartBucket: "day", chartAgg: agg }), COLUMNS, text);
      expect(r.datasets[0].data).toEqual([39.1, null, 38.2]);
    }
  });

  it("still reports 0 for a count and a sum — no row genuinely means none", () => {
    const count = buildChart(gapRows, view({ chartBucket: "day", chartAgg: "count" }), COLUMNS, text);
    expect(count.datasets[0].data).toEqual([1, 0, 1]);
    const sum = buildChart(gapRows, view({ chartBucket: "day", chartAgg: "sum" }), COLUMNS, text);
    expect(sum.datasets[0].data).toEqual([39.1, 0, 38.2]);
  });

  it("keeps a cumulative transform continuous across a hole", () => {
    const r = buildChart(
      gapRows,
      view({ chartBucket: "day", chartAgg: "count", chartTransform: "cumulative" }),
      COLUMNS,
      text,
    );
    expect(r.datasets[0].data).toEqual([1, 1, 2]);
  });
});

describe("buildChart — series", () => {
  it("splits one line per person", () => {
    const rows = [
      reading("a", "2026-07-19T09:00", 39.1, "Neo"),
      reading("b", "2026-07-19T09:00", 37.2, "Mia"),
    ];
    const r = buildChart(
      rows,
      view({ chartBucket: "hour", chartAgg: "avg", chartSeries: "who" }),
      COLUMNS,
      text,
    );
    expect(r.datasets.map((d) => d.label)).toEqual(["Neo", "Mia"]);
    expect(r.datasets[0].data).toEqual([39.1]);
    expect(r.datasets[1].data).toEqual([37.2]);
    expect(r.single).toBe(false);
  });
});
