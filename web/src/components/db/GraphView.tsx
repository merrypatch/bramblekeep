import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Maximize, Minus, Plus } from "lucide-react";

import type { GraphModel } from "@/lib/graph";

/**
 * Force-directed relation graph on a 2D canvas — no dependency (hand-rolled
 * layout, consistent with the project's single-binary / no-extra-dep ethos).
 * Nodes repel each other, edges act as springs, a mild gravity keeps the graph
 * centered. Drag a node to rearrange; click a node to open the row.
 */
type Sim = { id: string; x: number; y: number; vx: number; vy: number; pinned: boolean };

type Props = {
  model: GraphModel;
  onOpen: (id: string, group: "row" | "linked") => void;
  height: number;
};

/** Resolves a CSS custom property to a concrete rgb() string usable by canvas
 * (canvas fillStyle does not reliably accept raw oklch/var()). */
function resolveColor(el: HTMLElement, cssVar: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${cssVar})`;
  probe.style.display = "none";
  el.appendChild(probe);
  const c = getComputedStyle(probe).color || "#888";
  el.removeChild(probe);
  return c;
}

export function GraphView({ model, onOpen, height }: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Latest onOpen in a ref: keeps it out of the effect deps so the simulation
  // is not torn down and restarted on every parent re-render.
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  // User zoom/pan, applied on top of the auto-fit transform. Refs (not state)
  // so the animation loop reads them without restarting.
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });

  // Node spacing multiplier (repulsion + link length). Ref drives the sim; state
  // drives the slider. The loop re-heats the layout when it changes.
  const [spacing, setSpacing] = useState(1);
  const spacingRef = useRef(1);

  /** Multiplies the zoom by `factor`, keeping the screen point (ax,ay) fixed. */
  const zoomAround = useCallback((factor: number, ax: number, ay: number) => {
    const z = zoomRef.current;
    const nz = Math.max(0.25, Math.min(5, z * factor));
    panRef.current = {
      x: ax - ((ax - panRef.current.x) / z) * nz,
      y: ay - ((ay - panRef.current.y) / z) * nz,
    };
    zoomRef.current = nz;
  }, []);

  const zoomButton = (factor: number) => {
    const wrap = wrapRef.current;
    zoomAround(factor, (wrap?.clientWidth ?? 0) / 2, height / 2);
  };
  const resetView = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const colors = {
      row: resolveColor(wrap, "--primary"),
      linked: resolveColor(wrap, "--muted-foreground"),
      edge: resolveColor(wrap, "--border"),
      label: resolveColor(wrap, "--foreground"),
      bg: resolveColor(wrap, "--card"),
    };

    // Layout state, seeded on a circle (deterministic-ish spread).
    const n = model.nodes.length;
    const sims: Sim[] = model.nodes.map((node, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      const r = 40 + Math.random() * 60;
      return { id: node.id, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, pinned: false };
    });
    const byId = new Map(sims.map((s) => [s.id, s]));
    const nodeById = new Map(model.nodes.map((nd) => [nd.id, nd]));
    const degree = new Map<string, number>();
    for (const e of model.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const radiusOf = (id: string): number => 5 + Math.min(6, (degree.get(id) ?? 0));

    let width = wrap.clientWidth;
    let dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      width = wrap.clientWidth;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    resize();

    // Camera: fit the graph into the viewport each frame (auto-zoom). Updated
    // by draw(), read by pointer hit-testing.
    let transform = { scale: 1, ox: 0, oy: 0 };
    let running = true;
    let alpha = 1; // cooling factor

    const step = () => {
      // Forces (O(n²) repulsion — fine for a few hundred nodes).
      const spread = spacingRef.current;
      const REPULSION = 2000 * spread;
      const SPRING = 0.02;
      const REST = 70 * spread;
      const GRAVITY = 0.02;
      const DAMPING = 0.85;

      for (let i = 0; i < sims.length; i++) {
        const a = sims[i];
        for (let j = i + 1; j < sims.length; j++) {
          const b = sims[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 0.01;
          }
          const f = (REPULSION * alpha) / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
        // Gravity toward center.
        a.vx -= a.x * GRAVITY * alpha;
        a.vy -= a.y * GRAVITY * alpha;
      }
      // Springs along edges.
      for (const e of model.edges) {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - REST) * SPRING * alpha;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      // Integrate.
      let energy = 0;
      for (const s of sims) {
        if (s.pinned) {
          s.vx = 0;
          s.vy = 0;
          continue;
        }
        s.vx *= DAMPING;
        s.vy *= DAMPING;
        s.x += s.vx;
        s.y += s.vy;
        energy += s.vx * s.vx + s.vy * s.vy;
      }
      alpha *= 0.99;
      if (energy < 0.05 && alpha < 0.05) running = false;
    };

    const draw = () => {
      // Fit transform: bounding box → viewport with padding.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of sims) {
        minX = Math.min(minX, s.x);
        minY = Math.min(minY, s.y);
        maxX = Math.max(maxX, s.x);
        maxY = Math.max(maxY, s.y);
      }
      if (!isFinite(minX)) {
        minX = minY = -1;
        maxX = maxY = 1;
      }
      const pad = 40;
      const gw = maxX - minX || 1;
      const gh = maxY - minY || 1;
      const fit = Math.min((width - pad * 2) / gw, (height - pad * 2) / gh, 2.5);
      const fox = (width - gw * fit) / 2 - minX * fit;
      const foy = (height - gh * fit) / 2 - minY * fit;
      // Compose the auto-fit with the user's zoom/pan.
      const zoom = zoomRef.current;
      const pan = panRef.current;
      const scale = fit * zoom;
      const ox = fox * zoom + pan.x;
      const oy = foy * zoom + pan.y;
      const toScreen = (s: { x: number; y: number }) => ({ x: s.x * scale + ox, y: s.y * scale + oy });
      transform = { scale, ox, oy };

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      // Edges.
      ctx.strokeStyle = colors.edge;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      for (const e of model.edges) {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) continue;
        const pa = toScreen(a);
        const pb = toScreen(b);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Nodes + labels.
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const s of sims) {
        const nd = nodeById.get(s.id);
        if (!nd) continue;
        const p = toScreen(s);
        const rad = radiusOf(s.id);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = nd.group === "row" ? colors.row : colors.linked;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = colors.bg;
        ctx.stroke();
        if (scale > 0.5 && nd.label) {
          ctx.fillStyle = colors.label;
          const label = nd.label.length > 24 ? nd.label.slice(0, 23) + "…" : nd.label;
          ctx.fillText(label, p.x, p.y + rad + 2);
        }
      }
      ctx.restore();
    };

    let raf = 0;
    let lastSpacing = spacingRef.current;
    const loop = () => {
      // Spacing changed via the slider → re-heat the layout.
      if (spacingRef.current !== lastSpacing) {
        lastSpacing = spacingRef.current;
        running = true;
        alpha = Math.max(alpha, 0.6);
      }
      if (running) step();
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();

    // Pointer interaction: hit-test in graph space, drag to pin, click to open.
    const pickAt = (clientX: number, clientY: number): Sim | null => {
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      let best: Sim | null = null;
      let bestD = Infinity;
      for (const s of sims) {
        const sx = s.x * transform.scale + transform.ox;
        const sy = s.y * transform.scale + transform.oy;
        const d = (sx - px) ** 2 + (sy - py) ** 2;
        const hit = (radiusOf(s.id) + 6) ** 2;
        if (d < hit && d < bestD) {
          bestD = d;
          best = s;
        }
      }
      return best;
    };

    let dragging: Sim | null = null;
    let panning = false;
    let downAt = { x: 0, y: 0 };
    let lastPan = { x: 0, y: 0 };
    let moved = false;

    const onDown = (ev: PointerEvent) => {
      downAt = { x: ev.clientX, y: ev.clientY };
      moved = false;
      const hit = pickAt(ev.clientX, ev.clientY);
      if (hit) {
        dragging = hit;
        hit.pinned = true;
      } else {
        // Empty space → pan the view.
        panning = true;
        lastPan = { x: ev.clientX, y: ev.clientY };
        canvas.style.cursor = "grabbing";
      }
      canvas.setPointerCapture(ev.pointerId);
    };
    const onMove = (ev: PointerEvent) => {
      if (dragging) {
        if (Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 3) moved = true;
        const rect = canvas.getBoundingClientRect();
        dragging.x = (ev.clientX - rect.left - transform.ox) / transform.scale;
        dragging.y = (ev.clientY - rect.top - transform.oy) / transform.scale;
        running = true;
        alpha = Math.max(alpha, 0.3);
        return;
      }
      if (panning) {
        panRef.current = {
          x: panRef.current.x + (ev.clientX - lastPan.x),
          y: panRef.current.y + (ev.clientY - lastPan.y),
        };
        lastPan = { x: ev.clientX, y: ev.clientY };
        return;
      }
      canvas.style.cursor = pickAt(ev.clientX, ev.clientY) ? "pointer" : "grab";
    };
    const onUp = (ev: PointerEvent) => {
      if (dragging) {
        dragging.pinned = false;
        if (!moved) {
          const nd = nodeById.get(dragging.id);
          if (nd) onOpenRef.current(nd.id, nd.group);
        }
        dragging = null;
        running = true;
        alpha = Math.max(alpha, 0.2);
      }
      panning = false;
      canvas.style.cursor = "grab";
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAround(ev.deltaY < 0 ? 1.12 : 1 / 1.12, ev.clientX - rect.left, ev.clientY - rect.top);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const ro = new ResizeObserver(() => {
      resize();
      running = true;
      alpha = Math.max(alpha, 0.1);
    });
    ro.observe(wrap);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [model, height, zoomAround]);

  return (
    <div
      ref={wrapRef}
      className="relative w-full overflow-hidden rounded-md border bg-card"
      style={{ height }}
    >
      <canvas ref={canvasRef} className="block touch-none" />
      {/* Node spacing. */}
      <div className="absolute bottom-2 left-2 flex items-center gap-2 rounded-md border bg-background/90 px-2 py-1 shadow-sm">
        <span className="text-xs text-muted-foreground">{t("dbview.graph.spacing")}</span>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.1}
          value={spacing}
          onChange={(e) => {
            const v = Number(e.target.value);
            setSpacing(v);
            spacingRef.current = v;
          }}
          aria-label={t("dbview.graph.spacing")}
          className="h-1 w-24 accent-primary"
        />
      </div>
      {/* Zoom controls. */}
      <div className="absolute right-2 bottom-2 flex flex-col gap-1">
        <button
          type="button"
          onClick={() => zoomButton(1.2)}
          aria-label={t("dbview.graph.zoomIn")}
          className="flex size-7 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-sm hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => zoomButton(1 / 1.2)}
          aria-label={t("dbview.graph.zoomOut")}
          className="flex size-7 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-sm hover:text-foreground"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          onClick={resetView}
          aria-label={t("dbview.graph.reset")}
          className="flex size-7 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-sm hover:text-foreground"
        >
          <Maximize className="size-4" />
        </button>
      </div>
    </div>
  );
}
