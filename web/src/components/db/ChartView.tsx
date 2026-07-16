import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  RadialLinearScale,
  Tooltip,
} from "chart.js";
import { Bar, Doughnut, Line, PolarArea, Radar } from "react-chartjs-2";
import { useTranslation } from "react-i18next";

import type { ChartResult } from "@/lib/chart";
import type { ChartKind } from "@/lib/db";

ChartJS.register(
  CategoryScale,
  LinearScale,
  RadialLinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Filler,
  Tooltip,
  Legend,
);

// Categorical palette (legible in both light and dark modes).
const PALETTE = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];
// Gris neutre lisible sur fond clair et sombre (labels/axes).
const NEUTRAL = "#71717a";
const GRID = "rgba(113,113,122,0.15)";

/** Chart view: bars / lines / areas / sectors, single- or multi-series. */
export function ChartView({
  kind,
  stacked,
  result,
}: {
  kind: ChartKind;
  stacked: boolean;
  result: ChartResult;
}) {
  const { t } = useTranslation();
  const { labels, datasets, single } = result;
  if (labels.length === 0 || datasets.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">{t("chart.noData")}</p>;
  }

  const color = (i: number) => PALETTE[i % PALETTE.length];

  if (kind === "pie") {
    // Ring (doughnut): single series, one color per label.
    const data = {
      labels,
      datasets: [
        {
          label: datasets[0].label,
          data: datasets[0].data,
          backgroundColor: labels.map((_, i) => color(i)),
          borderWidth: 0,
        },
      ],
    };
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "60%",
      plugins: { legend: { position: "right" as const, labels: { color: NEUTRAL } } },
    };
    return (
      <div className="h-[34rem] w-full max-w-5xl rounded-lg border bg-card p-4">
        <Doughnut data={data} options={options} />
      </div>
    );
  }

  if (kind === "radial") {
    // Radial (polar area): segments colored by label; an optional constant
    // "Target" series becomes a dashed ring (radius = target value).
    const data = {
      labels,
      datasets: datasets.map((ds) =>
        ds.dashed
          ? {
              label: ds.label,
              data: ds.data,
              backgroundColor: "transparent",
              borderColor: NEUTRAL,
              borderDash: [6, 4],
              borderWidth: 2,
            }
          : { label: ds.label, data: ds.data, backgroundColor: labels.map((_, i) => hexA(color(i), 0.6)), borderWidth: 0 },
      ),
    };
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "right" as const, labels: { color: NEUTRAL } } },
      scales: {
        r: { beginAtZero: true, min: 0, grid: { color: GRID }, ticks: { color: NEUTRAL, backdropColor: "transparent" } },
      },
    };
    return (
      <div className="h-[34rem] w-full max-w-5xl rounded-lg border bg-card p-4">
        <PolarArea data={data} options={options} />
      </div>
    );
  }

  if (kind === "radar") {
    const data = {
      labels,
      datasets: datasets.map((ds, i) => ({
        label: ds.label,
        data: ds.data,
        backgroundColor: ds.dashed ? "transparent" : hexA(color(i), 0.2),
        borderColor: ds.dashed ? NEUTRAL : color(i),
        borderWidth: 2,
        pointRadius: ds.dashed ? 0 : 2,
        ...(ds.dashed ? { borderDash: [6, 4], fill: false } : {}),
      })),
    };
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: !single, position: "top" as const, labels: { color: NEUTRAL } } },
      scales: {
        r: {
          beginAtZero: true,
          min: 0,
          angleLines: { color: GRID },
          grid: { color: GRID },
          pointLabels: { color: NEUTRAL, font: { size: 11 } },
          ticks: { color: NEUTRAL, backdropColor: "transparent" },
        },
      },
    };
    return (
      <div className="h-[34rem] w-full max-w-5xl rounded-lg border bg-card p-4">
        <Radar data={data} options={options} />
      </div>
    );
  }

  const isArea = kind === "area";
  const cjsData = {
    labels,
    datasets: datasets.map((ds, i) => ({
      label: ds.label,
      data: ds.data,
      backgroundColor: ds.dashed ? "transparent" : kind === "bar" ? color(i) : hexA(color(i), isArea ? 0.2 : 1),
      borderColor: ds.dashed ? NEUTRAL : color(i),
      borderWidth: 2,
      ...(ds.dashed
        ? { borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0 }
        : kind !== "bar"
          ? { tension: 0.3, pointRadius: 2, fill: isArea }
          : {}),
    })),
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: !single, position: "top" as const, labels: { color: NEUTRAL } } },
    scales: {
      x: { stacked, ticks: { color: NEUTRAL }, grid: { color: GRID } },
      y: { stacked, beginAtZero: true, ticks: { color: NEUTRAL }, grid: { color: GRID } },
    },
  };

  return (
    <div className="h-[34rem] w-full max-w-5xl rounded-lg border bg-card p-4">
      {kind === "bar" ? <Bar data={cjsData} options={options} /> : <Line data={cjsData} options={options} />}
    </div>
  );
}

/** Applies an opacity to a hex color #rrggbb. */
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
