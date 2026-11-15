"use client";

/**
 * Shareable URL state (PRD FR-D3): ?t=<epochMs>&lat=<deg>&lon=<deg>&profile=<mode,batt,area,eff>&heat=<0-3>
 * Legacy grid-coord links (?rx=…&ry=…) are still honoured. Only this module
 * reads window.location (PRD §C.4 rule 5).
 */

import { gridToLatLon, latLonToGrid, RAD2DEG, DEG2RAD } from "@helios/core";
import { useTimeStore } from "../store/timeStore";
import { useUiStore } from "../store/uiStore";

export function applyUrlState(): void {
  if (typeof window === "undefined") return;
  const q = new URLSearchParams(window.location.search);
  const t = q.get("t");
  if (t) {
    const v = Number(t);
    if (Number.isFinite(v)) useTimeStore.getState().set(v);
  }
  const lat = q.get("lat"), lon = q.get("lon");
  const rx = q.get("rx"), ry = q.get("ry");
  // FR-D3 round-trip fidelity: when both coordinate forms are present, the exact
  // grid metres (rx/ry) must win. buildShareUrl emits lat/lon rounded to 5
  // decimals for human readability, which is lossy near the pole — honouring
  // those instead drifted the rover off its site on every reload of a shared URL.
  if (rx && ry) {
    const x = Number(rx), y = Number(ry);
    if (Number.isFinite(x) && Number.isFinite(y)) useUiStore.getState().setRoverSite({ x, y });
  } else if (lat && lon) {
    const la = Number(lat), lo = Number(lon);
    if (Number.isFinite(la) && Number.isFinite(lo)) {
      const g = latLonToGrid(la * DEG2RAD, lo * DEG2RAD);
      useUiStore.getState().setRoverSite({ x: g.x, y: g.y });
    }
  }
  const prof = q.get("profile");
  if (prof) {
    const [mode, batt, area, eff] = prof.split(",");
    const s = useUiStore.getState();
    const p = { ...s.profile };
    if (mode === "horizontal" || mode === "vertical-fixed" || mode === "vertical-tracking") p.arrayMode = mode;
    if (Number.isFinite(Number(batt))) p.batteryWh = Math.min(20000, Math.max(2000, Number(batt)));
    if (Number.isFinite(Number(area))) p.arrayAreaM2 = Math.min(8, Math.max(0.5, Number(area)));
    if (Number.isFinite(Number(eff))) p.arrayEff = Math.min(0.4, Math.max(0.1, Number(eff)));
    s.setProfile(p);
  }
  const heat = q.get("heat");
  if (heat) {
    const v = Number(heat);
    if (v === 3) useUiStore.getState().setDutyMode(true);
    else if (v >= 0 && v <= 2) useUiStore.getState().setHeatMode(v);
  }
}

/** Canonical share URL for the current mission state. */
export function buildShareUrl(): string {
  const s = useUiStore.getState();
  const t = useTimeStore.getState().tMs;
  const q = new URLSearchParams({ t: String(t), heat: String(s.dutyMode ? 3 : s.heatMode) });
  if (s.roverSite) {
    const { latRad, lonRad } = gridToLatLon(s.roverSite.x, s.roverSite.y);
    q.set("lat", (latRad * RAD2DEG).toFixed(5));
    q.set("lon", (lonRad * RAD2DEG).toFixed(5));
    // Sub-metre precision so the round-trip is lossless. Integer metres (the old
    // form) drifted the rover up to ~0.7 m on every reload — more error than the
    // 5-decimal lat/lon it was meant to beat. The terrain texel is 39 m, so 2 dp
    // (5 mm) is far finer than anything the app can resolve.
    q.set("rx", s.roverSite.x.toFixed(2));
    q.set("ry", s.roverSite.y.toFixed(2));
  }
  q.set(
    "profile",
    [s.profile.arrayMode, s.profile.batteryWh, s.profile.arrayAreaM2, s.profile.arrayEff].join(","),
  );
  return `${location.origin}${location.pathname}?${q.toString()}`;
}

let lastWrite = 0;
/** Keep the address bar in sync (throttled) so the URL is always shareable. */
export function scheduleUrlWrite(): void {
  const now = Date.now();
  if (now - lastWrite < 1000) return;
  lastWrite = now;
  window.history.replaceState(null, "", buildShareUrl());
}
