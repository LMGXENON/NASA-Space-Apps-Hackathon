"use client";

/**
 * Viewport HUD: clean mission controls for celestial tracking,
 * rover recentering, MastCam toggle, and live selenographic coordinate readout.
 */

import { Camera, Crosshair, Globe2, Sun, Target } from "lucide-react";
import { formatSelenographic, gridToLatLon, skyAzEl, skyState } from "@helios/core";
import { gridToScene, meshSurfaceHeight } from "../lib/sceneMath";
import { roverGridPos } from "../lib/roverPos";
import { useTimeStore } from "../store/timeStore";
import { useUiStore } from "../store/uiStore";

/** Eye distance kept after recentring */
const LOCAL_RECENTER_DISTANCE = 4200;

/** Fly to the rover wherever it currently is along its path. */
function recenterOnRover(): void {
  const s = useUiStore.getState();
  const rover = roverGridPos();
  if (!rover) {
    s.setToast("Place a rover before recentring");
    return;
  }
  const { latRad, lonRad } = gridToLatLon(rover.x, rover.y);
  const t = s.terrain;
  if (!t) return;
  const h = meshSurfaceHeight(t.hf, rover.x, rover.y);
  const [sx, , sz] = gridToScene(rover.x, rover.y);
  s.requestFocus([sx, (h - t.meta.height.min) * s.exaggeration + 300, sz], LOCAL_RECENTER_DISTANCE);
  s.setCoords({ latRad, lonRad });
}

/** Point the camera at Earth in the lunar sky */
function lookAtEarth(): void {
  const s = useUiStore.getState();
  const sky = skyState(new Date(useTimeStore.getState().tMs));
  const rover = roverGridPos();
  const { latRad, lonRad } = rover ? gridToLatLon(rover.x, rover.y) : gridToLatLon(0, 0);
  const { earth } = skyAzEl(sky, latRad, lonRad);
  const ex = Math.cos(earth.el) * Math.sin(earth.az);
  const ey = Math.sin(earth.el);
  const ez = -Math.cos(earth.el) * Math.cos(earth.az);
  const dist = 32_000;
  s.requestFocus([ex * dist, ey * dist + 1400, ez * dist], 26_000);
  s.setToast(
    `Tracking Earth · Az ${(earth.az * (180 / Math.PI)).toFixed(1)}° · El ${(earth.el * (180 / Math.PI)).toFixed(1)}°`,
  );
}

/** Point the camera at the Sun on the horizon */
function lookAtSun(): void {
  const s = useUiStore.getState();
  const sky = skyState(new Date(useTimeStore.getState().tMs));
  const rover = roverGridPos();
  const { latRad, lonRad } = rover ? gridToLatLon(rover.x, rover.y) : gridToLatLon(0, 0);
  const { sun } = skyAzEl(sky, latRad, lonRad);
  const sx = Math.cos(sun.el) * Math.sin(sun.az);
  const sy = Math.sin(sun.el);
  const sz = -Math.cos(sun.el) * Math.cos(sun.az);
  const dist = 32_000;
  s.requestFocus([sx * dist, sy * dist + 1400, sz * dist], 26_000);
  const elDeg = (sun.el * (180 / Math.PI)).toFixed(1);
  s.setToast(
    `Tracking Sun · Az ${(sun.az * (180 / Math.PI)).toFixed(1)}° · El ${elDeg}° ${sun.el < 0 ? "(Below horizon)" : "(Visible)"}`,
  );
}

export default function HudControls() {
  const coords = useUiStore((s) => s.coords);
  const roverSite = useUiStore((s) => s.roverSite);
  const cameraMode = useUiStore((s) => s.cameraMode);
  const setCameraMode = useUiStore((s) => s.setCameraMode);

  if (cameraMode === "mastcam") return null;

  const readout = coords ? formatSelenographic(coords.latRad, coords.lonRad, 3) : "NO FIX";

  return (
    <>
      {/* ------------------------------------------------ command cluster */}
      <div className="pointer-events-auto absolute left-3 top-3 flex flex-col gap-2">
        <div
          className="hud-frame flex items-center gap-1 p-1"
          role="group"
          aria-label="Celestial tracking"
        >
          <button
            className="hud-tab flex-1"
            onClick={lookAtEarth}
            title="Point camera toward Earth"
          >
            <Globe2 size={12} aria-hidden className="text-[var(--neon-blue)]" />
            EARTH
          </button>
          <button
            className="hud-tab flex-1"
            onClick={lookAtSun}
            title="Point camera toward the Sun"
          >
            <Sun size={12} aria-hidden className="text-[var(--kapton)]" />
            SUN
          </button>
        </div>

        {roverSite && (
          <button
            className="hud-command"
            onClick={recenterOnRover}
            title="Fly the camera back to the rover's live coordinates"
          >
            <Target size={14} aria-hidden />
            RECENTER ROVER
          </button>
        )}

        {roverSite && (
          <button
            className="hud-command"
            onClick={() => setCameraMode("mastcam")}
            title="Toggle First-Person Rover Mast Camera View"
          >
            <Camera size={14} aria-hidden />
            4M MAST CAM
          </button>
        )}
      </div>

      {/* ------------------------------------------- coordinate readout */}
      <div className="pointer-events-none absolute right-3 top-3 w-48">
        <div className="hud-frame px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="hud-label">Selenographic fix</span>
            <span
              className={`dot ${coords ? "bg-[var(--ok)]" : "bg-[var(--bad)]"}`}
              style={{
                animation: coords ? undefined : "hud-blink 1.04s steps(1) infinite",
              }}
            />
          </div>
          <div className="mono mt-1 text-[13px] font-bold tracking-tight text-[var(--kapton)]">
            {readout}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <Crosshair size={11} aria-hidden className="text-[var(--neon-blue)]" />
            <span className="mono text-[10px] text-[var(--text-3)]">
              LRO LOLA DEM · 40 km AOI
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
