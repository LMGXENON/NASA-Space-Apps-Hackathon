"use client";

/**
 * Left column: NASA Flight Console Mission Control.
 *
 * Organized into three tactical console operations tabs:
 * 1. SURFACE OPS — Rover landing site, coordinates, Artemis III landing presets,
 *    waypoint route tools, and First-Person MastCam view toggle.
 * 2. LAYERS & SHADERS — Photometric lunar regolith, tri-class illumination,
 *    sun-fraction gradient, 14-day duty cycle, slope hazard trafficability map,
 *    topographic contour lines, PSR volatiles cold trap, and observer height.
 * 3. SORTIE PLANNER — Generative Artemis III & VIPER traverse planner, corridor
 *    cross-section profiles, energy intake, and CSV plan export.
 */

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  Camera,
  Crosshair,
  Download,
  Layers,
  MapPin,
  Route,
  X,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useTimeStore } from "../store/timeStore";
import { useUiStore } from "../store/uiStore";
import { triggerDutyMap } from "../lib/useMission";
import { buildShareUrl } from "../lib/urlState";
import { encodeGeoTIFFLite, flipRowsVertical, gridToLatLon, latLonToGrid, RAD2DEG } from "@helios/core";
import { meshSurfaceHeight } from "../lib/sceneMath";
import SortiePlanner from "./SortiePlanner";
import { Card } from "./ChartKit";
import { playQuindarTone, playTelemetryPing } from "../lib/audioService";

export interface LandingSitePreset {
  name: string;
  targetProgram: "Artemis III" | "CLPS IM-2" | "CLPS VIPER" | "Microgrid PEL";
  lat: number;
  lon: number;
  sunlightPct: number;
  earthCommPct: number;
  slopeGrade: "Safe (<10°)" | "Moderate (12°)" | "Steep (16°)";
  desc: string;
}

const PRESETS: LandingSitePreset[] = [
  {
    name: "Connecting Ridge",
    targetProgram: "Artemis III",
    lat: -89.5,
    lon: 45.0,
    sunlightPct: 86,
    earthCommPct: 91,
    slopeGrade: "Safe (<10°)",
    desc: "Prime human landing zone & volatile drill corridor (15 km from pole)",
  },
  {
    name: "Peak of Eternal Light (PEL 1)",
    targetProgram: "Microgrid PEL",
    lat: -89.74,
    lon: 125.4,
    sunlightPct: 94,
    earthCommPct: 82,
    slopeGrade: "Safe (<10°)",
    desc: "94% annual solar illumination; prime static solar tower site",
  },
  {
    name: "Nobile Crater Rim",
    targetProgram: "CLPS VIPER",
    lat: -89.42,
    lon: 105.0,
    sunlightPct: 78,
    earthCommPct: 89,
    slopeGrade: "Safe (<10°)",
    desc: "Targeted rover prospecting corridor for sub-surface water ice",
  },
  {
    name: "Shackleton Connecting Ridge",
    targetProgram: "CLPS IM-2",
    lat: -89.58,
    lon: 52.0,
    sunlightPct: 84,
    earthCommPct: 90,
    slopeGrade: "Safe (<10°)",
    desc: "Commercial lander target for sub-surface ice drill payload",
  },
  {
    name: "Shackleton Rim Alpha",
    targetProgram: "Artemis III",
    lat: -89.65,
    lon: 120.0,
    sunlightPct: 88,
    earthCommPct: 85,
    slopeGrade: "Moderate (12°)",
    desc: "High elevation vantage overlooking permanently shadowed floor",
  },
  {
    name: "Haworth Crater Rim",
    targetProgram: "Artemis III",
    lat: -89.35,
    lon: -5.0,
    sunlightPct: 72,
    earthCommPct: 96,
    slopeGrade: "Moderate (12°)",
    desc: "High elevation rim with direct Earth line-of-sight anchor",
  },
  {
    name: "Shackleton Ingress PSR",
    targetProgram: "CLPS VIPER",
    lat: -89.82,
    lon: 110.0,
    sunlightPct: 12,
    earthCommPct: 38,
    slopeGrade: "Steep (16°)",
    desc: "Cryogenic water-ice cold trap entry (40 Kelvin floor)",
  },
  {
    name: "True Lunar South Pole",
    targetProgram: "Artemis III",
    lat: -89.98,
    lon: 0.0,
    sunlightPct: 81,
    earthCommPct: 88,
    slopeGrade: "Safe (<10°)",
    desc: "Selenographic 90°S South Pole axis point",
  },
];

const pct = (v: number, min: number, max: number) => ((v - min) / (max - min)) * 100;

const SHADER_MODES = [
  { id: 0, duty: false, label: "Photometric Regolith", badge: "Apollo Hapke", desc: "Realistic lunar surface photometric scattering" },
  { id: 1, duty: false, label: "Tri-Class Illumination", badge: "NASA Spec", desc: "Green sunlit crests, yellow comm, red shadow traps" },
  { id: 2, duty: false, label: "Solar Disc Fraction", badge: "Sub-pixel", desc: "Horizon-clipped solar limb visibility gradient" },
  { id: 4, duty: false, label: "Slope Trafficability", badge: "Safe <10°", desc: "Green accessible terrain, red >20° hazard rims" },
  { id: 5, duty: false, label: "Topographic Contours", badge: "50m Isolines", desc: "LOLA altimetry elevation contour lines" },
  { id: 6, duty: false, label: "PSR Cold Traps", badge: "-233°C (40K)", desc: "Cryogenic volatile water ice accumulation zones" },
  { id: 3, duty: true, label: "14-Day Duty Cycle", badge: "Survival Map", desc: "Integrated multi-day sun and Earth line-of-sight" },
];

function Field({ label, value, children }: { label: string; value?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between text-[11.5px] font-medium text-[var(--text-2)]">
        {label}
        {value ? (
          <span className="mono text-[11.5px] font-bold text-[var(--text)]">
            {value}
          </span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

export default function MissionCtrl() {
  const activeLeftTab = useUiStore((s) => s.activeLeftTab);
  const setActiveLeftTab = useUiStore((s) => s.setActiveLeftTab);
  const cameraMode = useUiStore((s) => s.cameraMode);
  const setCameraMode = useUiStore((s) => s.setCameraMode);

  const roverSite = useUiStore((s) => s.roverSite);
  const setRoverSite = useUiStore((s) => s.setRoverSite);
  const pickMode = useUiStore((s) => s.pickMode);
  const setPickMode = useUiStore((s) => s.setPickMode);
  const setPath = useUiStore((s) => s.setPath);
  const profile = useUiStore((s) => s.profile);
  const setProfile = useUiStore((s) => s.setProfile);
  const heatMode = useUiStore((s) => s.heatMode);
  const setHeatMode = useUiStore((s) => s.setHeatMode);
  const dutyMode = useUiStore((s) => s.dutyMode);
  const setDutyMode = useUiStore((s) => s.setDutyMode);
  const exaggeration = useUiStore((s) => s.exaggeration);
  const setExaggeration = useUiStore((s) => s.setExaggeration);
  const horizonObs = useUiStore((s) => s.horizonObs);
  const setHorizonObs = useUiStore((s) => s.setHorizonObs);
  const dutyTexture = useUiStore((s) => s.dutyTexture);
  const showSunRay = useUiStore((s) => s.showSunRay);
  const showEarthRay = useUiStore((s) => s.showEarthRay);
  const toggleRay = useUiStore((s) => s.toggleRay);
  const terrain = useUiStore((s) => s.terrain);
  const setTourActive = useUiStore((s) => s.setTourActive);
  const setInfoOpen = useUiStore((s) => s.setInfoOpen);
  const requestFocus = useUiStore((s) => s.requestFocus);
  const setToast = useUiStore((s) => s.setToast);

  const [dutyBusy, setDutyBusy] = useState(false);
  const [dutyDays, setDutyDays] = useState(14);
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [showSpecs, setShowSpecs] = useState(false);
  const [viewModePresets, setViewModePresets] = useState<"list" | "matrix">("list");

  useEffect(() => {
    if (roverSite && terrain) {
      const { latRad, lonRad } = gridToLatLon(roverSite.x, roverSite.y);
      setLat((latRad * RAD2DEG).toFixed(3));
      setLon((lonRad * RAD2DEG).toFixed(3));
    }
  }, [roverSite, terrain]);

  const commitCoords = () => {
    const nLat = parseFloat(lat);
    const nLon = parseFloat(lon);
    if (!isNaN(nLat) && !isNaN(nLon)) {
      const clampedLat = Math.max(-90, Math.min(-89.34, nLat));
      const latRad = clampedLat * (Math.PI / 180);
      const lonRad = nLon * (Math.PI / 180);
      const g = latLonToGrid(latRad, lonRad);
      const cx = Math.max(-19500, Math.min(19500, g.x));
      const cy = Math.max(-19500, Math.min(19500, g.y));
      setRoverSite({ x: cx, y: cy });
      requestFocus([cx, 800, -cy], 4500);
    }
  };

  const flyTo = (p: { name?: string; lat: number; lon: number }) => {
    const latRad = p.lat * (Math.PI / 180);
    const lonRad = p.lon * (Math.PI / 180);
    const g = latLonToGrid(latRad, lonRad);
    const cx = Math.max(-19500, Math.min(19500, g.x));
    const cy = Math.max(-19500, Math.min(19500, g.y));
    setRoverSite({ x: cx, y: cy });

    playQuindarTone("intro");
    const t = useUiStore.getState().terrain;
    const ex = useUiStore.getState().exaggeration;
    let targetY = 800;
    if (t) {
      const h = meshSurfaceHeight(t.hf, cx, cy);
      targetY = (h - t.meta.height.min) * ex + 280;
    }
    requestFocus([cx, targetY, -cy], 4500);
    setToast(`Deployed to ${p.name ?? "Artemis Site"}`);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Console Section Navigation Tabs */}
      <div className="tab-nav">
        <button
          className={cn("tab-nav-btn flex-1", activeLeftTab === "nav" && "tab-nav-btn-active")}
          onClick={() => {
            setActiveLeftTab("nav");
            playTelemetryPing();
          }}
        >
          <Crosshair size={13} />
          <span>Surface Ops</span>
        </button>

        <button
          className={cn("tab-nav-btn flex-1", activeLeftTab === "layers" && "tab-nav-btn-active")}
          onClick={() => {
            setActiveLeftTab("layers");
            playTelemetryPing();
          }}
        >
          <Layers size={13} />
          <span>Shaders</span>
        </button>

        <button
          className={cn("tab-nav-btn flex-1", activeLeftTab === "sortie" && "tab-nav-btn-active")}
          onClick={() => {
            setActiveLeftTab("sortie");
            playTelemetryPing();
          }}
        >
          <Route size={13} className="text-[var(--accent-strong)]" />
          <span>Sortie</span>
        </button>
      </div>

      {/* ===================== TAB 1: SURFACE OPS ===================== */}
      {activeLeftTab === "nav" && (
        <>
          {/* Rover Placement & Coordinates */}
          <Card
            title="Surface Asset Deployment"
            action={
              roverSite ? (
                <button
                  className="btn btn-ghost btn-icon h-7 w-7 text-xs"
                  title="Remove rover and waypoints"
                  aria-label="Remove rover"
                  onClick={() => {
                    setRoverSite(null);
                    setPath([]);
                  }}
                >
                  <X size={13} aria-hidden />
                </button>
              ) : null
            }
          >
            <div className="flex gap-2">
              <button
                className={cn("btn flex-1 text-[12px] font-medium", pickMode === "rover" && "btn-on")}
                onClick={() => setPickMode(pickMode === "rover" ? null : "rover")}
              >
                <Crosshair size={14} aria-hidden />
                {pickMode === "rover" ? "Click terrain…" : "Place Rover"}
              </button>
              <button
                className={cn("btn flex-1 text-[12px] font-medium", pickMode === "path" && "btn-on")}
                disabled={!roverSite}
                onClick={() => setPickMode(pickMode === "path" ? null : "path")}
              >
                <MapPin size={14} aria-hidden />
                {pickMode === "path" ? "Click to add…" : "Add Waypoint"}
              </button>
            </div>

            {/* Camera View Mode: Orbit vs MastCam */}
            {roverSite && (
              <div className="mt-3 pt-3 border-t border-[var(--line)]">
                <button
                  className={cn(
                    "btn w-full flex items-center justify-center gap-2 text-[12px]",
                    cameraMode === "mastcam" ? "btn-primary" : "btn-ghost border border-[var(--line)]",
                  )}
                  onClick={() => {
                    setCameraMode(cameraMode === "mastcam" ? "orbit" : "mastcam");
                    playQuindarTone("intro");
                  }}
                >
                  <Camera size={14} />
                  <span>{cameraMode === "mastcam" ? "Active: Rover MastCam [O]" : "Switch to Rover MastCam"}</span>
                </button>
              </div>
            )}

            {roverSite ? (
              <div className="mt-3">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Latitude">
                    <input
                      className="input text-xs"
                      value={lat}
                      onChange={(e) => setLat(e.target.value)}
                      onBlur={commitCoords}
                      onKeyDown={(e) => e.key === "Enter" && commitCoords()}
                      aria-label="Rover latitude"
                    />
                  </Field>
                  <Field label="Longitude">
                    <input
                      className="input text-xs"
                      value={lon}
                      onChange={(e) => setLon(e.target.value)}
                      onBlur={commitCoords}
                      onKeyDown={(e) => e.key === "Enter" && commitCoords()}
                      aria-label="Rover longitude"
                    />
                  </Field>
                </div>
                <div className="mt-2.5 flex items-center justify-between text-[11px] text-[var(--text-4)]">
                  <span>Polar Stereographic</span>
                  <span className="mono text-[11.5px] text-[var(--text-2)]">
                    {Math.round(roverSite.x)}, {Math.round(roverSite.y)} m
                  </span>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-[12px] leading-relaxed text-[var(--text-3)]">
                Click “Place Rover” or choose an Artemis III candidate landing site below to deploy onto the lunar surface.
              </p>
            )}
          </Card>

          {/* Candidate Landing Sites & Mission Targets (Artemis III & CLPS) */}
          <Card
            title="Candidate Landing Sites"
            action={
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setViewModePresets(viewModePresets === "list" ? "matrix" : "list")}
                  className="btn btn-ghost !h-6 px-2 text-[10px] font-semibold border border-[var(--line)]"
                  title="Toggle Side-by-Side Trade-Off Comparison Matrix"
                >
                  {viewModePresets === "list" ? "Trade-Off Matrix" : "List View"}
                </button>
                <span className="badge badge-accent">8 SITES</span>
              </div>
            }
          >
            {viewModePresets === "matrix" ? (
              /* Side-by-Side Trade-Off Comparison Table (Prompt Requirement) */
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11px] border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--line)] text-[10px] text-[var(--text-3)] mono uppercase">
                      <th className="pb-1.5 font-medium">Site &amp; Mission</th>
                      <th className="pb-1.5 font-medium text-center">Sunlight</th>
                      <th className="pb-1.5 font-medium text-center">Earth DTE</th>
                      <th className="pb-1.5 font-medium text-right">Slope</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]/40">
                    {PRESETS.map((p) => {
                      const g = latLonToGrid(p.lat * (Math.PI / 180), p.lon * (Math.PI / 180));
                      const isActive = roverSite && Math.hypot(roverSite.x - g.x, roverSite.y - g.y) < 800;
                      return (
                        <tr
                          key={p.name}
                          onClick={() => flyTo(p)}
                          className={cn(
                            "cursor-pointer transition-colors hover:bg-[var(--bg-3)]",
                            isActive && "bg-[var(--accent-soft)]/50",
                          )}
                          title={`${p.name} (${p.desc}) - Click to deploy`}
                        >
                          <td className="py-2 pr-1.5">
                            <div className="font-medium text-white flex items-center gap-1.5">
                              <span className={cn("dot shrink-0", isActive ? "bg-[var(--accent)]" : "bg-white/30")} />
                              <span className="truncate max-w-[110px]">{p.name}</span>
                            </div>
                            <span className="text-[9px] text-[var(--text-4)] mono block">{p.targetProgram}</span>
                          </td>
                          <td className="py-2 px-1 text-center mono">
                            <span className={p.sunlightPct >= 80 ? "text-[var(--sun)] font-semibold" : "text-[var(--bad)] font-semibold"}>
                              {p.sunlightPct}%
                            </span>
                          </td>
                          <td className="py-2 px-1 text-center mono">
                            <span className={p.earthCommPct >= 85 ? "text-[var(--accent-strong)] font-semibold" : "text-[var(--bad)] font-semibold"}>
                              {p.earthCommPct}%
                            </span>
                          </td>
                          <td className="py-2 pl-1 text-right">
                            <span
                              className={cn(
                                "inline-block px-1 py-0.5 rounded text-[9px] font-semibold mono",
                                p.slopeGrade.includes("Safe")
                                  ? "text-[var(--ok)] bg-[var(--ok)]/10"
                                  : p.slopeGrade.includes("Moderate")
                                    ? "text-[var(--warn)] bg-[var(--warn)]/10"
                                    : "text-[var(--bad)] bg-[var(--bad)]/10",
                              )}
                            >
                              {p.slopeGrade.split(" ")[0]}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              /* Curated List View */
              <div className="flex flex-col gap-2">
                {PRESETS.map((p) => {
                  const g = latLonToGrid(p.lat * (Math.PI / 180), p.lon * (Math.PI / 180));
                  const isActive = roverSite && Math.hypot(roverSite.x - g.x, roverSite.y - g.y) < 800;
                  return (
                    <div
                      key={p.name}
                      onClick={() => flyTo(p)}
                      className={cn(
                        "group cursor-pointer rounded-lg border p-2.5 transition-all",
                        isActive
                          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                          : "border-[var(--line)] bg-[rgba(255,255,255,0.02)] hover:border-[var(--line-strong)] hover:bg-[rgba(255,255,255,0.04)]",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={cn(
                              "dot shrink-0",
                              isActive ? "bg-[var(--accent)]" : "bg-white/30 group-hover:bg-white/60",
                            )}
                          />
                          <span className="font-medium text-[12.5px] text-[var(--text)] truncate">{p.name}</span>
                          <span className="text-[9.5px] px-1 rounded bg-[rgba(255,255,255,0.06)] text-[var(--text-3)] mono shrink-0">
                            {p.targetProgram}
                          </span>
                        </div>
                        <span className="mono shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-[rgba(255,255,255,0.04)] text-[var(--text-3)]">
                          {Math.abs(p.lat).toFixed(2)}°S, {p.lon.toFixed(1)}°E
                        </span>
                      </div>

                      <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--text-3)]">
                        <span className="truncate pr-2">{p.desc}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="mono text-[10px] text-[var(--sun)]" title="14-Day Sunlight Availability">
                            {p.sunlightPct}% Sun
                          </span>
                          <span className="mono text-[10px] text-[var(--accent-strong)]" title="14-Day Direct-to-Earth Coverage">
                            {p.earthCommPct}% Earth
                          </span>
                          <span
                            className={cn(
                              "mono text-[10.5px] font-bold shrink-0",
                              isActive ? "text-[var(--accent)]" : "text-white/40 group-hover:text-white",
                            )}
                          >
                            {isActive ? "DEPLOYED" : "FLY TO ▸"}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Rover Hardware Specs (Collapsible Accordion for Cleanliness) */}
          <div className="card !p-0 overflow-hidden">
            <button
              onClick={() => setShowSpecs(!showSpecs)}
              className="w-full flex items-center justify-between p-3.5 text-left text-[12px] font-medium text-[var(--text)] hover:bg-[rgba(255,255,255,0.03)] transition-colors"
            >
              <span className="flex items-center gap-2">
                <span>Rover Hardware Profile</span>
                <span className="text-[10.5px] text-[var(--text-4)]">(VIPER / Artemis Class)</span>
              </span>
              <span className="mono text-[11px] text-[var(--text-3)]">{showSpecs ? "▲ Collapse" : "▼ Expand"}</span>
            </button>

            {showSpecs && (
              <div className="p-3.5 pt-1 border-t border-[var(--line)] flex flex-col gap-3">
                <Field label="Array geometry">
                  <select
                    className="select text-xs"
                    value={profile.arrayMode}
                    onChange={(e) =>
                      setProfile({
                        ...profile,
                        arrayMode: e.target.value as "horizontal" | "vertical-fixed" | "vertical-tracking",
                      })
                    }
                  >
                    <option value="horizontal">Horizontal deck (low sun)</option>
                    <option value="vertical-fixed">Vertical, fixed tilt</option>
                    <option value="vertical-tracking">Vertical, tracking mast</option>
                  </select>
                </Field>

                <Field label="Battery capacity" value={`${profile.batteryWh} Wh`}>
                  <input
                    type="range"
                    min={2000}
                    max={20000}
                    step={500}
                    value={profile.batteryWh}
                    onChange={(e) => setProfile({ ...profile, batteryWh: Number(e.target.value) })}
                    style={{ "--pct": pct(profile.batteryWh, 2000, 20000) } as CSSProperties}
                    aria-label="Battery capacity"
                  />
                </Field>

                <Field label="Array area" value={`${profile.arrayAreaM2.toFixed(1)} m²`}>
                  <input
                    type="range"
                    min={0.5}
                    max={8}
                    step={0.1}
                    value={profile.arrayAreaM2}
                    onChange={(e) => setProfile({ ...profile, arrayAreaM2: Number(e.target.value) })}
                    style={{ "--pct": pct(profile.arrayAreaM2, 0.5, 8) } as CSSProperties}
                    aria-label="Solar array area"
                  />
                </Field>

                <Field label="Cell efficiency" value={`${Math.round(profile.arrayEff * 100)} %`}>
                  <input
                    type="range"
                    min={10}
                    max={40}
                    step={1}
                    value={Math.round(profile.arrayEff * 100)}
                    onChange={(e) => setProfile({ ...profile, arrayEff: Number(e.target.value) / 100 })}
                    style={{ "--pct": pct(profile.arrayEff * 100, 10, 40) } as CSSProperties}
                    aria-label="Cell efficiency"
                  />
                </Field>
              </div>
            )}
          </div>
        </>
      )}

      {/* ===================== TAB 2: LAYERS & SHADERS ===================== */}
      {activeLeftTab === "layers" && (
        <>
          <Card title="Terrain Visual Shading">
            <p className="text-[11.5px] text-[var(--text-3)] mb-3 leading-relaxed">
              Select a specialized surface shader to visualize lighting, trafficability hazards, and volatile deposits.
            </p>

            <div className="flex flex-col gap-2">
              {SHADER_MODES.map((item) => {
                const isActive = item.duty ? dutyMode : !dutyMode && heatMode === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      if (item.duty) setDutyMode(true);
                      else {
                        setDutyMode(false);
                        setHeatMode(item.id);
                      }
                      playTelemetryPing();
                    }}
                    className={cn(
                      "flex items-center justify-between p-3 rounded-lg border text-left transition-all",
                      isActive
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-white"
                        : "border-[var(--line)] bg-[rgba(255,255,255,0.02)] text-[var(--text-2)] hover:border-[var(--line-strong)] hover:bg-[rgba(255,255,255,0.04)]",
                    )}
                  >
                    <div>
                      <div className="text-[12.5px] font-semibold text-white">{item.label}</div>
                      <div className="text-[11px] text-[var(--text-3)] mt-0.5">{item.desc}</div>
                    </div>
                    <span
                      className={cn(
                        "mono text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 border",
                        isActive
                          ? "bg-[var(--accent)] text-white border-transparent"
                          : "border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--text-3)]",
                      )}
                    >
                      {item.badge}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Solar & Earth Raycaster Toggles */}
            <div className="mt-4 pt-3.5 border-t border-[var(--line)] flex flex-col gap-3">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <span className="text-[12px] font-medium text-white block">
                    Solar Vector Ray Beam
                  </span>
                  <span className="text-[10.5px] text-[var(--text-3)]">Projected light path from Sun to rover</span>
                </div>
                <input type="checkbox" className="switch" checked={showSunRay} onChange={() => toggleRay("sun")} />
              </label>

              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <span className="text-[12px] font-medium text-white block">
                    Earth DTE Line-of-Sight
                  </span>
                  <span className="text-[10.5px] text-[var(--text-3)]">Direct-to-Earth communication vector</span>
                </div>
                <input type="checkbox" className="switch" checked={showEarthRay} onChange={() => toggleRay("earth")} />
              </label>
            </div>

            {/* Vertical Relief Exaggeration */}
            <div className="mt-4 pt-3.5 border-t border-[var(--line)]">
              <Field label="Vertical Relief Exaggeration" value={`${exaggeration.toFixed(1)}×`}>
                <input
                  type="range"
                  min={1}
                  max={5}
                  step={0.1}
                  value={exaggeration}
                  onChange={(e) => setExaggeration(Number(e.target.value))}
                  style={{ "--pct": pct(exaggeration, 1, 5) } as CSSProperties}
                  aria-label="Vertical relief exaggeration"
                />
              </Field>
            </div>

            {/* Observer Horizon Mast Height */}
            <div className="mt-3.5">
              <Field label="Observer Horizon Mast Height (FR-R7)">
                <div className="grid grid-cols-3 gap-2 mt-1">
                  {[
                    { h: 0, label: "0 m (Ground)" },
                    { h: 2, label: "2 m (Mast)" },
                    { h: 10, label: "10 m (Tower)" },
                  ].map((obs) => (
                    <button
                      key={obs.h}
                      onClick={() => setHorizonObs(obs.h)}
                      className={cn(
                        "py-1.5 px-2 rounded-lg text-[11px] font-medium border text-center transition-all",
                        horizonObs === obs.h
                          ? "border-[var(--accent)] bg-[var(--accent-soft)] text-white font-semibold"
                          : "border-[var(--line)] bg-[rgba(255,255,255,0.03)] text-[var(--text-3)] hover:text-white hover:border-[var(--line-strong)]",
                      )}
                    >
                      {obs.label}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </Card>

          {/* 14-day Duty Map Engine */}
          <Card title="Duty Cycle Accumulation Engine">
            <p className="text-[11.5px] leading-relaxed text-[var(--text-3)]">
              Renders multi-day cumulative solar and Earth visibility percentages for every texel across the 40 km AOI.
            </p>

            <div className="mt-3 flex gap-2">
              <div className="grid grid-cols-4 gap-1 flex-1">
                {[1, 7, 14, 29.5].map((d) => (
                  <button
                    key={d}
                    onClick={() => setDutyDays(d)}
                    className={cn(
                      "py-1.5 rounded-lg text-[11px] font-medium border text-center transition-all",
                      dutyDays === d
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-white font-semibold"
                        : "border-[var(--line)] bg-[rgba(255,255,255,0.03)] text-[var(--text-3)] hover:text-white hover:border-[var(--line-strong)]",
                    )}
                  >
                    {d === 1 ? "24h" : `${d}d`}
                  </button>
                ))}
              </div>
              <button
                className="btn btn-primary px-3 text-[11px] font-semibold"
                disabled={dutyBusy || !terrain}
                onClick={() => {
                  setDutyBusy(true);
                  setTimeout(() => {
                    triggerDutyMap(96, dutyDays);
                    setDutyBusy(false);
                    playQuindarTone("outro");
                  }, 50);
                }}
              >
                {dutyBusy ? "Computing…" : "Compute Map"}
              </button>
            </div>

            <button
              className="btn btn-ghost mt-3 w-full text-[11px] py-2 flex items-center justify-center gap-2 border border-[var(--line)] hover:border-[var(--line-strong)]"
              disabled={!dutyTexture}
              onClick={() => exportHeatmap(dutyTexture!, terrain?.meta.crs)}
              title="Download computed duty map as GeoTIFF, PNG and CSV"
            >
              <Download size={13} aria-hidden />
              <span>Export GeoTIFF / CSV / PNG</span>
            </button>
          </Card>
        </>
      )}

      {/* ===================== TAB 3: SORTIE PLANNER ===================== */}
      {activeLeftTab === "sortie" && <SortiePlanner />}

      {/* Quick Action Navigation Footer */}
      <div className="flex gap-2 pt-1">
        <button
          className="btn btn-ghost flex-1 text-[11px] py-2 border border-[var(--line)] hover:border-[var(--line-strong)]"
          onClick={() => setTourActive(true)}
        >
          ▶ Guided Tour
        </button>
        <button
          className="btn btn-ghost flex-1 text-[11px] py-2 border border-[var(--line)] hover:border-[var(--line-strong)]"
          onClick={() => setInfoOpen(true)}
        >
          NASA Data
        </button>
        <button
          className="btn btn-ghost flex-1 text-[11px] py-2 border border-[var(--line)] hover:border-[var(--line-strong)]"
          onClick={shareState}
        >
          Share Link
        </button>
      </div>
    </div>
  );
}

function exportHeatmap(duty: { w: number; data: Float32Array }, crs?: string): void {
  const w = duty.w;
  const step = 40_000 / w;
  const day = new Date(useTimeStore.getState().tMs).toISOString().slice(0, 10);

  const rows: string[] = ["x_m,y_m,pct_green,pct_sun,pct_earth"];
  for (let iy = 0; iy < w; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const x = -20_000 + (ix + 0.5) * step;
      const y = -20_000 + (iy + 0.5) * step;
      const i = iy * w + ix;
      rows.push(
        `${x.toFixed(0)},${y.toFixed(0)},${(duty.data[3 * i]! * 100).toFixed(1)},${(duty.data[3 * i + 1]! * 100).toFixed(1)},${(duty.data[3 * i + 2]! * 100).toFixed(1)}`,
      );
    }
  }
  downloadBlob(new Blob([rows.join("\n")], { type: "text/csv" }), `helios-duty-map-${day}.csv`);

  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = w;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(w, w);
  for (let i = 0; i < w * w; i++) {
    const g = duty.data[3 * i]!;
    const s = duty.data[3 * i + 1]!;
    img.data[4 * i] = Math.round(255 * (0.1 + 0.5 * s));
    img.data[4 * i + 1] = Math.round(255 * Math.min(1, 0.15 + 0.95 * g));
    img.data[4 * i + 2] = Math.round(255 * 0.12);
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  cv.toBlob((blob) => {
    if (blob) downloadBlob(blob, `helios-duty-map-${day}.png`);
  }, "image/png");

  const tif = encodeGeoTIFFLite({
    width: w,
    height: w,
    data: flipRowsVertical(duty.data, w, w, 3),
    bands: 3,
    originX: -20_000,
    originY: 20_000,
    pixelScaleX: step,
    pixelScaleY: step,
    citation: crs ?? "+proj=stere +lat_0=-90 +lon_0=0 +k=1 +R=1737400 +units=m",
  });
  downloadBlob(new Blob([tif], { type: "image/tiff" }), `helios-duty-map-${day}.tif`);
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function shareState(): void {
  const url = buildShareUrl();
  navigator.clipboard?.writeText(url).then(
    () => alert("Shareable URL copied:\n" + url),
    () => window.prompt("Copy this URL:", url),
  );
}
