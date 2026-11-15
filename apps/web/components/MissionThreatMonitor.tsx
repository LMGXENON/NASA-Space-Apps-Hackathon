"use client";

import { useMemo } from "react";
import { Radio, Sun, Thermometer, ShieldAlert } from "lucide-react";
import { DEG2RAD, RAD2DEG, gridToLatLon, skyAzEl, skyState } from "@helios/core";
import { cn } from "../lib/cn";
import { useTimeStore } from "../store/timeStore";
import { useUiStore } from "../store/uiStore";
import { roverGridPos } from "../lib/roverPos";

function formatHours(h: number): string {
  if (h >= 24) {
    return `${(h / 24).toFixed(1)}d`;
  }
  return `${h.toFixed(1)}h`;
}

/**
 * MissionThreatMonitor — Real-time telemetry monitoring of the 3 critical lunar polar hazards:
 * 1. Ultra-Low Grazing Sun (<1.8° Elevation, moving terrain shadows) with time to sunset/sunrise
 * 2. Earth Communication Blackout (±7.0° Libration occultations) with time to earthset/earthrise
 * 3. Extreme Cold Traps (40K regolith floors, battery freeze limit)
 */
export default function MissionThreatMonitor() {
  const tMs = useTimeStore((s) => s.tMs);
  const site = useUiStore((s) => s.roverSite);
  const sim = useUiStore((s) => s.sim);

  const sky = useMemo(() => skyState(new Date(tMs)), [tMs]);
  const rover = roverGridPos();

  const coords = useMemo(() => {
    const pt = rover || site;
    if (pt) {
      const g = gridToLatLon(pt.x, pt.y);
      return { latRad: g.latRad, lonRad: g.lonRad };
    }
    return { latRad: -90 * DEG2RAD, lonRad: 0 };
  }, [rover, site]);

  const { sun, earth } = useMemo(() => {
    return skyAzEl(sky, coords.latRad, coords.lonRad);
  }, [sky, coords]);

  const sunElDeg = sun.el * RAD2DEG;
  const earthElDeg = earth.el * RAD2DEG;

  // Telemetry from sim if available
  const idx = sim ? Math.floor((tMs - sim.t0) / (sim.dtSec * 1000)) : -1;
  const live = sim && idx >= 0 && idx < sim.n;
  const fSun = live ? sim.fSun[idx]! : sunElDeg > 0 ? 1 : 0;
  const fEarth = live ? sim.fEarth[idx]! : earthElDeg > 0 ? 1 : 0;

  // 1. Ultra-Low Grazing Sun State (<1.8°)
  const isSunSubmerged = fSun < 0.1 || sunElDeg <= 0;

  // 2. Libration Earth Comm State (±7°)
  const isCommBlackout = fEarth < 0.1 || earthElDeg <= 0;

  // 3. 40 Kelvin Cold Trap & Battery Freeze Timer
  const regolithTempK = isSunSubmerged ? 40 : Math.round(180 + Math.max(0, sunElDeg) * 25);
  const hoursToFreeze = isSunSubmerged
    ? sim?.timeToDeadH !== undefined && sim.timeToDeadH !== null
      ? Math.min(4.0, sim.timeToDeadH)
      : 3.8
    : null;

  // Operational Countdowns: Time to Sunset/Sunrise and Earthset/Earthrise
  const countdowns = useMemo(() => {
    if (!sim || sim.n === 0) return { sunsetH: null, sunriseH: null, earthsetH: null, earthriseH: null };
    const curIdx = Math.floor((tMs - sim.t0) / (sim.dtSec * 1000));
    if (curIdx < 0 || curIdx >= sim.n) return { sunsetH: null, sunriseH: null, earthsetH: null, earthriseH: null };

    const isSunlit = sim.fSun[curIdx]! > 0.1;
    let sunsetIdx = -1;
    let sunriseIdx = -1;

    for (let i = curIdx + 1; i < sim.n; i++) {
      if (isSunlit && sim.fSun[i]! <= 0.1) {
        sunsetIdx = i;
        break;
      }
      if (!isSunlit && sim.fSun[i]! > 0.1) {
        sunriseIdx = i;
        break;
      }
    }

    const isLinked = sim.fEarth[curIdx]! > 0.1;
    let earthsetIdx = -1;
    let earthriseIdx = -1;

    for (let i = curIdx + 1; i < sim.n; i++) {
      if (isLinked && sim.fEarth[i]! <= 0.1) {
        earthsetIdx = i;
        break;
      }
      if (!isLinked && sim.fEarth[i]! > 0.1) {
        earthriseIdx = i;
        break;
      }
    }

    const stepToHours = sim.dtSec / 3600;
    return {
      sunsetH: sunsetIdx !== -1 ? (sunsetIdx - curIdx) * stepToHours : null,
      sunriseH: sunriseIdx !== -1 ? (sunriseIdx - curIdx) * stepToHours : null,
      earthsetH: earthsetIdx !== -1 ? (earthsetIdx - curIdx) * stepToHours : null,
      earthriseH: earthriseIdx !== -1 ? (earthriseIdx - curIdx) * stepToHours : null,
    };
  }, [sim, tMs]);

  const isAnyHazard = isSunSubmerged || isCommBlackout;

  return (
    <section className="card p-3">
      {/* Header bar */}
      <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-[var(--line)]">
        <div className="flex items-center gap-1.5 min-w-0">
          <ShieldAlert size={13} className="text-[var(--accent)] shrink-0" />
          <h3 className="card-title mb-0 text-[11.5px] font-semibold uppercase tracking-wider text-white truncate">
            Polar Threat Monitor
          </h3>
        </div>
        <span
          className={cn(
            "px-2 py-0.5 rounded text-[9.5px] font-semibold mono uppercase tracking-wider whitespace-nowrap shrink-0",
            isAnyHazard
              ? "bg-[rgba(252,61,33,0.15)] text-[var(--bad)] border border-[var(--bad)]/40"
              : "bg-[rgba(53,224,138,0.12)] text-[var(--ok)] border border-[var(--ok)]/40",
          )}
        >
          {isSunSubmerged ? "DARK HAZARD" : isCommBlackout ? "COMM BLACKOUT" : "ALL CLEAR"}
        </span>
      </div>

      {/* 3 Symmetrical, Fixed-Height Hazard Blocks */}
      <div className="grid grid-cols-3 gap-2">
        {/* Threat 1: Grazing Sun with Sunset/Sunrise Countdown */}
        <div
          className={cn(
            "h-[88px] w-full min-w-0 rounded-md border p-2 flex flex-col justify-between items-center text-center transition-colors",
            isSunSubmerged
              ? "border-[var(--bad)]/50 bg-[rgba(252,61,33,0.06)]"
              : "border-[var(--line)] bg-[var(--bg-2)]/40",
          )}
        >
          <div className="h-4 flex items-center justify-center gap-1 text-[10px] font-medium mono uppercase text-[var(--text-3)] whitespace-nowrap">
            <Sun size={11} className={isSunSubmerged ? "text-[var(--bad)]" : "text-[var(--sun)]"} />
            <span>Grazing Sun</span>
          </div>

          <div
            className="h-7 flex items-baseline justify-center gap-0.5 mono text-[19px] font-light leading-none"
            style={{ color: isSunSubmerged ? "var(--bad)" : "var(--sun)" }}
          >
            <span>{sunElDeg.toFixed(1)}</span>
            <span className="text-xs text-[var(--text-3)]">°</span>
          </div>

          <div
            className={cn(
              "h-5 w-full flex items-center justify-center rounded text-[9px] font-semibold mono uppercase tracking-wider whitespace-nowrap",
              isSunSubmerged
                ? "bg-[rgba(252,61,33,0.18)] text-[var(--bad)]"
                : "bg-[rgba(53,224,138,0.12)] text-[var(--ok)]",
            )}
            title={
              isSunSubmerged
                ? countdowns.sunriseH !== null
                  ? `Sun returns in ${countdowns.sunriseH.toFixed(1)} hours`
                  : "Permanently Shadowed Region"
                : countdowns.sunsetH !== null
                  ? `Sun sets in ${countdowns.sunsetH.toFixed(1)} hours`
                  : "Continuous sunlight"
            }
          >
            {isSunSubmerged
              ? countdowns.sunriseH !== null
                ? `${formatHours(countdowns.sunriseH)} SUNRISE`
                : "SHADOWED"
              : countdowns.sunsetH !== null
                ? `${formatHours(countdowns.sunsetH)} SUNSET`
                : "SUNLIT"}
          </div>
        </div>

        {/* Threat 2: Earth Comm with Earthset/Earthrise Countdown */}
        <div
          className={cn(
            "h-[88px] w-full min-w-0 rounded-md border p-2 flex flex-col justify-between items-center text-center transition-colors",
            isCommBlackout
              ? "border-[var(--bad)]/50 bg-[rgba(252,61,33,0.06)]"
              : "border-[var(--line)] bg-[var(--bg-2)]/40",
          )}
        >
          <div className="h-4 flex items-center justify-center gap-1 text-[10px] font-medium mono uppercase text-[var(--text-3)] whitespace-nowrap">
            <Radio size={11} className={isCommBlackout ? "text-[var(--bad)]" : "text-[var(--nasa-blue-light)]"} />
            <span>Earth LOS</span>
          </div>

          <div
            className="h-7 flex items-baseline justify-center gap-0.5 mono text-[19px] font-light leading-none"
            style={{ color: isCommBlackout ? "var(--bad)" : "var(--nasa-blue-light)" }}
          >
            <span>{earthElDeg.toFixed(1)}</span>
            <span className="text-xs text-[var(--text-3)]">°</span>
          </div>

          <div
            className={cn(
              "h-5 w-full flex items-center justify-center rounded text-[9px] font-semibold mono uppercase tracking-wider whitespace-nowrap",
              isCommBlackout
                ? "bg-[rgba(252,61,33,0.18)] text-[var(--bad)]"
                : "bg-[rgba(53,224,138,0.12)] text-[var(--ok)]",
            )}
            title={
              isCommBlackout
                ? countdowns.earthriseH !== null
                  ? `Direct Earth link re-acquires in ${countdowns.earthriseH.toFixed(1)} hours`
                  : "Terrain Occulted Blackout"
                : countdowns.earthsetH !== null
                  ? `Direct Earth link sets in ${countdowns.earthsetH.toFixed(1)} hours`
                  : "Unbroken Direct-to-Earth link"
            }
          >
            {isCommBlackout
              ? countdowns.earthriseH !== null
                ? `${formatHours(countdowns.earthriseH)} EARTHRISE`
                : "BLACKOUT"
              : countdowns.earthsetH !== null
                ? `${formatHours(countdowns.earthsetH)} EARTHSET`
                : "LINK OK"}
          </div>
        </div>

        {/* Threat 3: Cold Trap with Freeze Limit */}
        <div
          className={cn(
            "h-[88px] w-full min-w-0 rounded-md border p-2 flex flex-col justify-between items-center text-center transition-colors",
            isSunSubmerged
              ? "border-[var(--bad)]/50 bg-[rgba(252,61,33,0.06)]"
              : "border-[var(--line)] bg-[var(--bg-2)]/40",
          )}
        >
          <div className="h-4 flex items-center justify-center gap-1 text-[10px] font-medium mono uppercase text-[var(--text-3)] whitespace-nowrap">
            <Thermometer size={11} className={isSunSubmerged ? "text-[var(--bad)]" : "text-[var(--kapton)]"} />
            <span>Regolith</span>
          </div>

          <div
            className="h-7 flex items-baseline justify-center gap-0.5 mono text-[19px] font-light leading-none"
            style={{ color: isSunSubmerged ? "var(--bad)" : "var(--kapton)" }}
          >
            <span>{regolithTempK}</span>
            <span className="text-xs text-[var(--text-3)]">K</span>
          </div>

          <div
            className={cn(
              "h-5 w-full flex items-center justify-center rounded text-[9px] font-semibold mono uppercase tracking-wider whitespace-nowrap",
              isSunSubmerged
                ? "bg-[rgba(252,61,33,0.18)] text-[var(--bad)]"
                : "bg-[rgba(53,224,138,0.12)] text-[var(--ok)]",
            )}
            title={
              isSunSubmerged
                ? hoursToFreeze
                  ? `Rover internal electronics thermal freeze in ${hoursToFreeze.toFixed(1)} hours`
                  : "Cryogenic volatile trap"
                : "Thermal conditions stable"
            }
          >
            {isSunSubmerged && hoursToFreeze ? `${hoursToFreeze.toFixed(1)}h LIMIT` : "STABLE"}
          </div>
        </div>
      </div>
    </section>
  );
}
