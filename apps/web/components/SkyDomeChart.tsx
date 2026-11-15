"use client";

/**
 * SkyDomeChart — Topocentric Horizon Polar Sky Dome (PRD Part A §6.1 / Addendum).
 *
 * Mission-critical topocentric polar projection:
 * - 0° (North) at top, 90° (East) right, 180° (South) bottom, 270° (West) left.
 * - Center is the local Zenith (+90° elevation); outer perimeter is the Astronomical Horizon (0°).
 * - Drapes the authentic 360° terrain horizon obstruction silhouette (from LOLA baked horizon map).
 * - Traces the Sun's grazing diurnal path across the polar sky.
 * - Traces Earth's libration figure-8 loop and DTE link clearance.
 * - Interactive polar cursor with azimuth/elevation readout and terrain obstruction testing.
 */

import { useMemo, useState } from "react";
import { RAD2DEG, DEG2RAD, gridToLatLon, skyState, skyAzEl } from "@helios/core";
import { horizonAngleBin } from "../lib/sceneMath";
import { useTimeStore } from "../store/timeStore";
import { useUiStore } from "../store/uiStore";

const SVG_SIZE = 300;
const CENTER = SVG_SIZE / 2;
const RADIUS = 120; // 0° elevation radius

// Polar mapping: Azimuth (0=North, 90=East) & Elevation (0° at edge, 90° at center)
function azElToXY(azRad: number, elDeg: number): [number, number] {
  // Normalize elevation: clamp between -5° and 90°
  const clampedEl = Math.max(-5, Math.min(90, elDeg));
  const r = RADIUS * (1 - clampedEl / 90);
  // azRad is clockwise from North (+Y in math coords is up)
  const x = CENTER + r * Math.sin(azRad);
  const y = CENTER - r * Math.cos(azRad);
  return [x, y];
}

export default function SkyDomeChart() {
  const tMs = useTimeStore((s) => s.tMs);
  const terrain = useUiStore((s) => s.terrain);
  const site = useUiStore((s) => s.roverSite);
  const [hoverInfo, setHoverInfo] = useState<{ az: number; el: number; horizonEl: number; blocked: boolean } | null>(null);

  const sky = skyState(new Date(tMs));
  const { latRad, lonRad } = site ? gridToLatLon(site.x, site.y) : gridToLatLon(0, 0);
  const { sun, earth } = skyAzEl(sky, latRad, lonRad);

  const sunAzDeg = ((sun.az * RAD2DEG + 360) % 360);
  const sunElDeg = sun.el * RAD2DEG;
  const earthAzDeg = ((earth.az * RAD2DEG + 360) % 360);
  const earthElDeg = earth.el * RAD2DEG;

  // 1. Generate 360° Terrain Horizon Silhouette Polygon
  const horizonPoints = useMemo(() => {
    if (!terrain || !terrain.horizon) return [];
    const pts: { azRad: number; azDeg: number; elDeg: number; x: number; y: number }[] = [];
    const n = 64;
    const px = site ? site.x : 0;
    const py = site ? site.y : 0;
    for (let i = 0; i <= n; i++) {
      const azRad = (i / n) * Math.PI * 2;
      const elRad = horizonAngleBin(
        terrain.horizon,
        terrain.horizonPx,
        terrain.nAz,
        px,
        py,
        azRad,
        terrain.hf.bounds,
      );
      const elDeg = elRad * RAD2DEG;
      const [x, y] = azElToXY(azRad, elDeg);
      pts.push({ azRad, azDeg: azRad * RAD2DEG, elDeg, x, y });
    }
    return pts;
  }, [terrain, site]);

  // Construct SVG polygon path for terrain mask (from horizon to outer ring)
  const terrainPath = useMemo(() => {
    if (horizonPoints.length === 0) return "";
    let d = `M ${horizonPoints[0]!.x} ${horizonPoints[0]!.y}`;
    for (let i = 1; i < horizonPoints.length; i++) {
      d += ` L ${horizonPoints[i]!.x} ${horizonPoints[i]!.y}`;
    }
    // Loop back along outer boundary (0° elevation) in reverse
    for (let i = horizonPoints.length - 1; i >= 0; i--) {
      const [ox, oy] = azElToXY(horizonPoints[i]!.azRad, 0);
      d += ` L ${ox} ${oy}`;
    }
    d += " Z";
    return d;
  }, [horizonPoints]);

  // 2. Multi-day Solar Track (7 days past + 7 days future)
  const sunPathD = useMemo(() => {
    const pts: [number, number][] = [];
    const stepHours = 4;
    const count = 42; // ~7 days
    const baseDate = new Date(tMs);
    for (let i = -count / 2; i <= count / 2; i++) {
      const sampleDate = new Date(baseDate.getTime() + i * stepHours * 3600 * 1000);
      const sampleSky = skyState(sampleDate);
      const sAzEl = skyAzEl(sampleSky, latRad, lonRad);
      const [x, y] = azElToXY(sAzEl.sun.az, sAzEl.sun.el * RAD2DEG);
      pts.push([x, y]);
    }
    return pts.map(([x, y], idx) => (idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`)).join(" ");
  }, [tMs, latRad, lonRad]);

  // 3. Earth Libration Track (28 days)
  const earthPathD = useMemo(() => {
    const pts: [number, number][] = [];
    const stepHours = 12;
    const count = 56; // 28 days lunar synodic cycle
    const baseDate = new Date(tMs);
    for (let i = -count / 2; i <= count / 2; i++) {
      const sampleDate = new Date(baseDate.getTime() + i * stepHours * 3600 * 1000);
      const sampleSky = skyState(sampleDate);
      const eAzEl = skyAzEl(sampleSky, latRad, lonRad);
      const [x, y] = azElToXY(eAzEl.earth.az, eAzEl.earth.el * RAD2DEG);
      pts.push([x, y]);
    }
    return pts.map(([x, y], idx) => (idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`)).join(" ");
  }, [tMs, latRad, lonRad]);

  // Current body positions
  const [sunX, sunY] = azElToXY(sun.az, sunElDeg);
  const [earthX, earthY] = azElToXY(earth.az, earthElDeg);

  // Clearance check for bodies
  const sunHorizonEl = terrain && terrain.horizon ? horizonAngleBin(terrain.horizon, terrain.horizonPx, terrain.nAz, site?.x ?? 0, site?.y ?? 0, sun.az, terrain.hf.bounds) * RAD2DEG : 0;
  const earthHorizonEl = terrain && terrain.horizon ? horizonAngleBin(terrain.horizon, terrain.horizonPx, terrain.nAz, site?.x ?? 0, site?.y ?? 0, earth.az, terrain.hf.bounds) * RAD2DEG : 0;
  const sunBlocked = sunElDeg < sunHorizonEl - 0.1;
  const earthBlocked = earthElDeg < earthHorizonEl - 0.1;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left - CENTER;
    const my = e.clientY - rect.top - CENTER;
    const r = Math.hypot(mx, my);
    if (r > RADIUS + 15) {
      setHoverInfo(null);
      return;
    }
    const azRad = (Math.atan2(mx, -my) + Math.PI * 2) % (Math.PI * 2);
    const elDeg = 90 * (1 - r / RADIUS);
    const horizonElRad = terrain && terrain.horizon ? horizonAngleBin(terrain.horizon, terrain.horizonPx, terrain.nAz, site?.x ?? 0, site?.y ?? 0, azRad, terrain.hf.bounds) : 0;
    const horizonEl = horizonElRad * RAD2DEG;
    setHoverInfo({
      az: azRad * RAD2DEG,
      el: elDeg,
      horizonEl,
      blocked: elDeg < horizonEl,
    });
  };

  return (
    <div className="card p-3">
      <div className="flex items-center justify-between border-b pb-2" style={{ borderColor: "var(--line)" }}>
        <div className="flex items-center gap-2">
          <span className="dot" style={{ background: "var(--accent)" }} />
          <span className="text-[12px] font-semibold tracking-wider uppercase" style={{ color: "var(--text)" }}>
            Topocentric Sky Dome
          </span>
        </div>
        <span className="mono text-[11px]" style={{ color: "var(--text-3)" }}>
          {site ? "ROVER SITE" : "SOUTH POLE"}
        </span>
      </div>

      <div className="relative mt-2 flex flex-col items-center">
        <svg
          width={SVG_SIZE}
          height={SVG_SIZE}
          viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
          className="cursor-crosshair select-none"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverInfo(null)}
        >
          {/* Background Sky Dome */}
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="#020817" stroke="rgba(111,147,216,0.25)" strokeWidth={1} />

          {/* Elevation Rings */}
          {[10, 20, 30, 60].map((el) => {
            const r = RADIUS * (1 - el / 90);
            return (
              <g key={el}>
                <circle cx={CENTER} cy={CENTER} r={r} fill="none" stroke="rgba(111,147,216,0.14)" strokeDasharray="3 3" />
                <text x={CENTER + 3} y={CENTER - r + 9} fill="rgba(111,147,216,0.5)" fontSize="9" className="mono select-none">
                  {el}°
                </text>
              </g>
            );
          })}

          {/* Azimuth Spokes */}
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
            const rad = deg * DEG2RAD;
            const x2 = CENTER + RADIUS * Math.sin(rad);
            const y2 = CENTER - RADIUS * Math.cos(rad);
            return <line key={deg} x1={CENTER} y1={CENTER} x2={x2} y2={y2} stroke="rgba(111,147,216,0.12)" strokeWidth={1} />;
          })}

          {/* Compass Cardinal Labels */}
          <text x={CENTER} y={CENTER - RADIUS - 6} fill="#ffffff" fontSize="10.5" fontWeight="bold" textAnchor="middle" className="mono">
            N
          </text>
          <text x={CENTER + RADIUS + 10} y={CENTER + 3.5} fill="var(--text-3)" fontSize="10" textAnchor="middle" className="mono">
            E
          </text>
          <text x={CENTER} y={CENTER + RADIUS + 14} fill="var(--text-3)" fontSize="10" textAnchor="middle" className="mono">
            S
          </text>
          <text x={CENTER - RADIUS - 10} y={CENTER + 3.5} fill="var(--text-3)" fontSize="10" textAnchor="middle" className="mono">
            W
          </text>

          {/* Terrain Horizon Obstruction Mask */}
          {terrainPath && (
            <path
              d={terrainPath}
              fill="rgba(252, 61, 33, 0.22)"
              stroke="var(--accent)"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          )}

          {/* Sun Diurnal Trajectory Arc */}
          {sunPathD && (
            <path d={sunPathD} fill="none" stroke="rgba(255, 224, 102, 0.45)" strokeWidth={1.5} strokeDasharray="4 2" />
          )}

          {/* Earth Libration Loop */}
          {earthPathD && (
            <path d={earthPathD} fill="none" stroke="rgba(46, 230, 255, 0.35)" strokeWidth={1.5} strokeDasharray="3 3" />
          )}

          {/* Sun Marker */}
          <g transform={`translate(${sunX}, ${sunY})`}>
            <circle r={sunBlocked ? 6 : 8} fill={sunBlocked ? "var(--bad)" : "var(--kapton)"} opacity={0.9} />
            <circle r={11} fill="none" stroke={sunBlocked ? "var(--bad)" : "var(--kapton)"} strokeWidth={1} opacity={0.5} />
            <text x={12} y={3} fill={sunBlocked ? "var(--bad)" : "var(--kapton)"} fontSize="9.5" fontWeight="bold" className="mono">
              SUN {sunElDeg.toFixed(1)}°
            </text>
          </g>

          {/* Earth Marker */}
          <g transform={`translate(${earthX}, ${earthY})`}>
            <circle r={earthBlocked ? 5.5 : 7} fill={earthBlocked ? "var(--bad)" : "var(--neon-blue)"} opacity={0.9} />
            <circle r={10} fill="none" stroke={earthBlocked ? "var(--bad)" : "var(--neon-blue)"} strokeWidth={1} opacity={0.5} />
            <text x={12} y={3} fill={earthBlocked ? "var(--bad)" : "var(--neon-blue)"} fontSize="9.5" fontWeight="bold" className="mono">
              EARTH {earthElDeg.toFixed(1)}°
            </text>
          </g>

          {/* Center Zenith crosshair */}
          <circle cx={CENTER} cy={CENTER} r={2.5} fill="var(--nasa-blue-light)" />
        </svg>

        {/* Live Status Readout */}
        <div className="mt-2 grid w-full grid-cols-2 gap-2 text-[11px]">
          <div className="rounded border border-[var(--line)] bg-[var(--bg-3)] px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[var(--sun)]">
                <span className="inline-block h-2 w-2 rounded-full bg-[var(--sun)]" />
                Solar LoS
              </span>
              <span className={`mono font-semibold ${sunBlocked ? "text-[var(--bad)]" : "text-[var(--ok)]"}`}>
                {sunBlocked ? "OCCLUDED" : "NOMINAL"}
              </span>
            </div>
            <div className="mono text-[10px] text-[var(--text-3)]">
              Az {sunAzDeg.toFixed(1)}° · El {sunElDeg.toFixed(2)}° (H: {sunHorizonEl.toFixed(2)}°)
            </div>
          </div>

          <div className="rounded border border-[var(--line)] bg-[var(--bg-3)] px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[var(--neon-blue)]">
                <span className="inline-block h-2 w-2 rounded-full bg-[var(--neon-blue)]" />
                Earth DTE
              </span>
              <span className={`mono font-semibold ${earthBlocked ? "text-[var(--bad)]" : "text-[var(--ok)]"}`}>
                {earthBlocked ? "TERRAIN MASKED" : "LINK CLEAR"}
              </span>
            </div>
            <div className="mono text-[10px] text-[var(--text-3)]">
              Az {earthAzDeg.toFixed(1)}° · El {earthElDeg.toFixed(2)}° (H: {earthHorizonEl.toFixed(2)}°)
            </div>
          </div>
        </div>

        {/* Interactive Hover Probe readout */}
        {hoverInfo ? (
          <div
            className={`mt-2 w-full rounded px-2.5 py-1.5 text-center text-[10.5px] mono border border-[var(--line)] ${hoverInfo.blocked ? "bg-[rgba(252,61,33,0.12)] text-[var(--bad)]" : "bg-[rgba(53,224,138,0.10)] text-[var(--ok)]"}`}
          >
            Az {hoverInfo.az.toFixed(1)}° · Target El {hoverInfo.el.toFixed(1)}° · Terrain Crest {hoverInfo.horizonEl.toFixed(1)}°
            <span className="ml-2 font-bold">
              [{hoverInfo.blocked ? "TERRAIN OCCLUSION" : "FREE SPACE LINE OF SIGHT"}]
            </span>
          </div>
        ) : (
          <div className="mt-2 text-center text-[10px] text-[var(--text-4)]">
            Hover over the sky dome to test terrain line-of-sight at any azimuth/elevation.
          </div>
        )}
      </div>
    </div>
  );
}
