"use client";

/**
 * Survival Window Ribbon (PRD FR-B6): the rover site's class across the full
 * two-year range, drawn as a one-column-per-sample strip above the timeline.
 *
 * Enhanced features:
 * - Click anywhere to jump time directly to that operational window.
 * - Live statistical breakdown (% Survivable Sun+Comm, % Solar Only, % In Shadow).
 * - High-contrast "NOW" mission cursor with glowing reticle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../store/uiStore";
import { useTimeStore, T0, T1 } from "../store/timeStore";
import { playTelemetryPing } from "../lib/audioService";

const COLORS = ["#ff5468", "#ffd60a", "#35e08a", "#ff5468"];
const CLASS_NAMES = ["Dead — no sun, no comm", "Solar only", "Survivable — sun + comm", "Comm only — no power"];

export default function Ribbon() {
  const ribbon = useUiStore((s) => s.ribbon);
  const tMs = useTimeStore((s) => s.tMs);
  const setTime = useTimeStore((s) => s.set);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number; cls: number } | null>(null);

  // Compute 2-year survival metrics
  const stats = useMemo(() => {
    if (!ribbon || ribbon.classes.length === 0) return null;
    const n = ribbon.classes.length;
    let green = 0, yellow = 0, red = 0, comm = 0;
    let maxDarkSteps = 0;
    let currentDarkSteps = 0;
    for (let i = 0; i < n; i++) {
      const c = ribbon.classes[i];
      if (c === 2) green++;
      else if (c === 1) yellow++;
      else if (c === 3) comm++;
      else red++;

      if (c === 0 || c === 3) {
        currentDarkSteps++;
        if (currentDarkSteps > maxDarkSteps) maxDarkSteps = currentDarkSteps;
      } else {
        currentDarkSteps = 0;
      }
    }
    const maxDarkH = Math.round(maxDarkSteps * (ribbon.dtSec / 3600));
    return {
      greenPct: ((green / n) * 100).toFixed(1),
      yellowPct: ((yellow / n) * 100).toFixed(1),
      deadPct: (((red + comm) / n) * 100).toFixed(1),
      maxDarkH,
    };
  }, [ribbon]);

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(cv.clientWidth));
    const h = Math.max(1, Math.round(cv.clientHeight));
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!ribbon) {
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const n = ribbon.classes.length;
    for (let x = 0; x < w; x++) {
      const i = Math.min(n - 1, Math.floor((x / w) * n));
      ctx.fillStyle = COLORS[ribbon.classes[i] ?? 0]!;
      ctx.fillRect(x, 0, 1, h);
    }
  }, [ribbon]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!ribbon) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover({
      x: e.clientX - rect.left,
      t: T0 + frac * (T1 - T0),
      cls: ribbon.classes[Math.min(ribbon.classes.length - 1, Math.floor(frac * ribbon.classes.length))] ?? 0,
    });
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!ribbon) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const targetMs = T0 + frac * (T1 - T0);
    setTime(targetMs);
    playTelemetryPing();
  };

  const nowPct = ((tMs - T0) / (T1 - T0)) * 100;

  return (
    <div className="px-1 pb-2">
      <div className="mb-1.5 flex items-center justify-between gap-2 min-w-0 overflow-hidden">
        <div className="flex items-center gap-2 min-w-0 shrink">
          <span className="eyebrow shrink-0">2-Year Survival Ribbon</span>
          {stats && (
            <span className="hidden xl:inline-flex items-center gap-2 text-[10px] mono shrink truncate">
              <span className="text-[var(--ok)]">SUN+COMM: {stats.greenPct}%</span>
              <span className="text-[var(--text-4)]">|</span>
              <span className="text-[var(--kapton)]">SOLAR: {stats.yellowPct}%</span>
              <span className="text-[var(--text-4)]">|</span>
              <span className="text-[var(--text-2)]">LONGEST NIGHT: {stats.maxDarkH}h</span>
            </span>
          )}
        </div>

        <span className="hidden items-center gap-2 shrink-0 lg:flex">
          {["Sun + comm", "Sun only", "Dead", "Comm only"].map((label, i) => (
            <span key={label} className="flex items-center gap-1.5 text-[10px] text-[var(--text-3)]">
              <span className="dot" style={{ background: COLORS[i] }} />
              {label}
            </span>
          ))}
        </span>

        <span className="mono text-[10px] shrink-0 truncate max-w-[240px] text-right" style={{ color: hover ? COLORS[hover.cls] : "var(--text-4)" }}>
          {hover
            ? `${new Date(hover.t).toISOString().slice(0, 16).replace("T", " ")} UTC · ${CLASS_NAMES[hover.cls]}`
            : ribbon
              ? "Click ribbon to jump to time window"
              : "Place a rover to compute ribbon"}
        </span>
      </div>

      <div
        className="relative h-4 cursor-pointer overflow-hidden rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.03)] transition-colors hover:border-[var(--nasa-blue-light)]"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={onClick}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
        {ribbon && (
          <div
            className="pointer-events-none absolute top-0 h-full"
            style={{
              left: `${Math.min(100, Math.max(0, nowPct))}%`,
              width: 2,
              background: "#ffffff",
              boxShadow: "0 0 10px rgba(255,255,255,0.9)",
            }}
          />
        )}
        {hover && (
          <div className="pointer-events-none absolute top-0 h-full w-px" style={{ left: hover.x, background: "rgba(255,255,255,0.5)" }} />
        )}
      </div>
    </div>
  );
}
