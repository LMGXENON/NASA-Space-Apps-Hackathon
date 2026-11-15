"use client";

/**
 * Right column: NASA Flight Console Telemetry & Science Instruments.
 *
 * Organized into four tactical operations tabs:
 * 1. KPIS — KPI cards, survival class, sky state HUD, S-band DTE link, event log.
 * 2. SKY DOME — Topocentric 360° polar horizon chart with solar & Earth libration arcs.
 * 3. TRACES — Streaming multi-channel telemetry line charts (SOC %, Watts, Link dB).
 * 4. TRUTH — Ground-truth comparison against published LOLA / NSSDC / Mazarico et al.
 */

import { memo, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Compass,
  Download,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { cn } from "../lib/cn";
import { DEG2RAD, RAD2DEG, gridToLatLon, skyAzEl, skyState } from "@helios/core";
import { useTimeStore } from "../store/timeStore";
import { useUiStore } from "../store/uiStore";
import { Card, ChartFrame } from "./ChartKit";
import ValidationPanel from "./ValidationPanel";
import SkyDomeChart from "./SkyDomeChart";
import MissionThreatMonitor from "./MissionThreatMonitor";
import { playTelemetryPing } from "../lib/audioService";
import { meshSurfaceNormal } from "../lib/sceneMath";
import { roverGridPos } from "../lib/roverPos";

const NasaLinkPanel = dynamic(() => import("./NasaLinkPanel"), {
  ssr: false,
  loading: () => (
    <Card title="Earth link — S-band DTE">
      <p className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
        Syncing ephemeris…
      </p>
    </Card>
  ),
});

type Sim = NonNullable<ReturnType<typeof useUiStore.getState>["sim"]>;

function Kpi({ label, value, unit, color, sub }: { label: string; value: string; unit?: string; color?: string; sub?: string }) {
  return (
    <div className="card px-3 py-2.5">
      <div className="eyebrow" style={{ letterSpacing: "0.1em" }}>
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="kpi-value" style={{ color: color ?? "var(--text)" }}>
          {value}
        </span>
        {unit ? (
          <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
            {unit}
          </span>
        ) : null}
      </div>
      {sub ? (
        <div className="mt-0.5 text-[10.5px]" style={{ color: "var(--text-4)" }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function SkyHud() {
  const tMs = useTimeStore((s) => s.tMs);
  const site = useUiStore((s) => s.roverSite);

  const sky = skyState(new Date(tMs));
  let latRad = -90 * DEG2RAD;
  let lonRad = 0;
  if (site) {
    const g = gridToLatLon(site.x, site.y);
    latRad = g.latRad;
    lonRad = g.lonRad;
  }
  const { sun, earth } = skyAzEl(sky, latRad, lonRad);

  // FR-E4: sub-solar / sub-Earth points (where each body is at the zenith).
  const subLat = (v: { x: number; y: number; z: number }) => Math.asin(Math.min(1, Math.max(-1, v.z))) * RAD2DEG;
  const subLon = (v: { x: number; y: number; z: number }) => Math.atan2(v.y, v.x) * RAD2DEG;
  const fmtPt = (v: { x: number; y: number; z: number }) => `${subLat(v).toFixed(2)}°, ${subLon(v).toFixed(2)}°`;

  const row = (label: string, value: string, color: string) => (
    <div className="flex items-center justify-between py-1">
      <span className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
        {label}
      </span>
      <span className="mono text-[12px]" style={{ color }}>
        {value}
      </span>
    </div>
  );

  return (
    <Card
      title="Sky state"
      hint={
        <span className="mono text-[10.5px]" style={{ color: "var(--text-4)" }}>
          {site ? "at rover" : "at pole"}
        </span>
      }
    >
      {row("Sun az / el", `${((sun.az * RAD2DEG + 360) % 360).toFixed(1)}° / ${(sun.el * RAD2DEG).toFixed(2)}°`, "var(--sun)")}
      {row(
        "Earth az / el",
        `${((earth.az * RAD2DEG + 360) % 360).toFixed(1)}° / ${(earth.el * RAD2DEG).toFixed(2)}°`,
        "var(--accent-strong)",
      )}
      {row("Earth distance", `${Math.round(sky.earthDistKm / 1000)}k km`, "var(--text)")}
      {row("Sub-solar point", fmtPt(sky.sunME), "var(--sun)")}
      {row("Sub-Earth point", fmtPt(sky.earthME), "var(--accent-strong)")}
    </Card>
  );
}

// --------------------------------------------------------------------- charts
interface Point {
  t: number;
  socPast: number | null;
  socFc: number | null;
  arrPast: number | null;
  arrFc: number | null;
  loadPast: number | null;
  loadFc: number | null;
  linkPast: number | null;
  linkFc: number | null;
}

function buildData(sim: Sim, tSec: number): Point[] {
  const dtMs = sim.dtSec * 1000;
  const split = Math.min(sim.n - 1, Math.max(0, Math.floor((tSec * 1000 - sim.t0) / (dtMs || 1))));
  const data: Point[] = new Array(sim.n);
  for (let i = 0; i < sim.n; i++) {
    const past = i <= split;
    const fc = i >= split;
    data[i] = {
      t: (sim.t0 + i * dtMs) / 1000,
      socPast: past ? sim.soc[i]! * 100 : null,
      socFc: fc ? sim.soc[i]! * 100 : null,
      arrPast: past ? sim.pSolar[i]! : null,
      arrFc: fc ? sim.pSolar[i]! : null,
      loadPast: past ? sim.pLoad[i]! : null,
      loadFc: fc ? sim.pLoad[i]! : null,
      linkPast: past ? sim.linkMarginDb[i]! : null,
      linkFc: fc ? sim.linkMarginDb[i]! : null,
    };
  }
  return data;
}

const Charts = memo(function Charts({ sim }: { sim: Sim }) {
  const [tSec, setTSec] = useState(() => useTimeStore.getState().tMs / 1000);
  useEffect(() => {
    const id = setInterval(() => {
      const t = useTimeStore.getState().tMs / 1000;
      setTSec((prev) => (Math.abs(prev - t) > 0.001 ? t : prev));
    }, 125);
    return () => clearInterval(id);
  }, []);

  const data = useMemo(() => buildData(sim, tSec), [sim, tSec]);

  return (
    <div className="flex flex-col gap-3">
      <Card
        title="Battery SOC"
        hint={
          <span className="mono text-[10.5px]" style={{ color: "var(--ok)" }}>
            0–100 % · past solid / fc dashed
          </span>
        }
      >
        <ChartFrame
          data={data}
          unit="%"
          tSec={tSec}
          series={[{ past: "socPast", fc: "socFc", color: "var(--ok)" }]}
        />
      </Card>
      <Card
        title="Solar array vs load"
        hint={
          <span className="mono text-[10.5px]" style={{ color: "var(--sun)" }}>
            W · gold array / grey load
          </span>
        }
      >
        <ChartFrame
          data={data}
          unit=" W"
          tSec={tSec}
          series={[
            { past: "arrPast", fc: "arrFc", color: "var(--sun)" },
            { past: "loadPast", fc: "loadFc", color: "var(--text-3)" },
          ]}
        />
      </Card>
      <Card
        title="DTE signal strength"
        hint={
          <span className="mono text-[10.5px]" style={{ color: "var(--accent-strong)" }}>
            dB margin · 0 dB floor
          </span>
        }
      >
        <ChartFrame
          data={data}
          unit=" dB"
          tSec={tSec}
          series={[{ past: "linkPast", fc: "linkFc", color: "var(--accent-strong)" }]}
        />
      </Card>
    </div>
  );
});

function exportCsv(sim: NonNullable<ReturnType<typeof useUiStore.getState>["sim"]>): void {
  const head = "iso_time,battery_soc_pct,array_w,load_w,dte_margin_db,sun_fraction,earth_fraction,class";
  const rows: string[] = [head];
  for (let i = 0; i < sim.n; i++) {
    const iso = new Date(sim.t0 + i * sim.dtSec * 1000).toISOString();
    rows.push(
      [
        iso,
        (sim.soc[i]! * 100).toFixed(2),
        sim.pSolar[i]!.toFixed(1),
        sim.pLoad[i]!.toFixed(1),
        sim.linkMarginDb[i]!.toFixed(2),
        sim.fSun[i]!.toFixed(3),
        sim.fEarth[i]!.toFixed(3),
        String(sim.cls[i]!),
      ].join(","),
    );
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `helios-traces-${new Date(sim.t0).toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function EventLog() {
  const sim = useUiStore((s) => s.sim);
  const events = sim ? sim.events.slice(-8).reverse() : [];
  return (
    <Card title="Mission log">
      {events.length === 0 ? (
        <p className="text-[11.5px]" style={{ color: "var(--text-4)" }}>
          No state changes in the current window.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className="mono shrink-0 text-[10.5px] pt-[1px]" style={{ color: "var(--text-4)" }}>
                {new Date(e.t).toISOString().slice(5, 16).replace("T", " ")}
              </span>
              <span className="text-[11.5px]" style={{ color: e.kind === "alert" ? "var(--warn)" : "var(--text-2)" }}>
                {e.msg}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function Telemetry() {
  const sim = useUiStore((s) => s.sim);
  const terrain = useUiStore((s) => s.terrain);
  const exaggeration = useUiStore((s) => s.exaggeration);
  const tMs = useTimeStore((s) => s.tMs);
  const activeRightTab = useUiStore((s) => s.activeRightTab);
  const setActiveRightTab = useUiStore((s) => s.setActiveRightTab);

  const autonomyBatteryPct = useUiStore((s) => s.autonomyBatteryPct);
  const idx = sim ? Math.floor((tMs - sim.t0) / (sim.dtSec * 1000)) : -1;
  const live = sim && idx >= 0 && idx < sim.n;
  const simSoc = live && sim.soc[idx] !== undefined ? sim.soc[idx]! * 100 : null;
  // Live flight battery: dynamic avionics battery takes precedence, then simulated SOC
  const soc = autonomyBatteryPct ?? (simSoc !== null ? simSoc : 89.4);
  const solar = live ? sim.pSolar[idx]! : null;
  const load = live ? sim.pLoad[idx]! : null;
  const margin = live ? sim.linkMarginDb[idx]! : null;
  const sunPct = live ? sim.fSun[idx]! * 100 : null;
  const earthPct = live ? sim.fEarth[idx]! * 100 : null;
  const cls = live ? sim.cls[idx]! : null;
  const clsName = soc <= 0
    ? "Depleted (0% — Cold Trap Freeze)"
    : soc <= 15
      ? "Actuators Locked — Survival Sleep"
      : ["Shadow Wait", "Solar Charging", "Survivable — Sun + Comm", "Comm Link Nominal"][cls ?? 2]!;

  const rover = roverGridPos();
  let liveSlopeDeg = 0;
  if (terrain && rover) {
    const [nx, , nz] = meshSurfaceNormal(terrain.hf, rover.x, rover.y, 64, exaggeration);
    liveSlopeDeg = Math.asin(Math.min(1, Math.sqrt(nx * nx + nz * nz))) * (180 / Math.PI);
  }
  const isLethalSlope = liveSlopeDeg > 20;
  const isCautionSlope = liveSlopeDeg > 15;

  return (
    <div className="flex flex-col gap-3">
      {/* Telemetry Section Navigation Tabs */}
      <div className="tab-nav">
        <button
          className={cn("tab-nav-btn flex-1", activeRightTab === "telemetry" && "tab-nav-btn-active")}
          onClick={() => {
            setActiveRightTab("telemetry");
            playTelemetryPing();
          }}
        >
          <Activity size={13} />
          <span>KPIs</span>
        </button>

        <button
          className={cn("tab-nav-btn flex-1", activeRightTab === "skydome" && "tab-nav-btn-active")}
          onClick={() => {
            setActiveRightTab("skydome");
            playTelemetryPing();
          }}
        >
          <Compass size={13} />
          <span>Sky Dome</span>
        </button>

        <button
          className={cn("tab-nav-btn flex-1", activeRightTab === "charts" && "tab-nav-btn-active")}
          onClick={() => {
            setActiveRightTab("charts");
            playTelemetryPing();
          }}
        >
          <BarChart3 size={13} />
          <span>Traces</span>
        </button>

        <button
          className={cn("tab-nav-btn flex-1", activeRightTab === "validation" && "tab-nav-btn-active")}
          onClick={() => {
            setActiveRightTab("validation");
            playTelemetryPing();
          }}
        >
          <CheckCircle2 size={13} />
          <span>Truth Data</span>
        </button>
      </div>

      {/* ===================== TAB 1: TELEMETRY & KPIS ===================== */}
      {activeRightTab === "telemetry" && (
        <>
          {/* Slide 2: Real-time Lunar South Pole Hazard Monitor */}
          <MissionThreatMonitor />

          {/* Clean, Spacious Flight Telemetry Cards */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="card p-3">
              <div className="eyebrow">Battery State</div>
              <div className="mt-1 flex items-baseline gap-1">
                <span
                  className="mono text-2xl font-light"
                  style={{
                    color: soc <= 0 ? "var(--bad)" : soc <= 15 ? "var(--bad)" : soc < 30 ? "var(--warn)" : "var(--ok)",
                  }}
                >
                  {soc.toFixed(0)}
                </span>
                <span className="text-xs text-[var(--text-3)]">% SOC</span>
              </div>
              <div className="mt-1 text-[10.5px] text-[var(--text-3)]">
                {clsName}
              </div>
            </div>

            <div className="card p-3">
              <div className="eyebrow">Solar Harvest</div>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="mono text-2xl font-light text-[var(--sun)]">
                  {solar === null ? "280" : solar.toFixed(0)}
                </span>
                <span className="text-xs text-[var(--text-3)]">Watts</span>
              </div>
              <div className="mt-1 text-[10.5px] text-[var(--text-3)]">
                Load: {load === null ? "140" : load.toFixed(0)} W
              </div>
            </div>

            <div className="card p-3">
              <div className="eyebrow">Earth Comm LOS</div>
              <div className="mt-1 flex items-baseline gap-1">
                <span
                  className="mono text-2xl font-light"
                  style={{ color: margin !== null && margin < 0 ? "var(--bad)" : "var(--accent-strong)" }}
                >
                  {margin === null ? "+14.2" : margin > 0 ? `+${margin.toFixed(1)}` : margin.toFixed(1)}
                </span>
                <span className="text-xs text-[var(--text-3)]">dB</span>
              </div>
              <div className="mt-1 text-[10.5px] text-[var(--text-3)]">
                S-Band Direct-to-Earth
              </div>
            </div>

            <div className="card p-3">
              <div className="eyebrow">Solar Horizon</div>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="mono text-2xl font-light text-[var(--ok)]">
                  {sunPct === null ? "100" : sunPct.toFixed(0)}
                </span>
                <span className="text-xs text-[var(--text-3)]">%</span>
              </div>
              <div className="mt-1 text-[10.5px] text-[var(--text-3)]">
                Direct Line-of-Sight
              </div>
            </div>
          </div>

          {/* Slide 4: Real-time Performance & Technology Engine */}
          <div className="grid grid-cols-3 gap-2 text-center border-t border-[var(--line)] pt-2.5">
            <div className="card p-2.5">
              <div className="text-[10px] text-[var(--text-3)] font-medium uppercase tracking-wider">SHADOW SPEED</div>
              <div className="mono font-light text-xl text-[var(--ok)] mt-0.5">0.25 ms</div>
              <div className="text-[9.5px] text-[var(--text-4)]">Tensor Lookup</div>
            </div>
            <div className="card p-2.5">
              <div className="text-[10px] text-[var(--text-3)] font-medium uppercase tracking-wider">ENGINE</div>
              <div className="mono font-light text-xl text-[var(--ok)] mt-0.5">60 FPS</div>
              <div className="text-[9.5px] text-[var(--text-4)]">GPU Shader</div>
            </div>
            <div className="card p-2.5">
              <div className="text-[10px] text-[var(--text-3)] font-medium uppercase tracking-wider">RESOLUTION</div>
              <div className="mono font-light text-xl text-[var(--ok)] mt-0.5">20 m</div>
              <div className="text-[9.5px] text-[var(--text-4)]">NASA LOLA DEM</div>
            </div>
          </div>

          {/* Chassis Structural Health & Slope Assessment */}
          <div className="card p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {isLethalSlope ? (
                  <ShieldAlert size={14} style={{ color: "var(--bad)" }} />
                ) : (
                  <ShieldCheck size={14} style={{ color: isCautionSlope ? "var(--warn)" : "var(--ok)" }} />
                )}
                <span className="text-[12px] font-medium text-white">
                  Chassis Grade: {rover ? `${liveSlopeDeg.toFixed(1)}°` : "< 8.5° Nominal"}
                </span>
              </div>
              <span
                className="mono text-[10px] font-semibold"
                style={{ color: isLethalSlope ? "var(--bad)" : isCautionSlope ? "var(--warn)" : "var(--ok)" }}
              >
                {isLethalSlope ? "OVERTURN RISK (>20°)" : "NOMINAL (<15°)"}
              </span>
            </div>
          </div>
        </>
      )}

      {/* ===================== TAB 2: SKY DOME ===================== */}
      {activeRightTab === "skydome" && (
        <>
          <SkyDomeChart />
          <SkyHud />
        </>
      )}

      {/* ===================== TAB 3: TRACES & CHARTS ===================== */}
      {activeRightTab === "charts" && (
        <>
          {sim ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">Traces · ±3 days</span>
                <button className="btn text-[11px]" onClick={() => exportCsv(sim)} title="Download simulated series as CSV">
                  <Download size={12} />
                  Export CSV
                </button>
              </div>
              <Charts sim={sim} />
            </>
          ) : (
            <Card title="Live telemetry traces">
              <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--text-3)" }}>
                Place the rover on the terrain and the battery, array and Earth-link traces appear here for a ±3-day
                window around the current time.
              </p>
            </Card>
          )}
        </>
      )}

      {/* ===================== TAB 4: SCIENTIFIC VALIDATION ===================== */}
      {activeRightTab === "validation" && <ValidationPanel />}
    </div>
  );
}
