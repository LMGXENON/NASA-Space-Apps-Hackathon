"use client";

/**
 * Minimap (upgrade §3) — a 2D navigation overlay fixed to the bottom-right of the
 * viewport, drawn with a thin NASA Midnight-Blue border.
 *
 * It is mode-aware:
 *  - **local** — an LRO DEM hillshade of the 40 km AOI, with the waypoint path and
 *    a blinking rover marker. A click converts the 2D pixel to grid metres and
 *    flies the camera there.
 *  - **globe** — a true orthographic disc of the whole Moon. A click converts the
 *    2D pixel to selenographic **latitude/longitude** (via the inverse
 *    orthographic projection) and flies the 3D globe camera to that coordinate.
 *
 * The rover indicator blinks in NASA Red / Kapton Gold, and hover reports the
 * coordinate under the cursor.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { R_MOON, formatSelenographic, globeToLatLon, gridToLatLon, latLonToGlobe } from "@helios/core";
import { AOI_HALF, gridToScene, meshSurfaceHeight } from "../lib/sceneMath";
import { buildCraters, moonAlbedo, type Crater } from "../lib/moonSurface";
import { roverGridPos } from "../lib/roverPos";
import { useUiStore } from "../store/uiStore";

const SIZE = 208;

/** Orbit radius the camera keeps after a minimap click. */
const LOCAL_FLY_DISTANCE = 6500;
const GLOBE_FLY_DISTANCE = R_MOON * 0.55;

export default function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const terrain = useUiStore((s) => s.terrain);
  const viewMode = useUiStore((s) => s.viewMode);
  const path = useUiStore((s) => s.path);
  const roverSite = useUiStore((s) => s.roverSite);
  const cameraMode = useUiStore((s) => s.cameraMode);
  const [hover, setHover] = useState<string>("");

  // Deterministic crater field for the globe disc (built once).
  const craters = useMemo<Crater[]>(() => buildCraters(700), []);

  // ---- base layer: rebuild only when the terrain or the mode changes -------
  useEffect(() => {
    if (cameraMode === "mastcam") return;
    const base = document.createElement("canvas");
    base.width = SIZE;
    base.height = SIZE;
    const ctx = base.getContext("2d")!;

    if (viewMode === "globe") {
      drawMoonDisc(ctx, craters);
    } else if (terrain) {
      drawAoiHillshade(ctx, terrain.hf.heights, terrain.hf.px);
    } else {
      ctx.fillStyle = "#05070c";
      ctx.fillRect(0, 0, SIZE, SIZE);
    }
    baseRef.current = base;
  }, [viewMode, terrain, craters, cameraMode]);

  // ---- overlay layer: rover, path, crosshair (animated ~10 Hz) --------------
  useEffect(() => {
    if (cameraMode === "mastcam") return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 90) {
        last = t;
        paint();
      }
      raf = requestAnimationFrame(tick);
    };
    const paint = () => {
      const cv = canvasRef.current;
      const base = baseRef.current;
      if (!cv || !base) return;
      const ctx = cv.getContext("2d")!;
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.drawImage(base, 0, 0);

      // Blink toggles the rover indicator between NASA Red and Kapton Gold.
      const blink = Math.floor(performance.now() / 520) % 2 === 0;
      const rover = roverGridPos();
      const s = useUiStore.getState();

      if (viewMode === "local") {
        // Waypoint path.
        if (s.roverSite) {
          ctx.strokeStyle = "rgba(76,194,255,0.85)";
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          const pts = s.roverSite ? [s.roverSite, ...path] : path;
          pts.forEach((w, i) => {
            const [px, py] = gridToCanvas(w.x, w.y);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.stroke();
        }
        if (rover) {
          // A rover placed on the globe can sit far outside the AOI; pin the
          // indicator to the map edge so it stays visible instead of vanishing.
          const [rawX, rawY] = gridToCanvas(rover.x, rover.y);
          const px = Math.min(SIZE - 8, Math.max(8, rawX));
          const py = Math.min(SIZE - 8, Math.max(8, rawY));
          marker(ctx, px, py, blink);
        }
      } else {
        // Moon disc: rover indicator at its selenographic position.
        const ll = rover ? gridToLatLon(rover.x, rover.y) : null;
        if (ll) {
          const v = latLonToGlobe(ll.latRad, ll.lonRad, 1);
          // South-polar azimuthal view: visible hemisphere y < 0, screen right =
          // +Z (lon 90°E), screen up = +X (lon 0). Matches discPixelToLatLon.
          const [mx, my] = discToCanvas(v.x, v.y, v.z);
          if (v.y < 0) marker(ctx, mx, my, blink);
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewMode, path, roverSite, cameraMode]);

  if (cameraMode === "mastcam") return null;

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { px, py, inside } = eventToPixel(e);
    if (!inside) {
      setHover("");
      return;
    }
    if (viewMode === "globe") {
      const ll = discPixelToLatLon(px, py);
      if (ll) setHover(formatSelenographic(ll.latRad, ll.lonRad, 2));
    } else {
      const { x, y } = canvasToGrid(px, py);
      const { latRad, lonRad } = gridToLatLon(x, y);
      setHover(formatSelenographic(latRad, lonRad, 2));
    }
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { px, py, inside } = eventToPixel(e);
    if (!inside) return;
    const s = useUiStore.getState();
    if (viewMode === "globe") {
      const ll = discPixelToLatLon(px, py);
      if (!ll) return;
      const p = latLonToGlobe(ll.latRad, ll.lonRad);
      s.requestFocus([p.x, p.y, p.z], GLOBE_FLY_DISTANCE);
      s.setCoords({ latRad: ll.latRad, lonRad: ll.lonRad });
    } else {
      if (!terrain) return;
      const { x, y } = canvasToGrid(px, py);
      const h = meshSurfaceHeight(terrain.hf, x, y);
      const [sx, , sz] = gridToScene(x, y);
      const sy = (h - terrain.meta.height.min) * s.exaggeration + 400;
      s.requestFocus([sx, sy, sz], LOCAL_FLY_DISTANCE);
      s.setCoords(gridToLatLon(x, y));
    }
  };

  return (
    <div
      className="pointer-events-auto absolute bottom-3 right-3 select-none overflow-hidden rounded border border-[var(--nasa-blue)] bg-black shadow-2xl"
      style={{
        width: `min(40vw, ${SIZE}px)`,
      }}
    >
      <div
        className="flex items-center justify-between px-2 py-1 bg-[var(--nasa-blue)] text-white"
      >
        <span className="hud-label whitespace-nowrap">Navigation</span>
        <span
          className="hud-label whitespace-nowrap opacity-75"
          title={
            viewMode === "globe"
              ? "South polar azimuthal · 1:1 scale"
              : "Terrain AOI · 40 km, north up"
          }
        >
          {viewMode === "globe" ? "S.POLE" : "AOI"}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        onMouseMove={onMove}
        onMouseLeave={() => setHover("")}
        onClick={onClick}
        className="block w-full cursor-crosshair"
        aria-label={viewMode === "globe" ? "Moon navigation map" : "Terrain navigation map"}
      />
      <div className="flex items-center justify-between px-2 py-1 border-t border-[var(--line)]">
        <span className="mono text-[10px] text-[var(--text-3)]">
          {hover || "\u00a0"}
        </span>
        <span className="dot bg-[var(--bad)]" style={{ animation: "hud-blink 1.04s steps(1) infinite" }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ helpers
function marker(ctx: CanvasRenderingContext2D, px: number, py: number, blink: boolean) {
  const c = blink ? "#FC3D21" : "#D4AF37";
  ctx.strokeStyle = c;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.arc(px, py, 2.4, 0, Math.PI * 2);
  ctx.fill();
  // crosshair ticks
  ctx.beginPath();
  ctx.moveTo(px - 10, py); ctx.lineTo(px - 7, py);
  ctx.moveTo(px + 7, py); ctx.lineTo(px + 10, py);
  ctx.moveTo(px, py - 10); ctx.lineTo(px, py - 7);
  ctx.moveTo(px, py + 7); ctx.lineTo(px, py + 10);
  ctx.stroke();
}

function eventToPixel(e: React.MouseEvent<HTMLCanvasElement>): { px: number; py: number; inside: boolean } {
  const r = e.currentTarget.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * SIZE;
  const py = ((e.clientY - r.top) / r.height) * SIZE;
  return { px, py, inside: px >= 0 && py >= 0 && px < SIZE && py < SIZE };
}

/** Grid metres → canvas pixel (north up). */
function gridToCanvas(x: number, y: number): [number, number] {
  const u = (x + AOI_HALF) / (2 * AOI_HALF);
  const v = (y + AOI_HALF) / (2 * AOI_HALF);
  return [u * SIZE, (1 - v) * SIZE];
}

/** Canvas pixel → grid metres. */
function canvasToGrid(px: number, py: number): { x: number; y: number } {
  const u = px / SIZE;
  const v = 1 - py / SIZE;
  return { x: u * 2 * AOI_HALF - AOI_HALF, y: v * 2 * AOI_HALF - AOI_HALF };
}

/** Unit vectors → canvas pixel for the south-polar azimuthal disc. */
function discToCanvas(x: number, y: number, z: number): [number, number] {
  const s = SIZE / 2 - 6;
  return [SIZE / 2 + z * s, SIZE / 2 - x * s];
}

/**
 * Inverse projection of the south-polar azimuthal disc: pixel → selenographic
 * coordinate.
 *
 * The map looks down the Moon's rotation axis from the south (visible hemisphere
 * y < 0), with the lon-0 meridian up and lon-90°E to the right — the projection
 * LRO and the Artemis III site studies use for this region. Because the AOI is
 * the south pole itself, a conventional equatorial view put the rover off the
 * visible limb; here the pole sits exactly at the disc centre.
 */
function discPixelToLatLon(px: number, py: number): { latRad: number; lonRad: number } | null {
  const s = SIZE / 2 - 6;
  const sx = (px - SIZE / 2) / s; // → +Z (lon 90°E)
  const sy = (SIZE / 2 - py) / s; // → +X (lon 0)
  const r2 = sx * sx + sy * sy;
  if (r2 > 1) return null;
  const { latRad, lonRad } = globeToLatLon({ x: sy, y: -Math.sqrt(1 - r2), z: sx });
  return { latRad, lonRad };
}

/** DEM hillshade of the AOI (LRO elevation data), shaded from the upper-left. */
function drawAoiHillshade(ctx: CanvasRenderingContext2D, heights: Float32Array, px: number): void {
  const img = ctx.createImageData(SIZE, SIZE);
  const scale = 0.55; // gradient normalisation (DEM texel ≈ 39 m)
  for (let py = 0; py < SIZE; py++) {
    // Canvas is north-up; DEM row 0 is the south edge of the AOI.
    const iy = Math.min(px - 1, Math.max(0, Math.round((1 - py / (SIZE - 1)) * (px - 1))));
    for (let pxi = 0; pxi < SIZE; pxi++) {
      const ix = Math.min(px - 1, Math.max(0, Math.round((pxi / (SIZE - 1)) * (px - 1))));
      const iL = iy * px + Math.max(0, ix - 1);
      const iR = iy * px + Math.min(px - 1, ix + 1);
      const iU = Math.min(px - 1, iy + 1) * px + ix;
      const iD = Math.max(0, iy - 1) * px + ix;
      const dx = (heights[iR]! - heights[iL]!) * scale;
      const dy = (heights[iU]! - heights[iD]!) * scale;
      // Light from the upper-left, z up.
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const lam = Math.max(0.08, (-dx - dy + 1) * inv * 0.62);
      const v = Math.round(255 * Math.min(1, lam));
      const o = 4 * (py * SIZE + pxi);
      img.data[o] = Math.round(v * 0.92);
      img.data[o + 1] = Math.round(v * 0.95);
      img.data[o + 2] = Math.round(Math.min(255, v * 1.05));
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Orthographic disc of the whole Moon (procedural selenographic surface). */
function drawMoonDisc(ctx: CanvasRenderingContext2D, craters: Crater[]): void {
  const s = SIZE / 2 - 6;
  const img = ctx.createImageData(SIZE, SIZE);
  for (let py = 0; py < SIZE; py++) {
    const sy = (SIZE / 2 - py) / s; // → +X (lon 0)
    for (let pxx = 0; pxx < SIZE; pxx++) {
      const sx = (pxx - SIZE / 2) / s; // → +Z (lon 90°E)
      const r2 = sx * sx + sy * sy;
      const o = 4 * (py * SIZE + pxx);
      if (r2 > 1) {
        img.data[o] = 2; img.data[o + 1] = 3; img.data[o + 2] = 6; img.data[o + 3] = 255;
        continue;
      }
      // Southern hemisphere: y < 0, so the south pole lands at the centre.
      const y = -Math.sqrt(1 - r2);
      const lat = Math.asin(Math.max(-1, Math.min(1, y)));
      const lon = Math.atan2(sx, sy);
      const { g } = moonAlbedo(lat, lon, craters, false);
      // Lambert shading from the screen upper-left, so the disc reads as a sphere.
      const lam = Math.max(0.1, 0.55 * sy - 0.5 * sx - 0.7 * y);
      const v = Math.round(255 * Math.min(1, g * lam * 1.25));
      img.data[o] = Math.round(v * 0.99);
      img.data[o + 1] = Math.round(v * 0.97);
      img.data[o + 2] = Math.round(v * 0.94);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Polar graticule: concentric latitude rings + radial meridians every 30°.
  ctx.strokeStyle = "rgba(11,61,145,0.9)";
  ctx.lineWidth = 0.6;
  for (const latDeg of [-30, -60, -80]) {
    const r = Math.cos((latDeg * Math.PI) / 180) * s;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let lonDeg = 0; lonDeg < 360; lonDeg += 30) {
    const lo = (lonDeg * Math.PI) / 180;
    // Screen direction of a meridian: (sin λ → right, cos λ → up).
    const dx = Math.sin(lo) * s;
    const dy = -Math.cos(lo) * s;
    ctx.beginPath();
    ctx.moveTo(SIZE / 2, SIZE / 2);
    ctx.lineTo(SIZE / 2 + dx, SIZE / 2 + dy);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(224,224,224,0.6)";
  ctx.font = "8px ui-monospace, monospace";
  ctx.fillText("0°", SIZE / 2 - 5, 10);
  ctx.fillText("S", SIZE / 2 - 3, SIZE - 4);
}
