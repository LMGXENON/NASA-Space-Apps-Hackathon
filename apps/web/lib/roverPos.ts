"use client";

/**
 * Shared rover position (FR-B4). The rover advances along its waypoint path as
 * mission time moves; the same `pathPositionAt` trajectory the worker simulates is
 * reused here so the 3D model, the minimap and the RECENTER button can never
 * disagree about where the rover is.
 */

import { gridToLatLon } from "@helios/core";
import { pathPositionAt } from "./sceneMath";
import { useUiStore } from "../store/uiStore";
import { useTimeStore } from "../store/timeStore";

export interface RoverPose {
  /** Polar-stereographic grid metres. */
  x: number;
  y: number;
  heading: number;
  moving: boolean;
}

/** Current rover pose, or `null` when no site has been placed. */
export function roverGridPos(): RoverPose | null {
  const s = useUiStore.getState();
  if (!s.roverSite) return null;
  const t = useTimeStore.getState();
  const depart = s.departTMs ?? t.tMs;

  // Hard Zero-Battery Interlock: If battery is <= 15% SOC, drive actuators lock and rover cannot move
  const batt = s.autonomyBatteryPct ?? 89.4;
  const isActuatorLocked = batt <= 15.0;

  if (isActuatorLocked) {
    return {
      x: s.roverSite.x,
      y: s.roverSite.y,
      heading: 0,
      moving: false,
    };
  }

  const p = pathPositionAt(s.roverSite, s.path, s.profile.speedMps, (t.tMs - depart) / 1000);

  return {
    x: p.x,
    y: p.y,
    heading: p.heading,
    moving: p.moving,
  };
}

/** Selenographic coordinates of the rover's current pose, or `null`. */
export function roverSelenographic(): { latRad: number; lonRad: number } | null {
  const p = roverGridPos();
  return p ? gridToLatLon(p.x, p.y) : null;
}

if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__ROVER_POS__ = roverGridPos;
}
