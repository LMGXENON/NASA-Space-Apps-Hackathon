"use client";

/**
 * Mission orchestration (PRD Part B §10): wires stores → worker → SimResult.
 * Sim re-runs on profile/path/site changes (debounced 250 ms); the ribbon
 * re-runs on site change; the duty map on explicit request.
 */

import { useEffect, useRef } from "react";
import { roverApi } from "./roverClient";
import { useUiStore } from "../store/uiStore";
import { useTimeStore } from "../store/timeStore";
import { T0, T1 } from "../store/timeStore";
import type { Heightfield } from "./sceneMath";

export const SIM_WINDOW_SEC = 3 * 86400; // ±3 days around "now"

export function useMission() {
  const terrain = useUiStore((s) => s.terrain);
  const site = useUiStore((s) => s.roverSite);
  const path = useUiStore((s) => s.path);
  const profile = useUiStore((s) => s.profile);
  const booted = useRef(false);

  // Boot the worker once terrain is loaded
  useEffect(() => {
    if (!terrain || booted.current) return;
    booted.current = true;
    lastHorizon.current = terrain.horizon ?? null;
    roverApi
      .loadTerrain(terrain.hf as unknown as Heightfield, terrain.horizon!, terrain.nAz, terrain.horizonPx)
      .then(() => {
        // First sim if a rover already exists
        const s = useUiStore.getState();
        if (s.roverSite) triggerSim();
        triggerRibbon();
      })
      .catch((e) => console.error("worker boot failed", e));
  }, [terrain]);

  // FR-R7: when the horizon variant hot-swaps, re-sync the worker and re-run.
  const horizonBuf = terrain?.horizon;
  const lastHorizon = useRef<ArrayBuffer | null>(null);
  useEffect(() => {
    if (!terrain || !horizonBuf || !booted.current) return;
    if (lastHorizon.current === horizonBuf) return;
    lastHorizon.current = horizonBuf;
    roverApi
      .loadTerrain(terrain.hf as unknown as Heightfield, horizonBuf, terrain.nAz, terrain.horizonPx)
      .then(() => {
        triggerSim();
        triggerRibbon();
      })
      .catch((e) => console.error("horizon swap failed", e));
  }, [horizonBuf, terrain]);

  // Sim on rover/path/profile change (latest-wins debounce)
  const simTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!terrain || !site || !booted.current) return;
    if (simTimer.current) clearTimeout(simTimer.current);
    simTimer.current = setTimeout(triggerSim, 250);
  }, [terrain, site, path, profile]);

  // Ribbon on site change
  const ribTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!terrain || !site || !booted.current) return;
    if (ribTimer.current) clearTimeout(ribTimer.current);
    ribTimer.current = setTimeout(triggerRibbon, 400);
  }, [terrain, site]);
}

/**
 * Keep the ±3-day sim window centred on "now": when the timeline leaves the
 * window the simulation re-runs so charts and KPIs follow the scrubber.
 */
export function useSimWindowRefresh(): void {
  const tMs = useTimeStore((s) => s.tMs);
  const sim = useUiStore((s) => s.sim);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sim) return;
    const simT1 = sim.t0 + sim.n * sim.dtSec * 1000;
    const outside = tMs < sim.t0 - 3_600_000 || tMs > simT1 + 3_600_000;
    if (!outside) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(triggerSim, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [tMs, sim]);
}

export function triggerSim(): void {
  const s = useUiStore.getState();
  if (!s.roverSite) return;
  const tMs = useTimeStore.getState().tMs;
  roverApi
    .simulate({
      profile: s.profile,
      path: s.path,
      site: s.roverSite,
      departTMs: s.departTMs ?? tMs,
      t0: tMs - SIM_WINDOW_SEC * 1000 * 0.35,
      t1: tMs + SIM_WINDOW_SEC * 1000 * 0.65,
      dtSec: 60,
      e0Wh: s.profile.batteryWh * ((s.autonomyBatteryPct ?? 90) / 100),
    })
    .then((sim) => {
      // Drop stale results whose window no longer matches the current time
      const now = useTimeStore.getState().tMs;
      if (now < sim.t0 - 60_000 || now > sim.t1 + 60_000) return;
      useUiStore.getState().setSim(sim);
    })
    .catch((e) => console.error("simulate failed", e));
}

export function triggerRibbon(): void {
  const s = useUiStore.getState();
  if (!s.roverSite) return;
  roverApi
    .ribbon({ x: s.roverSite.x, y: s.roverSite.y, hObsM: s.profile.mastHeightM, t0: T0, t1: T1, dtSec: 600 })
    .then((r) => useUiStore.getState().setRibbon(r))
    .catch((e) => console.error("ribbon failed", e));
}

/** FR-B7: rank green spots reachable with the current battery state. */
export async function runAutoPlan(): Promise<
  { x: number; y: number; lat: number; lon: number; distM: number; driveH: number; energyWh: number; fSun: number; fEarth: number }[]
> {
  const s = useUiStore.getState();
  if (!s.roverSite) return [];
  // Current SOC from the latest sim (defaults to 90 % before one exists).
  let soc = 0.9;
  const sim = s.sim;
  if (sim) {
    const idx = Math.min(sim.n - 1, Math.max(0, Math.round((useTimeStore.getState().tMs - sim.t0) / (sim.dtSec * 1000))));
    soc = sim.soc[idx] ?? 0.9;
  }
  const { candidates } = (await roverApi.autoPlan({
    site: s.roverSite,
    t0: useTimeStore.getState().tMs,
    availableWh: s.profile.batteryWh * soc,
    reserveWh: s.profile.batteryWh * 0.15,
    speedMps: s.profile.speedMps,
    driveW: s.profile.loads.driveBaseW,
  })) as { candidates: { x: number; y: number; lat: number; lon: number; distM: number; driveH: number; energyWh: number; fSun: number; fEarth: number }[] };
  return candidates;
}

export function triggerDutyMap(gridN = 96, days = 14): void {
  const tMs = useTimeStore.getState().tMs;
  roverApi
    .dutyMap({ gridN, t0: tMs, t1: tMs + days * 86400 * 1000, dtSec: 1800 })
    .then((r: { w: number; data: Float32Array }) => {
      const s = useUiStore.getState();
      s.setDutyTexture(r);
      s.setDutyMode(true);
    })
    .catch((e) => console.error("dutyMap failed", e));
}
