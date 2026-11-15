"use client";

/**
 * NASA S-band Direct-To-Earth panel (PRD NASA integration §3.3): live
 * link-budget KPIs from `useNasaEphemeris` (pre-baked JPL HORIZONS vectors
 * across the mission window, deterministic engine outside it), the terrain LoS
 * verdict from `CommLinkRaycaster`, and Recharts graphs of fsplDb /
 * latencySeconds / snrDb — all following the mission date slider.
 *
 * Dynamically imported by Telemetry so the NASA service + three.js stay out of
 * the first-load bundle (same convention as the deferred Viewport).
 */

import { memo, useEffect, useMemo, useState } from "react";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { skyState } from "@helios/core";
import { useTimeStore } from "../store/timeStore";
import { computeLinkBudget } from "../lib/nasaDataService";
import { useNasaEphemeris } from "../hooks/useNasaEphemeris";
import { useSpaceWeather } from "../hooks/useSpaceWeather";
import { useCommLinkStore } from "./CommLinkRaycaster";
import { Card, ChartFrame, TICK } from "./ChartKit";

/**
 * FSPL / SNR / light-time series across a ±3-day window centred on "now",
 * from the live Moon–Earth range (same past-solid / forecast-dashed split as
 * the sim traces). Re-centres as the mission date slider moves.
 */
type LinkPoint = {
  t: number;
  fsplPast: number | null;
  fsplFc: number | null;
  snrPast: number | null;
  snrFc: number | null;
  latPast: number | null;
  latFc: number | null;
};

function buildLinkData(centerSec: number): LinkPoint[] {
  const dt = 3600; // 1-hour samples
  const half = 3 * 86400;
  const n = Math.round((2 * half) / dt) + 1;
  const data: LinkPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = centerSec - half + i * dt;
    const sky = skyState(new Date(t * 1000));
    const link = computeLinkBudget(sky.earthDistKm);
    const past = t <= centerSec;
    const fc = t >= centerSec;
    data[i] = {
      t,
      fsplPast: past ? link.fsplDb : null,
      fsplFc: fc ? link.fsplDb : null,
      snrPast: past ? link.snrDb : null,
      snrFc: fc ? link.snrDb : null,
      latPast: past ? link.latencySeconds * 1000 : null,
      latFc: fc ? link.latencySeconds * 1000 : null,
    };
  }
  return data;
}

/** Dual-axis dB chart: FSPL on the left, SNR on the right (Recharts line graphs). */
function LinkDbChart({ data, tSec }: { data: LinkPoint[]; tSec: number }) {
  return (
    <ResponsiveContainer width="100%" height={112}>
      <LineChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="t"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(v: number) => new Date(v * 1000).toISOString().slice(5, 10)}
          tick={TICK}
          tickLine={false}
          axisLine={{ stroke: "rgba(255,255,255,0.12)" }}
          minTickGap={28}
          height={16}
        />
        <YAxis yAxisId={0} width={40} tick={TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${Math.round(v)}`} />
        <YAxis
          yAxisId={1}
          orientation="right"
          width={34}
          tick={TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${Math.round(v)}`}
        />
        <ReferenceLine yAxisId={0} x={tSec} stroke="rgba(255,255,255,0.42)" strokeDasharray="3 3" />
        <Line yAxisId={0} type="monotone" dataKey="fsplPast" stroke="var(--kapton)" strokeWidth={1.7} dot={false} connectNulls isAnimationActive={false} />
        <Line yAxisId={0} type="monotone" dataKey="fsplFc" stroke="var(--kapton)" strokeWidth={1.4} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} />
        <Line yAxisId={1} type="monotone" dataKey="snrPast" stroke="var(--ok)" strokeWidth={1.7} dot={false} connectNulls isAnimationActive={false} />
        <Line yAxisId={1} type="monotone" dataKey="snrFc" stroke="var(--ok)" strokeWidth={1.4} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/**
 * Link-budget graphs, throttled to ≤8 Hz redraws like the sim `Charts` so
 * Recharts is never touched by the 60 Hz playback loop (PRD Part B §10).
 */
const LinkCharts = memo(function LinkCharts() {
  const [tSec, setTSec] = useState(() => useTimeStore.getState().tMs / 1000);
  useEffect(() => {
    const id = setInterval(() => {
      const t = useTimeStore.getState().tMs / 1000;
      setTSec((prev) => (prev === t ? prev : t));
    }, 125);
    return () => clearInterval(id);
  }, []);

  const windowKey = Math.round(tSec / 3600);
  const data = useMemo(() => buildLinkData(windowKey * 3600), [windowKey]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex items-center justify-between">
          <span className="eyebrow">FSPL · SNR</span>
          <span className="flex items-center gap-2 text-[10.5px] text-[var(--text-4)]">
            <span className="dot bg-[var(--kapton)]" />
            FSPL
            <span className="dot bg-[var(--ok)]" />
            SNR
          </span>
        </div>
        <LinkDbChart data={data} tSec={tSec} />
      </div>
      <div>
        <div className="flex items-center justify-between">
          <span className="eyebrow">One-way light time</span>
          <span className="mono text-[10.5px] text-[var(--text-4)]">
            ms
          </span>
        </div>
        <ChartFrame data={data} tSec={tSec} unit="ms" series={[{ past: "latPast", fc: "latFc", color: "var(--neon-blue)" }]} />
      </div>
    </div>
  );
});

export default function NasaLinkPanel() {
  const { fsplDb, latencySeconds, snrDb, earthDistanceKm, isLoading, source, origin } =
    useNasaEphemeris();
  const comm = useCommLinkStore();
  const sw = useSpaceWeather();
  const report = sw.report;

  const levelBadgeClass =
    report?.level === "storm"
      ? "badge badge-bad"
      : report?.level === "watch"
        ? "badge badge-warn"
        : report?.level === "quiet"
          ? "badge badge-ok"
          : "badge badge-neutral";

  const levelLabel = !report
    ? "SYNCING…"
    : report.level === "storm"
      ? "STORM"
      : report.level === "watch"
        ? "WATCH"
        : report.level === "quiet"
          ? "QUIET"
          : "NO DATA";

  const modeLabel = report?.mode === "latest" ? "latest 30 d" : "at mission epoch";

  const row = (label: string, value: string, valueClass?: string) => (
    <div className="flex items-center justify-between py-1">
      <span className="text-[11.5px] text-[var(--text-3)]">
        {label}
      </span>
      <span className={`mono text-[12px] ${valueClass ?? "text-white"}`}>
        {value}
      </span>
    </div>
  );

  return (
    <Card
      title="Earth link — S-band DTE"
      hint={
        <span
          className={`badge ${isLoading ? "badge-warn" : source === "horizons" ? "badge-ok" : "badge-neutral"}`}
        >
          {isLoading
            ? "syncing…"
            : source === "horizons"
              ? origin === "baked"
                ? "JPL HORIZONS · baked"
                : "JPL HORIZONS"
              : "model ephemeris"}
        </span>
      }
    >
      {row("Earth range", `${Math.round(earthDistanceKm).toLocaleString("en-US")} km`)}
      {row("FSPL @ 2200 MHz", `${fsplDb.toFixed(2)} dB`, "text-[var(--accent-strong)]")}
      {row("One-way light time", `${(latencySeconds * 1000).toFixed(1)} ms`)}
      {row(
        "SNR (34-m DSN · 1 MHz)",
        `${snrDb.toFixed(1)} dB`,
        snrDb < 3 ? "text-[var(--bad)]" : snrDb < 10 ? "text-[var(--warn)]" : "text-[var(--ok)]",
      )}
      {row(
        "Terrain LoS",
        comm.checked
          ? comm.blocked
            ? `blocked · ridge ${comm.horizonDeg.toFixed(1)}° > ${comm.elevationDeg.toFixed(1)}°`
            : "clear"
          : "—",
        comm.checked && comm.blocked ? "text-[var(--bad)]" : "text-[var(--ok)]",
      )}
      <div className="mt-2 border-t border-[var(--line)] pt-1.5">
        <div className="flex items-center justify-between py-1">
          <span className="text-[11.5px] text-[var(--text-3)]">
            Space weather
          </span>
          <span className={levelBadgeClass}>
            {levelLabel}
          </span>
        </div>
        <div className="text-[10.5px] leading-[1.5] text-[var(--text-4)]">
          <div className="text-[var(--text-2)]">{report ? report.headline : "Querying NASA DONKI…"}</div>
          <div>{report ? report.impact : "Solar-activity context for the S-band link."}</div>
          <div className="mono mt-0.5 text-[var(--text-4)]">
            NASA DONKI · {modeLabel}
            {sw.isLoading ? " · syncing…" : ""}
          </div>
        </div>
      </div>
      <div className="mt-3">
        <LinkCharts />
      </div>
    </Card>
  );
}
